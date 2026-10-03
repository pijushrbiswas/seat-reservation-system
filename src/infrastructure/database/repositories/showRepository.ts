import type pg from "pg";
import {
  COUNT_SEATS_BY_STATUS,
  INSERT_SEATS,
  INSERT_SHOW,
  SELECT_SEATS_WITH_STATUS,
  SELECT_SHOW_BY_ID,
} from "../queries/shows.js";
import { runInTransaction } from "../connection.js";

/** Immutable facts about a show, as stored in the `shows` table. */
export interface ShowMeta {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
  created_at: string;
}

/** A seat's status as shown to clients. `held` is never stored in Postgres; it comes from Redis. */
export type SeatStatus = "available" | "held" | "confirmed";

/** A seat with its status. */
export interface SeatStatusRow {
  label: string;
  status: SeatStatus;
}

/** How many seats of a show are in one status. */
export interface StatusCountRow {
  status: SeatStatus;
  n: number;
}

/** Data needed to insert a show. */
export interface NewShow {
  name: string;
  seats: string[];
  pricePaise: number;
  perUserLimit: number;
}

/**
 * Database access for shows and their seats. Holds every show-related SQL call so services contain none.
 * @param pool - Postgres pool.
 */
export class ShowRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Inserts a show and one `available` row per seat in a single transaction.
   * @param show - Name, seat labels in display order, price and limit.
   * @returns The stored show.
   */
  insertShowWithSeats(show: NewShow): Promise<ShowMeta> {
    return runInTransaction(this.pool, async (db) => {
      const { rows } = await db.query<ShowMeta>(INSERT_SHOW, [
        show.name,
        show.pricePaise,
        show.perUserLimit,
        show.seats.length,
      ]);
      const created = rows[0]!;
      await db.query(INSERT_SEATS, [created.id, show.seats]);
      return created;
    });
  }

  /**
   * Loads a show's immutable facts.
   * @param id - Show id (must be a valid UUID).
   * @returns The show, or undefined if none exists.
   */
  async findShowById(id: string): Promise<ShowMeta | undefined> {
    const { rows } = await this.pool.query<ShowMeta>(SELECT_SHOW_BY_ID, [id]);
    return rows[0];
  }

  /**
   * Counts seats per status in one snapshot; available seats in `heldLabels` are counted as held.
   * @param showId - Show id.
   * @param heldLabels - Seats currently held in Redis.
   */
  async countSeatsByStatus(showId: string, heldLabels: string[]): Promise<StatusCountRow[]> {
    const { rows } = await this.pool.query<StatusCountRow>(COUNT_SEATS_BY_STATUS, [showId, heldLabels]);
    return rows;
  }

  /**
   * Lists every seat in display order with its status; available seats in `heldLabels` are reported as held.
   * @param showId - Show id.
   * @param heldLabels - Seats currently held in Redis.
   */
  async listSeatsWithStatus(showId: string, heldLabels: string[]): Promise<SeatStatusRow[]> {
    const { rows } = await this.pool.query<SeatStatusRow>(SELECT_SEATS_WITH_STATUS, [showId, heldLabels]);
    return rows;
  }
}
