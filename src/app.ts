import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { isConnectionError } from "./db.js";
import { healthRoutes } from "./routes/health.js";
import { opsRoutes } from "./routes/ops.js";
import { authRoutes } from "./routes/auth.js";
import { showRoutes } from "./routes/shows.js";
import { createAuth } from "./auth.js";
import { ShowService } from "./services/shows.js";

declare module "fastify" {
  interface FastifyRequest {
    startedAt: bigint;
    userId?: string;
    outcome?: string;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && REQUEST_ID_RE.test(given) ? given : randomUUID();
    },
    bodyLimit: 8 * 1024 * 1024,
    connectionTimeout: 0,
    keepAliveTimeout: 65_000,
    requestTimeout: 0,
  });

  app.decorateRequest("startedAt", 0n);

  app.addHook("onRequest", async (req, reply) => {
    req.startedAt = process.hrtime.bigint();
    reply.header("x-request-id", req.id);
    ctx.metrics.inflight.inc();
    reply.raw.once("close", () => ctx.metrics.inflight.dec());
  });

  app.addHook("onResponse", async (req, reply) => {
    const seconds = Number(process.hrtime.bigint() - req.startedAt) / 1e9;
    const route = req.routeOptions.url ?? "unmatched";
    ctx.metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    ctx.metrics.httpDuration.observe({ method: req.method, route }, seconds);
    if (route === "/healthz" || route === "/metrics" || route === "/logs") return;
    req.log.info(
      {
        method: req.method,
        route,
        path: req.url.split("?")[0],
        status: reply.statusCode,
        duration_ms: Math.round(seconds * 1000 * 100) / 100,
        user_id: req.userId,
        outcome: req.outcome,
      },
      "request completed",
    );
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      req.outcome ??= err.code;
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, request_id: requestId, ...err.details },
      });
    }
    if (err.validation) {
      req.outcome = "invalid_request";
      return reply
        .code(400)
        .send({ error: { code: "invalid_request", message: err.message, request_id: requestId } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      req.outcome = "invalid_request";
      return reply
        .code(err.statusCode)
        .send({ error: { code: "invalid_request", message: err.message, request_id: requestId } });
    }
    if (isConnectionError(err)) {
      req.log.error({ err: err.message }, "database unavailable");
      req.outcome = "service_unavailable";
      return reply
        .code(503)
        .send({ error: { code: "service_unavailable", message: "database unavailable", request_id: requestId } });
    }
    req.log.error({ err }, "unhandled error");
    req.outcome = "internal_error";
    return reply
      .code(500)
      .send({ error: { code: "internal_error", message: "internal error", request_id: requestId } });
  });

  app.setNotFoundHandler((req, reply) => {
    req.outcome = "not_found";
    return reply
      .code(404)
      .send({ error: { code: "not_found", message: "route not found", request_id: req.id } });
  });

  const auth = createAuth(ctx.config);
  const shows = new ShowService(ctx.pool, ctx.config);

  healthRoutes(app, ctx);
  opsRoutes(app, ctx);
  authRoutes(app, auth);
  showRoutes(app, auth, shows);
  return app;
}
