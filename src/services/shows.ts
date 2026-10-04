import type { Config } from "../config/config.js";
import type { SeatCache } from "../infrastructure/cache/seatCache.js";
import { badRequest, notFound } from "../common/errors.js";
import type { SeatStatus, ShowMeta, ShowRepository, StatusCountRow } from "../infrastructure/database/repositories/showRepository.js";

export type { ShowMeta } from "../infrastructure/database/repositories/showRepository.js";

/** One seat as shown to clients. `held` is never stored in Postgres; it comes from Redis. */
export interface SeatView {
  seat: string;
  status: SeatStatus;
}

/** Seat totals by state; `available + held + confirmed` always equals the show's `total_seats`. */
export interface ShowCounts {
  available: number;
  held: number;
  confirmed: number;
}

/** A show as returned by the API. `seats` is present only when the per-seat list was requested. */
export interface ShowView {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
  available: number;
  held: number;
  confirmed: number;
  counts: ShowCounts;
  reconciled: boolean;
  created_at: string;
  seats?: SeatView[];
}

/** Validated input for creating a show. */
export interface CreateShowInput {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
}

/** Shape of a UUID, checked before querying so a malformed id is a 404 rather than a database error. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Tells whether a string looks like a UUID.
 * @param s - Candidate id.
 */
export const isUuid = (s: string) => UUID_RE.test(s);

/**
 * Creates shows and reads their state. Postgres knows `available` and `confirmed`; Redis supplies which seats are currently held.
 * @param shows - Database access for shows.
 * @param config - Application settings.
 * @param cache - Redis layer that reports held seats.
 */
export class ShowService {
  /** Show rows never change after creation, so they are cached for the life of the process. */
  private readonly metaCache = new Map<string, ShowMeta>();
  /** Recent show-state reads (see `SHOW_STATE_CACHE_MS`), keyed by show id and whether seats were included. The promise is shared by concurrent readers. */
  private readonly stateCache = new Map<string, { at: number; value: Promise<ShowView> }>();

  constructor(
    private readonly shows: ShowRepository,
    private readonly config: Config,
    private readonly cache: SeatCache,
  ) {}

  /**
   * Creates a show with every seat `available`.
   * @param input - Name, seat labels (unique), price in paise and optional per-user limit.
   * @returns The created show.
   * @throws 400 if seat labels are not unique.
   */
  async createShow(input: CreateShowInput) {
    if (new Set(input.seats).size !== input.seats.length) throw badRequest("seats must be unique");
    const meta = await this.shows.insertShowWithSeats({
      name: input.name,
      seats: input.seats,
      pricePaise: input.price_paise,
      perUserLimit: input.per_user_limit ?? this.config.defaultPerUserLimit,
    });
    this.metaCache.set(meta.id, meta);
    return this.buildShowResponse(meta, input.seats.map((seat) => ({ seat, status: "available" as const })));
  }

  /**
   * Loads a show's immutable facts, from memory when possible.
   * @param id - Show id.
   * @throws 404 if the id is malformed or unknown.
   */
  async getShowMeta(id: string): Promise<ShowMeta> {
    if (!isUuid(id)) throw notFound("show");
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    const meta = await this.shows.findShowById(id);
    if (!meta) throw notFound("show");
    this.metaCache.set(id, meta);
    return meta;
  }

  /**
   * Returns the show's state: counts and, optionally, every seat with its status.
   * Held labels from Redis are passed into the single query that reads the seats, so each seat is classified exactly once from one
   * snapshot and `available + held + confirmed == total_seats`. A confirmed seat is never reported as held.
   * @param id - Show id.
   * @param includeSeats - Whether to include the per-seat list or counts only.
   * @throws 404 if the show does not exist.
   */
  async getShowState(id: string, includeSeats: boolean): Promise<ShowView> {
    const ttl = this.config.showStateCacheMs;
    if (ttl <= 0) return this.loadShowState(id, includeSeats);
    const key = `${id}:${includeSeats}`;
    const now = Date.now();
    const hit = this.stateCache.get(key);
    if (hit && now - hit.at < ttl) return hit.value;
    const entry = { at: now, value: this.loadShowState(id, includeSeats) };
    this.stateCache.set(key, entry);
    entry.value.catch(() => {
      if (this.stateCache.get(key) === entry) this.stateCache.delete(key);
    });
    return entry.value;
  }

  /**
   * Drops the cached state of a show, so the next read sees a reservation or cancellation that has just committed on this instance.
   * @param id - Show id.
   */
  invalidateShowState(id: string): void {
    this.stateCache.delete(`${id}:true`);
    this.stateCache.delete(`${id}:false`);
  }

  private async loadShowState(id: string, includeSeats: boolean): Promise<ShowView> {
    const meta = await this.getShowMeta(id);
    const held = await this.cache.listHeldSeats(id);
    if (!includeSeats) {
      return this.buildShowResponse(meta, undefined, await this.shows.countSeatsByStatus(id, held));
    }
    const rows = await this.shows.listSeatsWithStatus(id, held);
    return this.buildShowResponse(meta, rows.map((r) => ({ seat: r.label, status: r.status })));
  }

  /**
   * Shapes the API response from either a per-seat list or grouped counts, including the `reconciled` flag.
   * @param meta - The show.
   * @param seats - Per-seat statuses, when requested.
   * @param grouped - Pre-aggregated counts, when seats were not requested.
   */
  private buildShowResponse(meta: ShowMeta, seats?: SeatView[], grouped?: StatusCountRow[]): ShowView {
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
