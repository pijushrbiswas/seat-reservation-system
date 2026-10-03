import type { FastifyInstance } from "fastify";
import { PING } from "../infrastructure/database/queries/system.js";
import type { Ctx } from "../bootstrap/context.js";

/**
 * Registers `GET /healthz` (liveness: the process is up) and `GET /readyz` (readiness: `SELECT 1` on the dedicated pool; 503 when Postgres is down).
 * Redis is reported in the body but never fails readiness.
 * @param app - Fastify instance.
 * @param ctx - Shared dependencies.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (req, reply) => {
    try {
      await ctx.healthPool.query(PING);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "readiness check failed: database unreachable");
      return reply.code(503).send({ status: "not_ready", checks: { database: "down", redis: ctx.cache.connectionStatus() } });
    }
    // Redis is an accelerator, not a dependency: reported, but it never gates readiness.
    return { status: "ready", checks: { database: "ok", redis: ctx.cache.connectionStatus() } };
  });
}
