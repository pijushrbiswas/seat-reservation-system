import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth.js";
import type { ReservationService } from "../services/reservations.js";

const SEAT_LABEL_PATTERN = "^[A-Za-z0-9_.-]{1,32}$";

export function reservationRoutes(app: FastifyInstance, auth: Auth, reservations: ReservationService): void {
  app.post<{ Params: { id: string }; Body: { seats: string[] } }>(
    "/shows/:id/reserve",
    {
      schema: {
        body: {
          type: "object",
          required: ["seats"],
          properties: {
            seats: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", pattern: SEAT_LABEL_PATTERN } },
          },
        },
      },
    },
    async (req, reply) => {
      // Identity is taken from the verified token only; any user id in the body is ignored.
      const userId = auth.requireUser(req);
      try {
        const { reservation } = await reservations.reserve({
          userId,
          showId: req.params.id,
          seats: req.body.seats,
        });
        req.outcome = "confirmed";
        return reply.code(201).send(reservation);
      } catch (err) {
        if (err instanceof Error && "reason" in err) req.outcome = (err as { reason: string }).reason;
        throw err;
      }
    },
  );
}
