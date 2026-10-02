import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { Ctx } from "./context.js";
import { createHealthPool, createPool, migrate, waitForDb } from "./db.js";
import { LogRing, createLogger } from "./logger.js";
import { createMetrics } from "./metrics.js";

const config = loadConfig();
const ring = new LogRing(5000);
const log = createLogger(config.logLevel, ring);
const pool = createPool(config);
const healthPool = createHealthPool(config);

const ctx: Ctx = {
  config,
  pool,
  healthPool,
  metrics: createMetrics(pool),
  ring,
  log,
  redisStatus: () => "disabled",
};

const app = await buildApp(ctx);

// Listen first so the platform sees the port open; /readyz stays 503 until the DB answers.
await app.listen({ port: config.port, host: "0.0.0.0", backlog: 4096 });

try {
  await waitForDb(pool);
  await migrate(pool, config.migrationsDir, log);
  log.info("database ready, migrations applied");
} catch (err) {
  log.fatal({ err }, "could not reach database or apply migrations");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    log.info({ signal }, "shutting down");
    await app.close();
    await Promise.allSettled([pool.end(), healthPool.end()]);
    process.exit(0);
  });
}
