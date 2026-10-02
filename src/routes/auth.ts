import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth.js";
import { USER_ID_PATTERN } from "../auth.js";

export function authRoutes(app: FastifyInstance, auth: Auth): void {
  // Demo login: anyone can mint a token for a user id. Replace with a real IdP in production.
  app.post<{ Body: { user_id: string } }>(
    "/auth/token",
    {
      schema: {
        body: {
          type: "object",
          required: ["user_id"],
          properties: { user_id: { type: "string", pattern: USER_ID_PATTERN } },
        },
      },
    },
    async (req, reply) => {
      const token = auth.issueToken(req.body.user_id);
      return reply.code(201).send({ token, user_id: req.body.user_id, token_type: "Bearer", expires_in: 86400 });
    },
  );
}
