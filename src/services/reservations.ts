import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "../db.js";
import { DeclineError, forbidden, notFound } from "../errors.js";
import { isUuid } from "./shows.js";
import type { Metrics } from "../metrics.js";
import type { ShowService } from "./shows.js";

export interface ReservationView {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: "confirmed" | "cancelled";
}

export interface ReserveInput {
  userId: string;
  showId: string;
  seats: string[];
  idempotencyKey: string;
}

export interface ReserveResult {
  replay: boolean;
  reservation: ReservationView;
}

export class ReservationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly shows: ShowService,
    private readonly metrics: Metrics,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    try {
      const result = await this.reserveInner(input);
      if (result.replay) this.metrics.declined.inc({ reason: "idempotent_replay" });
      else this.metrics.confirmed.inc();
      return result;
    } catch (err) {
      if (err instanceof DeclineError) this.metrics.declined.inc({ reason: err.reason });
      throw err;
    }
  }

  private async reserveInner(input: ReserveInput): Promise<ReserveResult> {
    const show = await this.shows.getMeta(input.showId);
    // Canonical order: every transaction locks seats in this same order, so two
    // multi-seat requests over overlapping seats can never deadlock.
    const labels = [...new Set(input.seats)].sort();
    const reservationId = randomUUID();
    const requestHash = createHash("sha256").update(`${show.id}\n${labels.join("\n")}`).digest("hex");

    if (labels.length > show.per_user_limit) {
      throw new DeclineError(
        "per_user_limit",
        `at most ${show.per_user_limit} seats per user for this show`,
        { limit: show.per_user_limit },
      );
    }

    return withTx(this.pool, async (db) => {
      // Idempotency gate (first lock taken). The (user_id, key) primary key means a concurrent
      // request with the same key blocks here until the first transaction commits or rolls back,
      // so one key can only ever produce one reservation. Declines roll the whole transaction
      // back, which releases the key: only a successful reservation consumes it.
      const claimed = await db.query(
        `INSERT INTO idempotency_keys (user_id, key, show_id, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, key) DO NOTHING`,
        [input.userId, input.idempotencyKey, show.id, requestHash],
      );
      if (claimed.rowCount === 0) return this.replay(db, input, requestHash);

      // Lock order is always: idempotency row, per-user counter row, then seat rows (sorted).
      // A single conditional upsert both checks and takes the quota, atomically; concurrent
      // requests from one user serialise on this row, so parallel reserves cannot overshoot.
      const quota = await db.query<{ held_count: number }>(
        `INSERT INTO user_show_holdings (show_id, user_id, held_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (show_id, user_id) DO UPDATE
           SET held_count = user_show_holdings.held_count + EXCLUDED.held_count
         WHERE user_show_holdings.held_count + EXCLUDED.held_count <= $4
         RETURNING held_count`,
        [show.id, input.userId, labels.length, show.per_user_limit],
      );
      if (quota.rowCount === 0) {
        throw new DeclineError(
          "per_user_limit",
          `at most ${show.per_user_limit} seats per user for this show`,
          { limit: show.per_user_limit },
        );
      }

      // The decision point. FOR UPDATE makes concurrent requests for a seat queue on its row
      // lock; the loser re-reads the committed row after the winner commits and sees it taken.
      const { rows } = await db.query<{ label: string; status: string }>(
        `SELECT label, status FROM seats
          WHERE show_id = $1 AND label = ANY($2::text[])
          ORDER BY label COLLATE "C"
            FOR UPDATE`,
        [show.id, labels],
      );
      if (rows.length !== labels.length) {
        const found = new Set(rows.map((r) => r.label));
        const missing = labels.filter((l) => !found.has(l));
        throw new DeclineError("unknown_seat", `unknown seat(s): ${missing.join(", ")}`, { seats: missing });
      }
      const taken = rows.filter((r) => r.status !== "available").map((r) => r.label);
      if (taken.length > 0) {
        // All-or-nothing: one unavailable seat declines the whole request.
        throw new DeclineError("seat_taken", `seat(s) already taken: ${taken.join(", ")}`, { seats: taken });
      }

      const amount = show.price_paise * labels.length;
      await db.query(
        `INSERT INTO reservations (id, show_id, user_id, seats, amount_paise, status)
         VALUES ($1, $2, $3, $4, $5, 'confirmed')`,
        [reservationId, show.id, input.userId, labels, amount],
      );
      const upd = await db.query(
        `UPDATE seats SET status = 'confirmed', reservation_id = $3, user_id = $4
          WHERE show_id = $1 AND label = ANY($2::text[]) AND status = 'available'`,
        [show.id, labels, reservationId, input.userId],
      );
      if (upd.rowCount !== labels.length) throw new Error("invariant: locked seats changed under us");
      await db.query(
        `UPDATE idempotency_keys SET reservation_id = $3 WHERE user_id = $1 AND key = $2`,
        [input.userId, input.idempotencyKey, reservationId],
      );

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
   * Cancels a confirmed reservation and returns its seats to available. Only the owner may cancel.
   * Lock order: reservation row, then the user's quota row, then seat rows (sorted) - consistent
   * with reserve (quota row, then seats), so the two can never deadlock. Seats are released only
   * where they still point at this reservation, so a cancel can never free a seat held by someone else.
   */
  async cancel(userId: string, reservationId: string): Promise<{ changed: boolean; reservation: ReservationView }> {
    if (!isUuid(reservationId)) throw notFound("reservation");
    const result = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{
        id: string;
        show_id: string;
        user_id: string;
        seats: string[];
        amount_paise: number;
        status: "confirmed" | "cancelled";
      }>(
        `SELECT id, show_id, user_id, seats, amount_paise, status FROM reservations WHERE id = $1 FOR UPDATE`,
        [reservationId],
      );
      const row = rows[0];
      if (!row) throw notFound("reservation");
      if (row.user_id !== userId) throw forbidden("only the owner can cancel a reservation");
      const view: ReservationView = {
        reservation_id: row.id,
        show_id: row.show_id,
        user_id: row.user_id,
        seats: row.seats,
        amount_paise: row.amount_paise,
        status: row.status,
      };
      if (row.status === "cancelled") return { changed: false, reservation: view };

      await db.query(
        `UPDATE user_show_holdings SET held_count = held_count - $3 WHERE show_id = $1 AND user_id = $2`,
        [row.show_id, userId, row.seats.length],
      );
      const locked = await db.query(
        `SELECT label FROM seats
          WHERE show_id = $1 AND reservation_id = $2
          ORDER BY label COLLATE "C"
            FOR UPDATE`,
        [row.show_id, row.id],
      );
      if (locked.rowCount !== row.seats.length) throw new Error("invariant: reservation seats missing");
      await db.query(
        `UPDATE seats SET status = 'available', reservation_id = NULL, user_id = NULL
          WHERE show_id = $1 AND reservation_id = $2`,
        [row.show_id, row.id],
      );
      await db.query(`UPDATE reservations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [row.id]);
      return { changed: true, reservation: { ...view, status: "cancelled" as const } };
    });
    if (result.changed) this.metrics.cancelled.inc();
    return result;
  }

  private async replay(db: pg.PoolClient, input: ReserveInput, requestHash: string): Promise<ReserveResult> {
    const { rows } = await db.query<{
      request_hash: string;
      id: string;
      show_id: string;
      user_id: string;
      seats: string[];
      amount_paise: number;
      status: "confirmed" | "cancelled";
    }>(
      `SELECT k.request_hash, r.id, r.show_id, r.user_id, r.seats, r.amount_paise, r.status
         FROM idempotency_keys k JOIN reservations r ON r.id = k.reservation_id
        WHERE k.user_id = $1 AND k.key = $2`,
      [input.userId, input.idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new Error("invariant: idempotency key without reservation");
    if (row.request_hash !== requestHash) {
      throw new DeclineError(
        "idempotency_key_conflict",
        "idempotency key was already used with a different request",
        { reservation_id: row.id },
      );
    }
    return {
      replay: true,
      reservation: {
        reservation_id: row.id,
        show_id: row.show_id,
        user_id: row.user_id,
        seats: row.seats,
        amount_paise: row.amount_paise,
        status: row.status,
      },
    };
  }
}
