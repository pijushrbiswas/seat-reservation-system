import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { createSigner, createVerifier } from "fast-jwt";
import type { Config } from "./config.js";
import { forbidden, unauthorized } from "./errors.js";

export const USER_ID_PATTERN = "^[A-Za-z0-9_.@-]{1,64}$";
const USER_ID_RE = new RegExp(USER_ID_PATTERN);
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const digest = (s: string) => createHash("sha256").update(s).digest();

export interface Auth {
  issueToken(userId: string): string;
  requireUser(req: FastifyRequest): string;
  requireAdmin(req: FastifyRequest): void;
}

export function createAuth(config: Config): Auth {
  const sign = createSigner({ key: config.jwtSecret, algorithm: "HS256", expiresIn: TOKEN_TTL_MS });
  const verify = createVerifier({ key: config.jwtSecret, algorithms: ["HS256"], cache: 10_000 });
  const adminDigest = digest(config.adminToken);

  const bearer = (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) throw unauthorized();
    const token = header.slice(7).trim();
    if (!token) throw unauthorized();
    return token;
  };

  return {
    issueToken: (userId) => sign({ sub: userId, role: "user" }),

    // Identity comes exclusively from the verified token, never from the body.
    requireUser(req) {
      const token = bearer(req);
      try {
        const payload = verify(token) as { sub?: unknown; role?: unknown };
        if (payload.role !== "user" || typeof payload.sub !== "string" || !USER_ID_RE.test(payload.sub)) {
          throw unauthorized("invalid token");
        }
        req.userId = payload.sub;
        return payload.sub;
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 401) throw err;
        throw unauthorized("invalid or expired token");
      }
    },

    requireAdmin(req) {
      const token = bearer(req);
      if (!timingSafeEqual(digest(token), adminDigest)) {
        throw forbidden("admin access required");
      }
    },
  };
}
