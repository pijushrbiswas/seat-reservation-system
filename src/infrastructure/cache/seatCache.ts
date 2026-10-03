import { Redis } from "ioredis";
import type { Config } from "../../config/config.js";
import type { EventBus } from "../events/eventBus.js";
import { heldSeatsKey, idempotencyMarkerKey, seatLockKey } from "./keys.js";
import { HOLD_SEATS_SCRIPT, LIVE_HOLDS_SCRIPT, RELEASE_IF_OWNER_SCRIPT } from "./seatScripts.js";

/**
 * Redis owns the "held" state of a seat; Postgres owns "available" and "confirmed".
 *
 * A request that wins the seat lock in Redis is the only one that goes on to Postgres to confirm.
 * Everyone else is declined here and never touches the database. The lock has a TTL (the hold), so a
 * request that dies mid-way frees its seats by itself. Redis never grants a seat: a 201 still needs
 * the row lock and conditional update in Postgres, so losing, flushing or mis-reading Redis cannot
 * cause a double-sell.
 *
 * Keys share one Redis Cluster slot per show via the {showId} hash tag.
 *   seat:{show}:label  = "L|<token>"   hold: a request won this seat and is confirming it (TTL = hold)
 *                      = "C|<resId>"   marker: seat is confirmed by that reservation (short TTL, self-healing)
 *   held:{show}        sorted set, member = seat label, score = hold expiry (epoch ms)
 *   idem:{show}:<token>                set once a (user, idempotency key) has succeeded
 *
 * A seat is "held" when Postgres says it is available and the sorted set has an unexpired entry for it.
 */

/** The Redis client extended with the custom Lua commands defined in the constructor. */
type ScriptClient = Redis & {
  holdSeats(numKeys: number, ...args: (string | number)[]): Promise<number[]>;
  releaseIfOwner(numKeys: number, ...args: (string | number)[]): Promise<number>;
  listLiveHolds(numKeys: number, ...args: (string | number)[]): Promise<string[]>;
};

/**
 * Result of trying to take the Redis lock.
 * - `acquired`: this request holds the seats and should go on to Postgres.
 * - `bypass`: the idempotency key is known; go straight to Postgres.
 * - `taken`: another request holds or has confirmed these seats; decline.
 * - `off`: Redis is disabled or unreachable; Postgres decides alone.
 */
export type HoldResult =
  | { kind: "acquired" }
  | { kind: "bypass" }
  | { kind: "taken"; seats: string[] }
  | { kind: "off" };

/**
 * Redis owns the "held" state of a seat; Postgres owns "available" and "confirmed". The request that wins a seat's lock is the only one
 * that goes on to Postgres; everyone else is declined without touching the database. Redis never grants a seat, so losing, flushing or
 * mis-reading it cannot cause a double-sell.
 * @param config - Supplies the Redis URL and the hold and marker lifetimes.
 * @param events - Bus that receives `cache.error` when a Redis call fails.
 * @param log - Optional logger for Redis connection errors.
 */
export class SeatCache {
  private readonly client: ScriptClient | undefined;
  private readonly holdMs: number;
  private readonly markerSeconds: number;

  constructor(
    config: Config,
    private readonly events: EventBus,
    log?: { warn: (o: object, m: string) => void },
  ) {
    this.holdMs = config.seatHoldSeconds * 1000;
    this.markerSeconds = config.seatCacheTtlSeconds;
    if (!config.redisEnabled || !config.redisUrl) return;
    const client = new Redis(config.redisUrl, {
      // Fail fast and fall through to Postgres instead of queueing commands behind a dead Redis.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 300,
      connectTimeout: 2_000,
      retryStrategy: (n) => Math.min(n * 200, 2_000),
    }) as ScriptClient;
    client.on("error", (err: Error) => log?.warn({ err: err.message }, "redis error (falling back to postgres)"));
    client.defineCommand("holdSeats", { lua: HOLD_SEATS_SCRIPT });
    client.defineCommand("releaseIfOwner", { lua: RELEASE_IF_OWNER_SCRIPT });
    client.defineCommand("listLiveHolds", { lua: LIVE_HOLDS_SCRIPT });
    this.client = client;
  }

  /**
   * Connection state for `/health`.
   * @returns `ok`, `down` (configured but not connected), or `disabled`.
   */
  connectionStatus(): "ok" | "down" | "disabled" {
    if (!this.client) return "disabled";
    return this.client.status === "ready" ? "ok" : "down";
  }

