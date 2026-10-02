function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export interface Config {
  port: number;
  databaseUrl: string;
  redisUrl: string | undefined;
  redisEnabled: boolean;
  jwtSecret: string;
  adminToken: string;
  logsToken: string | undefined;
  logLevel: string;
  pgPoolMax: number;
  pgSsl: boolean;
  defaultPerUserLimit: number;
  migrationsDir: string;
  seatCacheTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET is required");
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) throw new Error("ADMIN_TOKEN is required");
  const redisUrl = env.REDIS_URL || undefined;
  return {
    port: int("PORT", 8080),
    databaseUrl,
    redisUrl,
    redisEnabled: bool("REDIS_ENABLED", true) && redisUrl !== undefined,
    jwtSecret,
    adminToken,
    logsToken: env.LOGS_TOKEN || undefined,
    logLevel: env.LOG_LEVEL ?? "info",
    pgPoolMax: int("PG_POOL_MAX", 20),
    pgSsl: bool("PG_SSL", false),
    defaultPerUserLimit: int("DEFAULT_PER_USER_LIMIT", 4),
    migrationsDir: env.MIGRATIONS_DIR ?? "migrations",
    seatCacheTtlSeconds: int("SEAT_CACHE_TTL_SECONDS", 30),
  };
}
