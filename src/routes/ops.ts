import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../bootstrap/context.js";
import { unauthorized } from "../common/errors.js";

/** Numeric severity of each pino level, used to filter `GET /logs` by minimum level. */
const LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/**
 * Constant-time comparison of a presented bearer token with the expected one.
 * @param given - Token from the request.
 * @param expected - Configured token.
 */
function bearerTokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Registers `GET /metrics` (Prometheus text) and `GET /logs` (recent structured log lines as NDJSON, newest last).
 * `/logs` is public unless `LOGS_TOKEN` is set, and can filter by `limit`, `level`, `request_id` and `path`.
 * @param app - Fastify instance.
 * @param ctx - Shared dependencies.
 */
export function registerOpsRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", ctx.metrics.registry.contentType);
    return ctx.metrics.registry.metrics();
  });

  // Recent structured log lines (ring buffer, per instance), newest last.
  // Public by default; set LOGS_TOKEN to require a bearer token.
  app.get<{ Querystring: { limit?: number; level?: string; request_id?: string; path?: string } }>(
    "/logs",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 5000, default: 200 },
            level: { type: "string", enum: Object.keys(LEVELS) },
            request_id: { type: "string", maxLength: 100 },
            path: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (ctx.config.logsToken) {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!bearerTokenMatches(token, ctx.config.logsToken)) throw unauthorized();
      }
      const { limit = 200, level, request_id, path } = req.query;
      const min = level ? LEVELS[level] ?? 0 : 0;
      let lines = ctx.ring.getRecentLines();
      if (request_id || path || min > 0) {
        lines = lines.filter((line) => {
          if (request_id && !line.includes(request_id)) return false;
          if (path && !line.includes(path)) return false;
          if (min > 0) {
            try {
              const parsed = JSON.parse(line) as { level?: string };
              if ((LEVELS[parsed.level ?? "info"] ?? 30) < min) return false;
            } catch {
              return false;
            }
          }
          return true;
        });
      }
      reply.header("content-type", "application/x-ndjson");
      return lines.slice(-limit).join("\n") + "\n";
    },
  );
}
