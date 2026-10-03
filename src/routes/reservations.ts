import type { FastifyInstance } from "fastify";
import type { Auth } from "../security/auth.js";
import { badRequest } from "../common/errors.js";
import type { ReservationService } from "../services/reservations.js";

/** A seat label is 1 to 32 characters of letters, digits, `_`, `.` or `-`. */
const SEAT_LABEL_PATTERN = "^[A-Za-z0-9_.-]{1,32}$";

/**
 * Registers `POST /shows/:id/reserve` (201 new, 200 idempotent replay, 409 clean decline) and `POST /reservations/:id/cancel` (owner only;
 * a repeat cancel returns 200 with an `Idempotent-Replayed: true` header and changes nothing).
 * The user id always comes from the verified token; one in the body is ignored. The idempotency key may be a header or a body field.
 * @param app - Fastify instance.
 * @param auth - User authentication.
 * @param reservations - Reservation service.
 */
export function registerReservationRoutes(app: FastifyInstance, auth: Auth, reservations: ReservationService): void {
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
        const { replay, reservation } = await reservations.reserveSeats({
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

  app.post<{ Params: { id: string } }>("/reservations/:id/cancel", async (req, reply) => {
    const userId = auth.requireUser(req);
    const { changed, reservation } = await reservations.cancelReservation(userId, req.params.id);
    req.outcome = changed ? "cancelled" : "already_cancelled";
    if (!changed) reply.header("idempotent-replayed", "true");
    return reply.code(200).send(reservation);
  });
}
