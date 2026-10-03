import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { createSigner, createVerifier } from "fast-jwt";
import type { Config } from "../config/config.js";
import { forbidden, unauthorized } from "../common/errors.js";

/** Regular expression source (also used in JSON schemas) for a valid user id. */
export const USER_ID_PATTERN = "^[A-Za-z0-9_.@-]{1,64}$";
/** Compiled form of {@link USER_ID_PATTERN}. */
const USER_ID_RE = new RegExp(USER_ID_PATTERN);
/** How long an issued user token stays valid (24 hours). */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** SHA-256 of a string; comparing digests keeps `timingSafeEqual` inputs the same length. */
const sha256Digest = (s: string) => createHash("sha256").update(s).digest();

/** Authentication operations used by the routes. */
export interface Auth {
  /**
   * Signs a 24-hour user token for a user id (demo login; replace with a real identity provider).
   * @param userId - Id to put in the token's `sub` claim.
   */
  issueToken(userId: string): string;
  /**
   * Verifies the bearer token and returns the user it names. Identity comes only from the token, never from the body.
   * @throws 401 if the token is missing, invalid or expired.
   */
  requireUser(req: FastifyRequest): string;
  /**
   * Checks the bearer token against the admin token in constant time.
   * @throws 401 if no token is sent, 403 if it is wrong.
   */
  requireAdmin(req: FastifyRequest): void;
}

/**
 * Creates the token signer/verifier and the admin check.
 * @param config - Supplies the JWT secret and admin token.
 */
export function createAuth(config: Config): Auth {
  const sign = createSigner({ key: config.jwtSecret, algorithm: "HS256", expiresIn: TOKEN_TTL_MS });
  const verify = createVerifier({ key: config.jwtSecret, algorithms: ["HS256"], cache: 10_000 });
  const adminDigest = sha256Digest(config.adminToken);

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
      if (!timingSafeEqual(sha256Digest(token), adminDigest)) {
        throw forbidden("admin access required");
      }
    },
  };
}
