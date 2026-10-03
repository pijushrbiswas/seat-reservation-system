import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Ctx } from "./context.js";
import { AppError } from "../common/errors.js";
import { isDatabaseUnreachable } from "../infrastructure/database/connection.js";
import { registerHealthRoutes } from "../routes/health.js";
import { registerOpsRoutes } from "../routes/ops.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerShowRoutes } from "../routes/shows.js";
import { registerReservationRoutes } from "../routes/reservations.js";
import { createAuth } from "../security/auth.js";
import { attachMetricsListeners } from "../infrastructure/metrics/metricsListener.js";
import { ReservationRepository } from "../infrastructure/database/repositories/reservationRepository.js";
import { ShowRepository } from "../infrastructure/database/repositories/showRepository.js";
import { ReservationService } from "../services/reservations.js";
import { ShowService } from "../services/shows.js";

declare module "fastify" {
  interface FastifyRequest {
    startedAt: bigint;
    userId?: string;
    outcome?: string;
  }
}

/** A caller-supplied `x-request-id` is honoured only if it is short and made of safe characters. */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Builds the Fastify app: request ids, metrics and logging hooks, one error handler for a uniform JSON error shape, and all routes.
 * @param ctx - Shared dependencies (config, pools, metrics, logger, cache).
 * @returns A ready-to-listen Fastify instance (tests use `inject` without listening).
 */
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
    if (isDatabaseUnreachable(err)) {
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

  ctx.metrics.setHeldSeatsSource(ctx.cache);
  const auth = createAuth(ctx.config);
  attachMetricsListeners(ctx.events, ctx.metrics);
  const shows = new ShowService(new ShowRepository(ctx.pool), ctx.config, ctx.cache);
  const reservations = new ReservationService(new ReservationRepository(ctx.pool), shows, ctx.cache, ctx.events);

  registerHealthRoutes(app, ctx);
  registerOpsRoutes(app, ctx);
  registerAuthRoutes(app, auth);
  registerShowRoutes(app, auth, shows);
  registerReservationRoutes(app, auth, reservations);
  return app;
}
