import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.js";

export function healthRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (req, reply) => {
    try {
      await ctx.healthPool.query("SELECT 1");
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "readiness check failed: database unreachable");
      return reply.code(503).send({ status: "not_ready", checks: { database: "down" } });
    }
    return { status: "ready", checks: { database: "ok" } };
  });
}
