import type pg from "pg";
import { runInTransaction, type Db } from "../connection.js";
import {
  CLAIM_IDEMPOTENCY_KEY,
  LOCK_RESERVATION_FOR_CANCEL,
  MARK_RESERVATION_CANCELLED,
  RELEASE_RESERVATION_SEATS,
  RELEASE_USER_QUOTA,
  RESERVE_SEATS,
  SELECT_ORIGINAL_RESERVATION_BY_KEY,
  SELECT_SEAT_STATES,
  TAKE_USER_QUOTA,
} from "../queries/reservations.js";

/** A row of the `reservations` table (the columns the service reads). */
export interface ReservationRow {
  id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: "confirmed" | "cancelled";
}

/** A reservation together with the hash of the request that created it, used to detect a reused idempotency key. */
export interface ReplayRow extends ReservationRow {
  request_hash: string;
}

/** A seat row read to explain why a reserve was declined. */
export interface SeatRow {
  label: string;
  status: string;
  reservation_id: string | null;
}

/** Data for a new reservation. */
export interface NewReservation {
  id: string;
  showId: string;
  userId: string;
  seats: string[];
  amountPaise: number;
  idempotencyKey: string;
}

/** Result of trying to win every requested seat. Nothing is changed unless `created` is true. */
export interface ReserveOutcome {
  created: boolean;
  /** Labels that were available and locked by this attempt (all requested labels when `created`). */
  won: string[];
}

/**
 * The database operations available inside one reservation transaction. Each method is one SQL statement;
 * the service decides the order, and the lock order (idempotency row, quota row, seats sorted) is its responsibility.
 * @param db - The transaction's connection.
 */
export class ReservationTx {
  constructor(private readonly db: Db) {}

  /**
   * Claims the `(user, key)` idempotency row. The primary key makes a concurrent request with the same key wait for the first to finish.
   * @returns True if this request claimed the key, false if it was already used.
   */
  async claimIdempotencyKey(userId: string, key: string, showId: string, requestHash: string): Promise<boolean> {
    const result = await this.db.query({ ...CLAIM_IDEMPOTENCY_KEY, values: [userId, key, showId, requestHash] });
    return result.rowCount === 1;
  }

  /**
   * Finds the reservation behind an already-used key.
   * @returns The reservation and the hash of the request that created it, or undefined.
   */
  async findOriginalReservation(userId: string, key: string): Promise<ReplayRow | undefined> {
    const { rows } = await this.db.query<ReplayRow>({ ...SELECT_ORIGINAL_RESERVATION_BY_KEY, values: [userId, key] });
    return rows[0];
  }

  /**
   * Creates the `(show, user)` quota row or adds to it, in one conditional statement that also locks the row.
   * @returns True if the quota was taken, false if it would exceed the limit.
   */
  async takeQuota(showId: string, userId: string, count: number, limit: number): Promise<boolean> {
    const result = await this.db.query({ ...TAKE_USER_QUOTA, values: [showId, userId, count, limit] });
    return result.rowCount === 1;
  }

  /** Gives seats back to the user's quota. */
  async releaseQuota(showId: string, userId: string, count: number): Promise<void> {
    await this.db.query({ ...RELEASE_USER_QUOTA, values: [showId, userId, count] });
  }

  /**
   * The decision point: locks the available requested seats in a fixed byte order and, only if every seat was won, confirms them,
   * creates the reservation and attaches it to the idempotency key.
   * @param reservation - The reservation to create; `seats` must be sorted and de-duplicated.
   */
  async reserveSeats(reservation: NewReservation): Promise<ReserveOutcome> {
    const { rows } = await this.db.query<{ created: number; won: string[] }>({
      ...RESERVE_SEATS,
      values: [
        reservation.showId,
        reservation.seats,
        reservation.id,
        reservation.userId,
        reservation.amountPaise,
        reservation.idempotencyKey,
      ],
    });
    return { created: rows[0]!.created === 1, won: rows[0]!.won };
  }

  /**
   * Reads seats without locking them, to explain a declined reserve.
   * @returns The rows that exist; fewer than requested means some labels are unknown.
   */
  async readSeats(showId: string, labels: string[]): Promise<SeatRow[]> {
    const { rows } = await this.db.query<SeatRow>({ ...SELECT_SEAT_STATES, values: [showId, labels] });
    return rows;
  }

  /** Loads and locks a reservation for cancelling. */
  async lockReservation(reservationId: string): Promise<ReservationRow | undefined> {
    const { rows } = await this.db.query<ReservationRow>({ ...LOCK_RESERVATION_FOR_CANCEL, values: [reservationId] });
    return rows[0];
  }

  /**
   * Locks the seats that still point at a reservation and returns them to available, clearing their owner.
   * @returns How many seats were released.
   */
  async releaseSeats(showId: string, reservationId: string, labels: string[]): Promise<number> {
    const result = await this.db.query({ ...RELEASE_RESERVATION_SEATS, values: [showId, reservationId, labels] });
    return result.rowCount ?? 0;
  }

  /** Marks a reservation cancelled. */
  async markReservationCancelled(reservationId: string): Promise<void> {
    await this.db.query({ ...MARK_RESERVATION_CANCELLED, values: [reservationId] });
  }
}

/**
 * Database access for reservations. Services run their logic inside {@link ReservationRepository.inTransaction}
 * and never see SQL or the connection.
 * @param pool - Postgres pool.
 */
export class ReservationRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Runs `fn` in one transaction (commit on success, rollback on any error, deadlock retries, 503 on connection loss).
   * @param fn - Work to do with the transaction's operations.
   */
  inTransaction<T>(fn: (tx: ReservationTx) => Promise<T>): Promise<T> {
    return runInTransaction(this.pool, (db) => fn(new ReservationTx(db)));
  }
}
