import type { FastifyInstance } from "fastify";
import { PING } from "../infrastructure/database/queries/system.js";
import type { Ctx } from "../bootstrap/context.js";

/**
 * Registers `GET /health`, the single health endpoint, with two probes.
 *
 * - `GET /health` (default, the readiness probe): runs `SELECT 1` on the dedicated pool and answers 200 when Postgres is reachable,
 *   503 when it is not (fails closed). Redis is reported in the body but never fails the probe.
 * - `GET /health?probe=live` (the liveness probe): answers 200 while the process is up, without touching any dependency, so a
 *   database outage drains traffic but never makes the platform restart a healthy process.
 * @param app - Fastify instance.
 * @param ctx - Shared dependencies.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get<{ Querystring: { probe?: "live" | "ready" } }>(
    "/health",
    { schema: { querystring: { type: "object", properties: { probe: { type: "string", enum: ["live", "ready"] } } } } },
    async (req, reply) => {
      if (req.query.probe === "live") return { status: "alive" };

      try {
        await ctx.healthPool.query(PING);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "readiness check failed: database unreachable");
        return reply.code(503).send({ status: "not_ready", checks: { database: "down", redis: ctx.cache.connectionStatus() } });
      }
      // Redis is an accelerator, not a dependency: reported, but it never gates readiness.
      return { status: "ready", checks: { database: "ok", redis: ctx.cache.connectionStatus() } };
    },
  );
}
