import type pg from "pg";
import client from "prom-client";
import type { ShowStat, ShowStatsRepository } from "../database/repositories/showStatsRepository.js";

/** Reasons a reserve request is counted in `reservations_declined_total`. Pre-registered so each series exists at 0. */
export const DECLINE_REASONS = [
  "seat_taken",
  "per_user_limit",
  "idempotent_replay",
  "idempotency_key_conflict",
  "unknown_seat",
] as const;
/** One of {@link DECLINE_REASONS}. */
export type MetricDecline = (typeof DECLINE_REASONS)[number];

/** How many of the newest shows get per-show seat gauges, to keep metric cardinality bounded. */
const MAX_SHOWS_IN_GAUGES = 20;

/**
 * Builds the Prometheus registry: HTTP, reservation and Redis counters, pool gauges, and per-show seat gauges.
 * The seat gauges are not kept in memory; they are read from Postgres (plus Redis for held seats) at scrape time and cached for one second,
 * so they always reconcile with the API.
 * @param stats - Database access for the seat gauges.
 * @param pool - Main Postgres pool, whose connection counts are exported as a gauge.
 */
export function createMetrics(stats: ShowStatsRepository, pool: pg.Pool) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpRequests = new client.Counter({
    name: "http_requests_total",
    help: "HTTP requests by method, route and status",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const inflight = new client.Gauge({
    name: "http_requests_in_flight",
    help: "Requests currently being handled",
    registers: [registry],
  });
  const confirmed = new client.Counter({
    name: "reservations_confirmed_total",
    help: "Reservations confirmed (new, not replays)",
    registers: [registry],
  });
  const declined = new client.Counter({
    name: "reservations_declined_total",
    help: "Reserve requests declined, by reason",
    labelNames: ["reason"],
    registers: [registry],
  });
  for (const r of DECLINE_REASONS) declined.labels(r).inc(0);
  const cancelled = new client.Counter({
    name: "reservations_cancelled_total",
    help: "Reservations cancelled by their owner",
    registers: [registry],
  });

  const cacheDeclines = new client.Counter({
    name: "seat_cache_declines_total",
    help: "Reserve requests declined by Redis without touching Postgres (also counted in reservations_declined_total)",
    registers: [registry],
  });
  const cacheErrors = new client.Counter({
    name: "seat_cache_errors_total",
    help: "Redis errors; the request fell through to Postgres",
    registers: [registry],
  });

  // Held seats live in Redis, so the gauges ask it which available seats are currently held.
  let heldSource: { listHeldSeats(show: string): Promise<string[]> } | undefined;

  let statsCache: { at: number; promise: Promise<ShowStat[]> } | undefined;
  const loadShowSeatStats = (): Promise<ShowStat[]> => {
    const now = Date.now();
    if (statsCache && now - statsCache.at < 1000) return statsCache.promise;
    const promise = (async () => {
      const showIds = await stats.findRecentShowIds(MAX_SHOWS_IN_GAUGES);
      const heldShowIds: string[] = [];
      const heldLabels: string[] = [];
      if (heldSource) {
        const lists = await Promise.all(showIds.map((id) => heldSource!.listHeldSeats(id)));
        showIds.forEach((id, i) => {
          for (const label of lists[i]!) {
            heldShowIds.push(id);
            heldLabels.push(label);
          }
        });
      }
      return stats.findShowStats(showIds, heldShowIds, heldLabels);
    })();
    statsCache = { at: now, promise };
    promise.catch(() => {
      if (statsCache?.promise === promise) statsCache = undefined;
    });
    return promise;
  };

  const registerSeatGauge = (name: string, help: string, pick: (s: ShowStat) => number) =>
    new client.Gauge({
      name,
      help,
      labelNames: ["show_id"],
      registers: [registry],
      async collect() {
        this.reset();
        try {
          for (const s of await loadShowSeatStats()) this.labels(s.showId).set(pick(s));
        } catch {
          // DB unreachable: leave the gauge empty rather than failing the scrape.
        }
      },
    });

  registerSeatGauge("seats_available", "Seats currently available (read from Postgres at scrape time)", (s) => s.available);
  registerSeatGauge("seats_held", "Seats currently held", (s) => s.held);
  registerSeatGauge("seats_confirmed", "Seats currently confirmed", (s) => s.confirmed);
  registerSeatGauge("seats_total", "Total seats in the show", (s) => s.total);
  registerSeatGauge(
    "seats_reconciliation_drift",
    "total_seats - (available + held + confirmed); must always be 0",
    (s) => s.total - (s.available + s.held + s.confirmed),
  );

  new client.Gauge({
    name: "pg_pool_connections",
    help: "Postgres pool connections by state",
    labelNames: ["state"],
    registers: [registry],
    collect() {
      this.labels("total").set(pool.totalCount);
      this.labels("idle").set(pool.idleCount);
      this.labels("waiting").set(pool.waitingCount);
    },
  });

  return {
    /**
     * Supplies the source of held seats (Redis), which is created after the metrics and therefore wired in afterwards.
     * @param source - Object that can list the held seat labels of a show.
     */
    setHeldSeatsSource(source: { listHeldSeats(show: string): Promise<string[]> }) {
      heldSource = source;
    },
    registry,
    httpRequests,
    httpDuration,
    inflight,
    confirmed,
    declined,
    cancelled,
    cacheDeclines,
    cacheErrors,
  };
}

/** The object returned by {@link createMetrics}. */
export type Metrics = ReturnType<typeof createMetrics>;
