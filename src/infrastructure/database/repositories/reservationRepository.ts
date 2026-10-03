import type pg from "pg";
import { runInTransaction, type Db } from "../connection.js";
import {
  ATTACH_RESERVATION_TO_KEY,
  CLAIM_IDEMPOTENCY_KEY,
  ENSURE_USER_QUOTA_ROW,
  INSERT_RESERVATION,
  LOCK_REQUESTED_SEATS,
  LOCK_RESERVATION_FOR_CANCEL,
  LOCK_RESERVATION_SEATS,
  MARK_RESERVATION_CANCELLED,
  MARK_SEATS_AVAILABLE,
  MARK_SEATS_CONFIRMED,
  RELEASE_USER_QUOTA,
  SELECT_ORIGINAL_RESERVATION_BY_KEY,
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

/** A locked seat row read while deciding a reservation. */
export interface SeatRow {
  label: string;
  status: string;
  reservation_id: string | null;
}

/** Data for a new reservation row. */
export interface NewReservation {
  id: string;
  showId: string;
  userId: string;
  seats: string[];
  amountPaise: number;
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
    const result = await this.db.query(CLAIM_IDEMPOTENCY_KEY, [userId, key, showId, requestHash]);
    return result.rowCount === 1;
  }

  /** Records which reservation an idempotency key produced. */
  async attachReservationToKey(userId: string, key: string, reservationId: string): Promise<void> {
    await this.db.query(ATTACH_RESERVATION_TO_KEY, [userId, key, reservationId]);
  }

  /**
   * Finds the reservation behind an already-used key.
   * @returns The reservation and the hash of the request that created it, or undefined.
   */
  async findOriginalReservation(userId: string, key: string): Promise<ReplayRow | undefined> {
    const { rows } = await this.db.query<ReplayRow>(SELECT_ORIGINAL_RESERVATION_BY_KEY, [userId, key]);
    return rows[0];
  }

  /** Makes sure the `(show, user)` quota counter row exists. */
  async ensureQuotaRow(showId: string, userId: string): Promise<void> {
    await this.db.query(ENSURE_USER_QUOTA_ROW, [showId, userId]);
  }

  /**
   * Checks and takes the quota in one conditional update, which also locks the user's counter row.
   * @returns True if the quota was taken, false if it would exceed the limit.
   */
  async takeQuota(showId: string, userId: string, count: number, limit: number): Promise<boolean> {
    const result = await this.db.query(TAKE_USER_QUOTA, [showId, userId, count, limit]);
    return result.rowCount === 1;
  }

  /** Gives seats back to the user's quota. */
  async releaseQuota(showId: string, userId: string, count: number): Promise<void> {
    await this.db.query(RELEASE_USER_QUOTA, [showId, userId, count]);
  }

  /**
   * Locks the requested seat rows in a fixed byte order and returns them (the decision point).
   * @returns The rows that exist; fewer than requested means some labels are unknown.
   */
  async lockSeats(showId: string, labels: string[]): Promise<SeatRow[]> {
    const { rows } = await this.db.query<SeatRow>(LOCK_REQUESTED_SEATS, [showId, labels]);
    return rows;
  }

  /** Inserts a confirmed reservation. */
  async insertReservation(reservation: NewReservation): Promise<void> {
    await this.db.query(INSERT_RESERVATION, [
      reservation.id,
      reservation.showId,
      reservation.userId,
      reservation.seats,
      reservation.amountPaise,
    ]);
  }

  /**
   * Flips locked seats to confirmed, guarded on `status = 'available'`.
   * @returns How many seats were updated.
   */
  async confirmSeats(showId: string, labels: string[], reservationId: string, userId: string): Promise<number> {
    const result = await this.db.query(MARK_SEATS_CONFIRMED, [showId, labels, reservationId, userId]);
    return result.rowCount ?? 0;
  }

  /** Loads and locks a reservation for cancelling. */
  async lockReservation(reservationId: string): Promise<ReservationRow | undefined> {
    const { rows } = await this.db.query<ReservationRow>(LOCK_RESERVATION_FOR_CANCEL, [reservationId]);
    return rows[0];
  }

  /**
   * Locks the seats that still point at a reservation.
   * @returns How many seats were locked.
   */
  async lockReservationSeats(showId: string, reservationId: string): Promise<number> {
    const result = await this.db.query(LOCK_RESERVATION_SEATS, [showId, reservationId]);
    return result.rowCount ?? 0;
  }

  /** Returns a reservation's seats to available and clears their owner. */
  async releaseSeats(showId: string, reservationId: string): Promise<void> {
    await this.db.query(MARK_SEATS_AVAILABLE, [showId, reservationId]);
  }

  /** Marks a reservation cancelled. */
  async markReservationCancelled(reservationId: string): Promise<void> {
    await this.db.query(MARK_RESERVATION_CANCELLED, [reservationId]);
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