  /**
   * Waits until the Redis connection is ready, or the timeout passes. Used by tests.
   * @param timeoutMs - Longest time to wait.
   */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    const c = this.client;
    if (!c || c.status === "ready") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        c!.off("ready", done);
        resolve();
      }
      c.once("ready", done);
    });
  }

  /** Closes the Redis connection on shutdown. */
  async close(): Promise<void> {
    this.client?.disconnect();
  }

  /**
   * Tries to win every seat. Winners hold them for the hold TTL; losers are told which seats are taken.
   * @param show - Show id.
   * @param labels - Seat labels requested.
   * @param token - Hash of user and idempotency key, identifying this logical request.
   * @returns A {@link HoldResult}; errors become `off` and increment the error counter.
   */
  async tryHoldSeats(show: string, labels: string[], token: string): Promise<HoldResult> {
    if (!this.client) return { kind: "off" };
    try {
      const res = await this.client.holdSeats(
        labels.length + 2,
        idempotencyMarkerKey(show, token),
        heldSeatsKey(show),
        ...labels.map((l) => seatLockKey(show, l)),
        token,
        this.holdMs,
        ...labels,
      );
      if (res[0] === 0) return { kind: "acquired" };
      if (res[0] === 1) return { kind: "bypass" };
      return { kind: "taken", seats: res.slice(1).map((i) => labels[i - 1]!) };
    } catch {
      this.events.emit("cache.error");
      return { kind: "off" };
    }
  }

  /**
   * Drops this request's own holds (never a confirmed marker or another request's hold). Retried once, because an unreleased hold blocks its seats until the TTL.
   * @param show - Show id.
   * @param labels - Seats to release.
   * @param token - Owner token of the holds.
   */
  async releaseHold(show: string, labels: string[], token: string): Promise<void> {
    const once = () =>
      this.client!.releaseIfOwner(
        labels.length + 1,
        heldSeatsKey(show),
        ...labels.map((l) => seatLockKey(show, l)),
        `L|${token}`,
        ...labels,
      );
    await this.ignoringFailure(async () => {
      try {
        await once();
      } catch {
        await once();
      }
    });
  }

  /**
   * After the Postgres commit: holds become confirmed markers, leave the held set, and the idempotency key is remembered.
   * @param show - Show id.
   * @param labels - Seats that were confirmed.
   * @param reservationId - Reservation that now owns them.
   * @param token - Owner token of the request.
   */
  async markSeatsConfirmed(show: string, labels: string[], reservationId: string, token: string): Promise<void> {
    await this.ignoringFailure(async () => {
      const m = this.client!.multi();
      m.set(idempotencyMarkerKey(show, token), reservationId, "EX", 24 * 3600);
      for (const l of labels) m.set(seatLockKey(show, l), `C|${reservationId}`, "EX", this.markerSeconds);
      m.zrem(heldSeatsKey(show), ...labels);
      await m.exec();
    });
  }

  /**
   * Postgres said these seats are taken: remember it so the next losers never reach Postgres.
   * @param show - Show id.
   * @param holders - Seat label to the reservation id that holds it.
   */
  async markSeatsTaken(show: string, holders: Record<string, string>): Promise<void> {
    await this.ignoringFailure(async () => {
      const m = this.client!.multi();
      for (const [l, resId] of Object.entries(holders)) m.set(seatLockKey(show, l), `C|${resId}`, "EX", this.markerSeconds);
      await m.exec();
    });
  }

  /**
   * After a cancel commits: clears the confirmed markers of that reservation, and only those, so a newer owner's marker is never erased.
   * @param show - Show id.
   * @param labels - Seats that were freed.
   * @param reservationId - The cancelled reservation.
   */
  async clearConfirmedMarkers(show: string, labels: string[], reservationId: string): Promise<void> {
    await this.ignoringFailure(() =>
      this.client!.releaseIfOwner(
        labels.length + 1,
        heldSeatsKey(show),
        ...labels.map((l) => seatLockKey(show, l)),
        `C|${reservationId}`,
        ...labels,
      ),
    );
  }

  /**
   * Seats of a show whose hold has not expired. Callers combine this with "available in Postgres".
   * If Redis is off or unreachable nothing is reported as held, which is safe: holds only ever decline.
   * @param show - Show id.
   */
  async listHeldSeats(show: string): Promise<string[]> {
    if (!this.client) return [];
    try {
      return await this.client.listLiveHolds(1, heldSeatsKey(show));
    } catch {
      this.events.emit("cache.error");
      return [];
    }
  }

  /**
   * Runs a Redis operation, swallowing failure: a request never fails because the cache failed, and holds and markers expire on their own.
   * @param fn - The Redis call.
   */
  /**
   * Held seats of many shows in a single Redis round trip, in the same order as `shows`.
   * Used by the metrics, which look at every show at once. Any failure reports nothing as held, like {@link SeatCache.listHeldSeats}.
   * @param shows - Show ids.
   */
  async listHeldSeatsForShows(shows: string[]): Promise<string[][]> {
    const none = () => shows.map(() => [] as string[]);
    if (!this.client || shows.length === 0) return none();
    try {
      const pipeline = this.client.pipeline() as unknown as {
        listLiveHolds(numKeys: number, ...args: string[]): unknown;
        exec(): Promise<Array<[Error | null, unknown]> | null>;
      };
      for (const show of shows) pipeline.listLiveHolds(1, heldSeatsKey(show));
      const results = await pipeline.exec();
      if (!results) return none();
      return shows.map((_, i) => {
        const [err, value] = results[i] ?? [new Error("missing"), undefined];
        return err || !Array.isArray(value) ? [] : (value as string[]);
      });
    } catch {
      this.events.emit("cache.error");
      return none();
    }
  }

  private async ignoringFailure(fn: () => Promise<unknown>): Promise<void> {
    if (!this.client) return;
    try {
      await fn();
    } catch {
      // Never fail a request because the cache failed; holds and markers expire on their own.
      this.events.emit("cache.error");
    }
  }
}
