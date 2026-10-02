import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth.js";
import { badRequest } from "../errors.js";
import type { ReservationService } from "../services/reservations.js";

const SEAT_LABEL_PATTERN = "^[A-Za-z0-9_.-]{1,32}$";

export function reservationRoutes(app: FastifyInstance, auth: Auth, reservations: ReservationService): void {
  app.post<{ Params: { id: string }; Body: { seats: string[]; idempotency_key?: string } }>(
    "/shows/:id/reserve",
    {
      schema: {
        body: {
          type: "object",
          required: ["seats"],
          properties: {
            seats: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", pattern: SEAT_LABEL_PATTERN } },
            idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      // Identity is taken from the verified token only; any user id in the body is ignored.
      const userId = auth.requireUser(req);
      const headerKey = req.headers["idempotency-key"];
      const bodyKey = req.body.idempotency_key;
      if (typeof headerKey === "string" && bodyKey !== undefined && headerKey !== bodyKey) {
        throw badRequest("Idempotency-Key header and idempotency_key body field disagree");
      }
      const idempotencyKey = typeof headerKey === "string" && headerKey ? headerKey : bodyKey;
      if (!idempotencyKey || idempotencyKey.length > 200) {
        throw badRequest("an idempotency key is required (Idempotency-Key header or idempotency_key field)");
      }
      try {
        const { replay, reservation } = await reservations.reserve({
          userId,
          showId: req.params.id,
          seats: req.body.seats,
          idempotencyKey,
        });
        if (replay) {
          // A retry returns the original reservation and moves nothing.
          req.outcome = "idempotent_replay";
          return reply.code(200).header("idempotent-replayed", "true").send(reservation);
        }
        req.outcome = "confirmed";
        return reply.code(201).send(reservation);
      } catch (err) {
        if (err instanceof Error && "reason" in err) req.outcome = (err as { reason: string }).reason;
        throw err;
      }
    },
  );
}
