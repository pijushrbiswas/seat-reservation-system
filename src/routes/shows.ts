import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth.js";
import type { ShowService } from "../services/shows.js";

const SEAT_LABEL_PATTERN = "^[A-Za-z0-9_.-]{1,32}$";

export function showRoutes(app: FastifyInstance, auth: Auth, shows: ShowService): void {
  app.post<{ Body: { name: string; seats: string[]; price_paise: number; per_user_limit?: number } }>(
    "/shows",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "seats", "price_paise"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            seats: {
              type: "array",
              minItems: 1,
              maxItems: 100_000,
              items: { type: "string", pattern: SEAT_LABEL_PATTERN },
            },
            price_paise: { type: "integer", minimum: 0, maximum: 1_000_000_000_000 },
            per_user_limit: { type: "integer", minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    async (req, reply) => {
      auth.requireAdmin(req);
      const show = await shows.create(req.body);
      return reply.code(201).send(show);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { seats?: boolean } }>(
    "/shows/:id",
    {
      schema: {
        querystring: { type: "object", properties: { seats: { type: "boolean", default: true } } },
      },
    },
    async (req) => shows.get(req.params.id, req.query.seats ?? true),
  );
}
