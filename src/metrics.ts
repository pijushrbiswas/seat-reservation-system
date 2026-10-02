import type pg from "pg";
import client from "prom-client";

export const DECLINE_REASONS = [
  "seat_taken",
  "per_user_limit",
  "idempotent_replay",
  "idempotency_key_conflict",
  "unknown_seat",
] as const;
export type MetricDecline = (typeof DECLINE_REASONS)[number];

const MAX_SHOWS_IN_GAUGES = 20;

interface ShowStat {
  showId: string;
  total: number;
  available: number;
  held: number;
  confirmed: number;
}

export function createMetrics(pool: pg.Pool) {
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

  let statsCache: { at: number; promise: Promise<ShowStat[]> } | undefined;
  const loadStats = (): Promise<ShowStat[]> => {
    const now = Date.now();
    if (statsCache && now - statsCache.at < 1000) return statsCache.promise;
    const promise = pool
      .query<{ show_id: string; total_seats: number; available: string; held: string; confirmed: string }>(
        `SELECT sh.id AS show_id, sh.total_seats,
                count(*) FILTER (WHERE s.status = 'available') AS available,
                count(*) FILTER (WHERE s.status = 'held') AS held,
                count(*) FILTER (WHERE s.status = 'confirmed') AS confirmed
           FROM (SELECT id, total_seats FROM shows ORDER BY created_at DESC LIMIT ${MAX_SHOWS_IN_GAUGES}) sh
           LEFT JOIN seats s ON s.show_id = sh.id
          GROUP BY sh.id, sh.total_seats`,
      )
      .then((r) =>
        r.rows.map((row) => ({
          showId: row.show_id,
          total: row.total_seats,
          available: Number(row.available),
          held: Number(row.held),
          confirmed: Number(row.confirmed),
        })),
      );
    statsCache = { at: now, promise };
    promise.catch(() => {
      if (statsCache?.promise === promise) statsCache = undefined;
    });
    return promise;
  };

  const seatGauge = (name: string, help: string, pick: (s: ShowStat) => number) =>
    new client.Gauge({
      name,
      help,
      labelNames: ["show_id"],
      registers: [registry],
      async collect() {
        this.reset();
        try {
          for (const s of await loadStats()) this.labels(s.showId).set(pick(s));
        } catch {
          // DB unreachable: leave the gauge empty rather than failing the scrape.
        }
      },
    });

  seatGauge("seats_available", "Seats currently available (read from Postgres at scrape time)", (s) => s.available);
  seatGauge("seats_held", "Seats currently held", (s) => s.held);
  seatGauge("seats_confirmed", "Seats currently confirmed", (s) => s.confirmed);
  seatGauge("seats_total", "Total seats in the show", (s) => s.total);
  seatGauge(
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

  return { registry, httpRequests, httpDuration, inflight, confirmed, declined, cancelled };
}

export type Metrics = ReturnType<typeof createMetrics>;
