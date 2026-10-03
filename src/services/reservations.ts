import { createHash, randomUUID } from "node:crypto";
import type { SeatCache } from "../infrastructure/cache/seatCache.js";
import { DeclineError, forbidden, notFound } from "../common/errors.js";
import type { EventBus } from "../infrastructure/events/eventBus.js";
import type {
  ReservationRepository,
  ReservationRow,
  ReservationTx,
} from "../infrastructure/database/repositories/reservationRepository.js";
import { isUuid, type ShowMeta, type ShowService } from "./shows.js";

/** A reservation as returned by the API. */
export interface ReservationView {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: "confirmed" | "cancelled";
}

/** Everything needed to attempt a reservation. `userId` comes from the verified token. */
export interface ReserveInput {
  userId: string;
  showId: string;
  seats: string[];
  idempotencyKey: string;
}

/** Outcome of a successful reserve call. `replay` is true when an earlier success was returned for the same idempotency key. */
export interface ReserveResult {
  replay: boolean;
  reservation: ReservationView;
}

/**
 * Maps a reservation row to the API shape.
 * @param row - Database row.
 */
const toReservationView = (row: ReservationRow): ReservationView => ({
  reservation_id: row.id,
  show_id: row.show_id,
  user_id: row.user_id,
  seats: row.seats,
  amount_paise: row.amount_paise,
  status: row.status,
});

/**
 * Builds the clean decline for a user who would exceed the per-show seat limit.
 * @param limit - The show's per-user limit.
 */
const perUserLimitDecline = (limit: number) =>
  new DeclineError("per_user_limit", `at most ${limit} seats per user for this show`, { limit });

/**
 * Reserves and cancels seats. Redis lets one request win a seat and turns the rest away; Postgres makes the real, atomic decision.
 * The service only orchestrates: SQL lives in the repository, Redis commands in the seat cache, and metrics are updated by
 * listeners of the events published here.
 * @param reservations - Database access for reservations.
 * @param shows - Show lookups.
 * @param cache - Redis seat lock.
 * @param events - Bus where outcomes are announced.
 */
