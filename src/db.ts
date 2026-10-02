import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Config } from "./config.js";
import { unavailable } from "./errors.js";

// bigint columns (money in paise, counts) stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.PoolClient;

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    // Requests queue for a connection rather than failing fast under a burst.
    connectionTimeoutMillis: 60_000,
    idleTimeoutMillis: 30_000,
    ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", () => {
    // Idle client errors (e.g. DB restart) are surfaced on the next query.
  });
  return pool;
}

// Separate tiny pool so readiness reflects "is the DB reachable" and not
// "is the main pool saturated by a burst".
export function createHealthPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    idleTimeoutMillis: 30_000,
    ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", () => {});
  return pool;
}

const RETRYABLE = new Set(["40001", "40P01"]);

export function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (!e) return false;
  if (e.code && (e.code.startsWith("08") || e.code.startsWith("57") || e.code === "53300")) return true;
  if (e.code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(e.code)) return true;
  const m = e.message ?? "";
  return (
    m.includes("timeout exceeded when trying to connect") ||
    m.includes("Connection terminated") ||
    m.includes("Client has encountered a connection error")
  );
}

/**
 * Runs fn inside a transaction (READ COMMITTED). Serialization failures and
 * deadlocks are retried; connection problems become a 503 (fail closed).
 */
export async function withTx<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      if (isConnectionError(err)) throw unavailable("database unavailable");
      throw err;
    }
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
        continue;
      }
      if (isConnectionError(err)) {
        broken = true;
        throw unavailable("database unavailable");
      }
      throw err;
    } finally {
      client.release(broken ? true : undefined);
    }
  }
}

export async function migrate(pool: pg.Pool, dir: string, log?: { info: (o: object, m: string) => void }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      log?.info({ migration: file }, "migration applied");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}

export async function waitForDb(pool: pg.Pool, attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
