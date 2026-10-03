import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/bootstrap/app.js";
import { loadConfig, type Config } from "../src/config/config.js";
import type { Ctx } from "../src/bootstrap/context.js";
import { createReadinessPool, createMainPool, applyMigrations } from "../src/infrastructure/database/connection.js";
import { LogRing, createLogger } from "../src/infrastructure/logging/logger.js";
import { createMetrics } from "../src/infrastructure/metrics/metrics.js";
import { SeatCache } from "../src/infrastructure/cache/seatCache.js";
import { EventBus } from "../src/infrastructure/events/eventBus.js";
import { ShowStatsRepository } from "../src/infrastructure/database/repositories/showStatsRepository.js";

/** Admin token the test app is configured with. */
export const ADMIN_TOKEN = "test-admin-token";

// Idempotency keys are scoped per user and the test DB persists across runs,
// so namespace every key with a per-process run id.
const RUN_ID = Math.random().toString(36).slice(2, 10);

export interface TestApp {
  app: FastifyInstance;
  ctx: Ctx;
  config: Config;
  close(): Promise<void>;
  token(userId: string): Promise<string>;
  createShow(seats: string[], opts?: { price_paise?: number; per_user_limit?: number }): Promise<ShowBody>;
  reserve(token: string, showId: string, seats: string[], key: string, extra?: Record<string, unknown>): Promise<Res>;
  key(k: string): string;
  cancel(token: string, reservationId: string): Promise<Res>;
  show(showId: string, seats?: boolean): Promise<ShowBody>;
}

export interface Res {
  status: number;
  body: any;
}

export interface ShowBody {
  id: string;
  total_seats: number;
  available: number;
  held: number;
  confirmed: number;
  seats?: { seat: string; status: string }[];
  [k: string]: any;
}

/**
 * Boots the app against the real Postgres and Redis test services.
 * @param env - Config overrides, for example `SEAT_HOLD_SECONDS` or `REDIS_URL`.
 * @returns A test harness with helpers to mint tokens, create shows, reserve and cancel.
 */
export async function makeApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://seats:seats@localhost:5433/seats",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6380",
    REDIS_ENABLED: "true",
    JWT_SECRET: "test-jwt-secret",
    ADMIN_TOKEN,
    LOG_LEVEL: "silent",
    PG_POOL_MAX: "20",
    ...env,
  });
  const pool = createMainPool(config);
  const healthPool = createReadinessPool(config);
  await applyMigrations(pool, config.migrationsDir);
  const ring = new LogRing(1000);
  const log = createLogger(config.logLevel, ring);
  const events = new EventBus();
  const metrics = createMetrics(new ShowStatsRepository(pool), pool, config.metricsMaxShows);
  const cache = new SeatCache(config, events);
  await cache.waitUntilReady(1500);
  const ctx: Ctx = {
    config,
    pool,
    healthPool,
    metrics,
    cache,
    events,
    ring,
    log,
  };
  const app = await buildApp(ctx);
  await app.ready();

  const call = async (
    method: "GET" | "POST",
    url: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Res> => {
    const res = await app.inject({
      method,
      url,
      payload: opts.body as object | undefined,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    });
    let body: any = res.body;
    try {
      body = JSON.parse(res.body);
    } catch {
      /* non-JSON body */
    }
    return { status: res.statusCode, body };
  };

  const t: TestApp = {
    app,
    ctx,
    config,
    async close() {
      await app.close();
      await pool.end();
      await healthPool.end();
      await cache.close();
    },
    async token(userId) {
      const r = await call("POST", "/auth/token", { body: { user_id: userId } });
      return r.body.token as string;
    },
    async createShow(seats, opts = {}) {
      const r = await call("POST", "/shows", {
        token: ADMIN_TOKEN,
        body: { name: "test-show", seats, price_paise: opts.price_paise ?? 25000, ...opts },
      });
      if (r.status !== 201) throw new Error(`create show failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as ShowBody;
    },
    key: (k) => `${RUN_ID}:${k}`,
    reserve: (token, showId, seats, key, extra = {}) =>
      call("POST", `/shows/${showId}/reserve`, { token, body: { seats, idempotency_key: `${RUN_ID}:${key}`, ...extra } }),
    cancel: (token, id) => call("POST", `/reservations/${id}/cancel`, { token }),
    async show(showId, seats = true) {
      const r = await call("GET", `/shows/${showId}?seats=${seats}`);
      return r.body as ShowBody;
    },
  };
  return t;
}

/**
 * Builds labels like `A1` to `An`.
 * @param prefix - Label prefix.
 * @param n - Count.
 */
export const seatNames = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/**
 * Throws unless `available + held + confirmed == total_seats`.
 * @param s - A show as returned by the API.
 */
export function assertReconciled(s: ShowBody): void {
  if (s.available + s.held + s.confirmed !== s.total_seats) {
    throw new Error(`invariant violated: ${JSON.stringify({ a: s.available, h: s.held, c: s.confirmed, t: s.total_seats })}`);
  }
}
