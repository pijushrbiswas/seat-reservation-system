import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Config } from "../config/config.js";
import type { LogRing } from "../infrastructure/logging/logger.js";
import type { Metrics } from "../infrastructure/metrics/metrics.js";
import type { SeatCache } from "../infrastructure/cache/seatCache.js";
import type { EventBus } from "../infrastructure/events/eventBus.js";

/** Shared dependencies created once at startup and handed to the app and its routes. */
export interface Ctx {
  /** Validated application settings. */
  config: Config;
  /** Main Postgres pool used by all request handling. */
  pool: pg.Pool;
  /** Small separate pool used only by the `/health` readiness probe, so readiness is not starved by a burst. */
  healthPool: pg.Pool;
  /** Prometheus registry and counters. */
  metrics: Metrics;
  /** In-memory buffer of recent log lines, served by `GET /logs`. */
  ring: LogRing;
  /** Structured logger. */
  log: FastifyBaseLogger;
  /** Redis seat lock and held-state layer (a no-op when Redis is off). */
  cache: SeatCache;
  /** Bus where services announce outcomes; metrics subscribe to it. */
  events: EventBus;
}
