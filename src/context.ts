import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Config } from "./config.js";
import type { LogRing } from "./logger.js";
import type { Metrics } from "./metrics.js";

export interface Ctx {
  config: Config;
  pool: pg.Pool;
  healthPool: pg.Pool;
  metrics: Metrics;
  ring: LogRing;
  log: FastifyBaseLogger;
}
