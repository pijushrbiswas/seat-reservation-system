import type pg from "pg";
import type { Config } from "../config.js";
import { withTx } from "../db.js";
import { badRequest, notFound } from "../errors.js";

export interface ShowMeta {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
  created_at: string;
}

export interface SeatView {
  seat: string;
  status: "available" | "held" | "confirmed";
}

export interface ShowCounts {
  available: number;
  held: number;
  confirmed: number;
}

export interface CreateShowInput {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export class ShowService {
  // Show rows are immutable once created, so they can be cached for the life of the process.
  private readonly metaCache = new Map<string, ShowMeta>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}

  async create(input: CreateShowInput) {
    const unique = new Set(input.seats);
    if (unique.size !== input.seats.length) throw badRequest("seats must be unique");
    const limit = input.per_user_limit ?? this.config.defaultPerUserLimit;

    const meta = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<ShowMeta>(
        `INSERT INTO shows (name, price_paise, per_user_limit, total_seats)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, price_paise, per_user_limit, total_seats, created_at`,
        [input.name, input.price_paise, limit, input.seats.length],
      );
      const show = rows[0]!;
      await db.query(
        `INSERT INTO seats (show_id, label, pos)
         SELECT $1, t.label, t.ord FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)`,
        [show.id, input.seats],
      );
      return show;
    });
    this.metaCache.set(meta.id, meta);
    return this.view(meta, input.seats.map((seat) => ({ seat, status: "available" as const })));
  }

  async getMeta(id: string): Promise<ShowMeta> {
    if (!isUuid(id)) throw notFound("show");
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    const { rows } = await this.pool.query<ShowMeta>(
      `SELECT id, name, price_paise, per_user_limit, total_seats, created_at FROM shows WHERE id = $1`,
      [id],
    );
    const meta = rows[0];
    if (!meta) throw notFound("show");
    this.metaCache.set(id, meta);
    return meta;
  }

  // Each branch is a single statement, so counts and per-seat rows come from one snapshot.
  async get(id: string, includeSeats: boolean) {
    const meta = await this.getMeta(id);
    if (!includeSeats) {
      const { rows } = await this.pool.query<{ status: SeatView["status"]; n: number }>(
        `SELECT status, count(*)::int AS n FROM seats WHERE show_id = $1 GROUP BY status`,
        [id],
      );
      return this.view(meta, undefined, rows);
    }
    const { rows } = await this.pool.query<{ label: string; status: SeatView["status"] }>(
      `SELECT label, status FROM seats WHERE show_id = $1 ORDER BY pos, label`,
      [id],
    );
    const seats = rows.map((r) => ({ seat: r.label, status: r.status }));
    return this.view(meta, seats);
  }

  private view(meta: ShowMeta, seats?: SeatView[], grouped?: { status: SeatView["status"]; n: number }[]) {
    const counts: ShowCounts = { available: 0, held: 0, confirmed: 0 };
    if (seats) for (const s of seats) counts[s.status]++;
    if (grouped) for (const g of grouped) counts[g.status] = g.n;
    return {
      id: meta.id,
      name: meta.name,
      price_paise: meta.price_paise,
      per_user_limit: meta.per_user_limit,
      total_seats: meta.total_seats,
      available: counts.available,
      held: counts.held,
      confirmed: counts.confirmed,
      counts,
      reconciled: counts.available + counts.held + counts.confirmed === meta.total_seats,
      created_at: meta.created_at,
      ...(seats ? { seats } : {}),
    };
  }
}
