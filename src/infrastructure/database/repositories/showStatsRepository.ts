import type pg from "pg";
import { SELECT_RECENT_SHOW_IDS, SELECT_SHOW_STATS } from "../queries/metrics.js";

/** Seat counts for one show, as reported by the gauges. `available + held + confirmed` equals `total`. */
export interface ShowStat {
  showId: string;
  total: number;
  available: number;
  held: number;
  confirmed: number;
}

/**
 * Read-only database access for the metrics gauges.
 * @param pool - Postgres pool.
 */
export class ShowStatsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Ids of the newest shows.
   * @param limit - How many to return.
   */
  async findRecentShowIds(limit: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(SELECT_RECENT_SHOW_IDS, [limit]);
    return rows.map((r) => r.id);
  }

  /**
   * Available, held and confirmed counts per show, in one query.
   * @param showIds - Shows to report.
   * @param heldShowIds - Parallel array with `heldLabels`: the show each held seat belongs to.
   * @param heldLabels - Seats currently held in Redis.
   */
  async findShowStats(showIds: string[], heldShowIds: string[], heldLabels: string[]): Promise<ShowStat[]> {
    const { rows } = await this.pool.query<{
      show_id: string;
      total_seats: number;
      available: string;
      held: string;
      confirmed: string;
    }>(SELECT_SHOW_STATS, [showIds, heldShowIds, heldLabels]);
    return rows.map((row) => ({
      showId: row.show_id,
      total: row.total_seats,
      available: Number(row.available),
      held: Number(row.held),
      confirmed: Number(row.confirmed),
    }));
  }
}
