import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "../db.js";
import { DeclineError } from "../errors.js";
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
      this.metrics.confirmed.inc();
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

    return withTx(this.pool, async (db) => {
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
}