export class ReservationService {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly shows: ShowService,
    private readonly cache: SeatCache,
    private readonly events: EventBus,
  ) {}

  /**
   * Reserves seats for a user, all-or-nothing and idempotent, and announces the outcome.
   * @param input - User, show, seats and idempotency key.
   * @returns The reservation (201 case) or the original one (`replay`).
   * @throws {DeclineError} `seat_taken`, `per_user_limit`, `idempotency_key_conflict` or `unknown_seat`.
   */
  async reserveSeats(input: ReserveInput): Promise<ReserveResult> {
    try {
      const result = await this.holdAndConfirmSeats(input);
      this.events.emit(result.replay ? "reservation.replayed" : "reservation.confirmed");
      return result;
    } catch (err) {
      if (err instanceof DeclineError) this.events.emit("reservation.declined", err.reason);
      throw err;
    }
  }

  /**
   * The reserve flow: normalise the seats, try the Redis lock, run the Postgres transaction, then update Redis with the result.
   * Redis only ever declines or admits; a Redis outage or flush cannot double-sell because Postgres still decides.
   * @param input - User, show, seats and idempotency key.
   */
  private async holdAndConfirmSeats(input: ReserveInput): Promise<ReserveResult> {
    const show = await this.shows.getShowMeta(input.showId);
    // Canonical order: every transaction locks seats in this same order, so two
    // multi-seat requests over overlapping seats can never deadlock.
    const labels = [...new Set(input.seats)].sort();
    const reservationId = randomUUID();
    const requestHash = createHash("sha256").update(`${show.id}\n${labels.join("\n")}`).digest("hex");

    if (labels.length > show.per_user_limit) throw perUserLimitDecline(show.per_user_limit);

    const token = createHash("sha256").update(`${input.userId}\n${input.idempotencyKey}`).digest("hex").slice(0, 32);
    const hold = await this.cache.tryHoldSeats(show.id, labels, token);
    if (hold.kind === "taken") {
      this.events.emit("cache.declined");
      throw new DeclineError("seat_taken", `seat(s) already taken: ${hold.seats.join(", ")}`, { seats: hold.seats });
    }

    try {
      const result = await this.confirmInDatabase(show, labels, reservationId, requestHash, input);
      if (!result.replay) await this.cache.markSeatsConfirmed(show.id, labels, reservationId, token);
      else if (hold.kind === "acquired") await this.cache.releaseHold(show.id, labels, token);
      return result;
    } catch (err) {
      if (hold.kind === "acquired") await this.cache.releaseHold(show.id, labels, token);
      if (err instanceof DeclineError && err.reason === "seat_taken" && err.holders) {
        await this.cache.markSeatsTaken(show.id, err.holders);
      }
      throw err;
    }
  }

  /**
   * The Postgres transaction that decides a reservation. Lock order is fixed (idempotency row, quota row, seat rows sorted),
   * so concurrent requests cannot deadlock, and any decline rolls everything back.
   * @param show - The show.
   * @param labels - Sorted, de-duplicated seat labels.
   * @param reservationId - Id to give a new reservation.
   * @param requestHash - Fingerprint of the request body, for idempotency conflict detection.
   * @param input - The original request.
   */
  private confirmInDatabase(
    show: ShowMeta,
    labels: string[],
    reservationId: string,
    requestHash: string,
    input: ReserveInput,
  ): Promise<ReserveResult> {
    return this.reservations.inTransaction(async (tx) => {
      const claimed = await tx.claimIdempotencyKey(input.userId, input.idempotencyKey, show.id, requestHash);
      if (!claimed) return this.returnOriginalReservation(tx, input, requestHash);

      await this.enforcePerUserLimit(tx, show, input.userId, labels.length);
      await this.lockSeatsAndEnsureAvailable(tx, show.id, labels);

      const amount = show.price_paise * labels.length;
      await tx.insertReservation({ id: reservationId, showId: show.id, userId: input.userId, seats: labels, amountPaise: amount });
      const confirmed = await tx.confirmSeats(show.id, labels, reservationId, input.userId);
      if (confirmed !== labels.length) throw new Error("invariant: locked seats changed under us");
      await tx.attachReservationToKey(input.userId, input.idempotencyKey, reservationId);

      return {
        replay: false,
        reservation: {
          reservation_id: reservationId,
          show_id: show.id,
          user_id: input.userId,
          seats: labels,
          amount_paise: amount,
          status: "confirmed" as const,
        },
      };
    });
  }

  /**
   * Enforces the per-user limit: makes sure the user's counter row exists, then checks and takes the quota in one conditional update.
   * That update locks the row, so one user's concurrent reserves run one after another and cannot overshoot.
   * @param count - Number of seats being requested.
   * @throws {DeclineError} `per_user_limit` when the quota would be exceeded.
   */
  private async enforcePerUserLimit(tx: ReservationTx, show: ShowMeta, userId: string, count: number): Promise<void> {
    await tx.ensureQuotaRow(show.id, userId);
    if (!(await tx.takeQuota(show.id, userId, count, show.per_user_limit))) throw perUserLimitDecline(show.per_user_limit);
  }

  /**
   * The decision point. Locking the seat rows makes concurrent requests for a seat queue; the loser re-reads the committed row
   * after the winner commits and sees it taken. All-or-nothing: one unavailable seat declines the whole request.
   * @throws {DeclineError} `unknown_seat`, or `seat_taken` (carrying the current holders so Redis can be primed).
   */
  private async lockSeatsAndEnsureAvailable(tx: ReservationTx, showId: string, labels: string[]): Promise<void> {
    const rows = await tx.lockSeats(showId, labels);
    if (rows.length !== labels.length) {
      const found = new Set(rows.map((r) => r.label));
      const missing = labels.filter((l) => !found.has(l));
      throw new DeclineError("unknown_seat", `unknown seat(s): ${missing.join(", ")}`, { seats: missing });
    }
    const taken = rows.filter((r) => r.status !== "available");
    if (taken.length === 0) return;

    const err = new DeclineError("seat_taken", `seat(s) already taken: ${taken.map((r) => r.label).join(", ")}`, {
      seats: taken.map((r) => r.label),
    });
    err.holders = Object.fromEntries(taken.filter((r) => r.reservation_id).map((r) => [r.label, r.reservation_id!]));
    throw err;
  }

  /**
   * Cancels a confirmed reservation and returns its seats to available. Only the owner may cancel, and repeating a cancel is a no-op.
   * Lock order: reservation row, the user's quota row, then seat rows (sorted), consistent with reserve. Seats are freed only where they still
   * point at this reservation, so a cancel can never free a seat that now belongs to someone else.
   * @param userId - Caller, from the token.
   * @param reservationId - Reservation to cancel.
   * @returns Whether anything changed, and the reservation.
   * @throws 404 if unknown, 403 if not the owner.
   */
  async cancelReservation(userId: string, reservationId: string): Promise<{ changed: boolean; reservation: ReservationView }> {
    if (!isUuid(reservationId)) throw notFound("reservation");
    const result = await this.reservations.inTransaction(async (tx) => {
      const row = await tx.lockReservation(reservationId);
      if (!row) throw notFound("reservation");
      if (row.user_id !== userId) throw forbidden("only the owner can cancel a reservation");
      if (row.status === "cancelled") return { changed: false, reservation: toReservationView(row) };

      await tx.releaseQuota(row.show_id, userId, row.seats.length);
      if ((await tx.lockReservationSeats(row.show_id, row.id)) !== row.seats.length) {
        throw new Error("invariant: reservation seats missing");
      }
      await tx.releaseSeats(row.show_id, row.id);
      await tx.markReservationCancelled(row.id);
      return { changed: true, reservation: { ...toReservationView(row), status: "cancelled" as const } };
    });
    if (result.changed) {
      this.events.emit("reservation.cancelled");
      await this.cache.clearConfirmedMarkers(result.reservation.show_id, result.reservation.seats, reservationId);
    }
    return result;
  }

  /**
   * Handles a reused idempotency key: returns the original reservation, or rejects if the request body differs.
   * @throws {DeclineError} `idempotency_key_conflict` when the key was used with different seats.
   */
  private async returnOriginalReservation(tx: ReservationTx, input: ReserveInput, requestHash: string): Promise<ReserveResult> {
    const row = await tx.findOriginalReservation(input.userId, input.idempotencyKey);
    if (!row) throw new Error("invariant: idempotency key without reservation");
    if (row.request_hash !== requestHash) {
      throw new DeclineError(
        "idempotency_key_conflict",
        "idempotency key was already used with a different request",
        { reservation_id: row.id },
      );
    }
    return { replay: true, reservation: toReservationView(row) };
  }
}
