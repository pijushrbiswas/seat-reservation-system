/**
 * Reads an integer setting from the environment.
 * @param env - Environment variables to read from.
 * @param name - Variable name.
 * @param fallback - Value used when the variable is unset or empty.
 * @throws If the variable is set but is not an integer.
 */
function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

/**
 * Reads a boolean setting from the environment; only `true` or `1` count as true.
 * @param env - Environment variables to read from.
 * @param name - Variable name.
 * @param fallback - Value used when the variable is unset or empty.
 */
function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

/** Validated, typed application settings. Everything comes from environment variables. */
export interface Config {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Postgres connection string (required). */
  databaseUrl: string;
  /** Redis connection string; when unset Redis is off and Postgres decides alone. */
  redisUrl: string | undefined;
  /** True only when Redis is enabled and a URL was supplied. */
  redisEnabled: boolean;
  /** Lifetime in seconds of a "confirmed" marker in Redis; it heals itself when it expires. */
  seatCacheTtlSeconds: number;
  /** Lifetime in seconds of a seat hold in Redis before it expires on its own. */
  seatHoldSeconds: number;
  /** HMAC secret used to sign and verify user tokens (required). */
  jwtSecret: string;
  /** Bearer token that authorises admin endpoints such as creating a show (required). */
  adminToken: string;
  /** When set, `GET /logs` requires this bearer token. */
  logsToken: string | undefined;
  /** Minimum log level (pino level name). */
  logLevel: string;
  /** How many recent log lines are kept in memory for `GET /logs`; the oldest is dropped first. */
  logBufferLines: number;
  /** Loki push URL; when set, every log line is also pushed there (used on Render, where no log agent can read stdout). */
  lokiUrl: string | undefined;
  /** Bearer token sent to Loki with each push. */
  lokiToken: string | undefined;
  /** How many shows get per-show seat gauges (newest first); 0 means every show. */
  metricsMaxShows: number;
  /** How long per-show seat gauges and `GET /stats` reuse one database read, in seconds. */
  metricsCacheSeconds: number;
  /** How long `GET /shows/:id` reuses a read, in milliseconds; 0 turns it off. A reserve or cancel on this instance clears it at once. */
  showStateCacheMs: number;
  /** Maximum connections in the main Postgres pool. */
  pgPoolMax: number;
  /** Whether to connect to Postgres over TLS. */
  pgSsl: boolean;
  /** Seats one user may hold per show when the show does not set its own limit. */
  defaultPerUserLimit: number;
  /** Directory containing the plain SQL migration files. */
  migrationsDir: string;
}

/**
 * Builds the application config from environment variables.
 * @param env - Environment to read; defaults to `process.env` (tests pass their own).
 * @returns The validated config.
 * @throws If `DATABASE_URL`, `JWT_SECRET` or `ADMIN_TOKEN` is missing, or a numeric setting is not an integer.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET is required");
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) throw new Error("ADMIN_TOKEN is required");
  const redisUrl = env.REDIS_URL || undefined;
  return {
    port: int(env, "PORT", 8080),
    databaseUrl,
    redisUrl,
    redisEnabled: bool(env, "REDIS_ENABLED", true) && redisUrl !== undefined,
    seatCacheTtlSeconds: int(env, "SEAT_CACHE_TTL_SECONDS", 30),
    seatHoldSeconds: int(env, "SEAT_HOLD_SECONDS", 300),
    jwtSecret,
    adminToken,
    logsToken: env.LOGS_TOKEN || undefined,
    logLevel: env.LOG_LEVEL ?? "info",
    logBufferLines: int(env, "LOG_BUFFER_LINES", 50_000),
    lokiUrl: env.LOKI_URL || undefined,
    lokiToken: env.LOKI_TOKEN || undefined,
    metricsMaxShows: int(env, "METRICS_MAX_SHOWS", 0),
    metricsCacheSeconds: int(env, "METRICS_CACHE_SECONDS", 10),
    showStateCacheMs: int(env, "SHOW_STATE_CACHE_MS", 0),
    pgPoolMax: int(env, "PG_POOL_MAX", 20),
    pgSsl: bool(env, "PG_SSL", false),
    defaultPerUserLimit: int(env, "DEFAULT_PER_USER_LIMIT", 4),
    migrationsDir: env.MIGRATIONS_DIR ?? "migrations",
  };
}
