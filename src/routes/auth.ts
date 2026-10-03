import type { FastifyInstance } from "fastify";
import type { Auth } from "../security/auth.js";
import { USER_ID_PATTERN } from "../security/auth.js";

/**
 * Registers `POST /auth/token`, a demo login that mints a user token for any valid user id.
 * @param app - Fastify instance.
 * @param auth - Token issuer.
 */
export function registerAuthRoutes(app: FastifyInstance, auth: Auth): void {
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
