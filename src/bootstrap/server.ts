import { buildApp } from "./app.js";
import { loadConfig } from "../config/config.js";
import type { Ctx } from "./context.js";
import { createReadinessPool, createMainPool, applyMigrations, waitUntilDatabaseReady } from "../infrastructure/database/connection.js";
import { LogRing, createLogger } from "../infrastructure/logging/logger.js";
import { createMetrics } from "../infrastructure/metrics/metrics.js";
import { SeatCache } from "../infrastructure/cache/seatCache.js";
import { EventBus } from "../infrastructure/events/eventBus.js";
import { ShowStatsRepository } from "../infrastructure/database/repositories/showStatsRepository.js";

/**
 * Process entry point: builds dependencies, starts listening first (so the platform sees the port open while `/readyz` is still 503),
 * then waits for Postgres, applies migrations, and shuts down cleanly on SIGINT/SIGTERM.
 */
const config = loadConfig();
const ring = new LogRing(5000);
const log = createLogger(config.logLevel, ring);
const pool = createMainPool(config);
const healthPool = createReadinessPool(config);

const events = new EventBus();
const metrics = createMetrics(new ShowStatsRepository(pool), pool);
const cache = new SeatCache(config, events, log);

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

// Listen first so the platform sees the port open; /readyz stays 503 until the DB answers.
await app.listen({ port: config.port, host: "0.0.0.0", backlog: 4096 });

try {
  await waitUntilDatabaseReady(pool);
  await applyMigrations(pool, config.migrationsDir, log);
  log.info("database ready, migrations applied");
} catch (err) {
  log.fatal({ err }, "could not reach database or apply migrations");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    log.info({ signal }, "shutting down");
    await app.close();
    await Promise.allSettled([pool.end(), healthPool.end(), cache.close()]);
    process.exit(0);
  });
}
