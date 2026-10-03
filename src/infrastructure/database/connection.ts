import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Config } from "../../config/config.js";
import { unavailable } from "../../common/errors.js";
import {
  BEGIN,
  COMMIT,
  CREATE_MIGRATIONS_TABLE,
  INSERT_MIGRATION,
  MIGRATION_LOCK,
  MIGRATION_UNLOCK,
  PING,
  ROLLBACK,
  SELECT_APPLIED_MIGRATIONS,
} from "./queries/system.js";

// bigint columns (money in paise, counts) stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

/** A single checked-out Postgres connection, as passed to a transaction callback. */
export type Db = pg.PoolClient;

/**
 * Creates the main Postgres pool. Requests queue for a connection rather than failing fast, so a burst waits its turn.
 * @param config - Supplies the URL, pool size and TLS setting.
 */
export function createMainPool(config: Config): pg.Pool {
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

/**
 * Creates a tiny separate pool for readiness checks, so `/readyz` reflects "is the database reachable" and not "is the main pool saturated".
 * @param config - Supplies the URL and TLS setting.
 */
export function createReadinessPool(config: Config): pg.Pool {
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

/** Postgres error codes that are safe to retry: serialization failure (40001) and deadlock (40P01). */
const RETRYABLE = new Set(["40001", "40P01"]);

/**
 * Tells whether an error means the database could not be reached, which is reported as a 503.
 * @param err - Any thrown value.
 */
export function isDatabaseUnreachable(err: unknown): boolean {
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
 * Runs `fn` in a READ COMMITTED transaction: BEGIN, run, COMMIT, with ROLLBACK on any error.
 * Deadlocks and serialization failures are retried up to five times with jitter; connection problems become a 503 (fail closed).
 * @param pool - Pool to take a connection from.
 * @param fn - Work to run inside the transaction; its result is returned after COMMIT.
 * @throws 503 `database unavailable`, or whatever `fn` threw.
 */
export async function runInTransaction<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      if (isDatabaseUnreachable(err)) throw unavailable("database unavailable");
      throw err;
    }
    let broken = false;
    try {
      await client.query(BEGIN);
      const result = await fn(client);
      await client.query(COMMIT);
      return result;
    } catch (err) {
      try {
        await client.query(ROLLBACK);
      } catch {
        broken = true;
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
        continue;
      }
      if (isDatabaseUnreachable(err)) {
        broken = true;
        throw unavailable("database unavailable");
      }
      throw err;
    } finally {
      client.release(broken ? true : undefined);
    }
  }
}

/**
 * Applies any `.sql` files in `dir` that have not run yet, in name order, each in its own transaction.
 * An advisory lock lets several instances boot at once without applying a migration twice.
 * @param pool - Pool to run migrations on.
 * @param dir - Directory of migration files.
 * @param log - Optional logger for applied migrations.
 */
export async function applyMigrations(pool: pg.Pool, dir: string, log?: { info: (o: object, m: string) => void }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_LOCK);
    await client.query(CREATE_MIGRATIONS_TABLE);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set(
      (await client.query<{ name: string }>(SELECT_APPLIED_MIGRATIONS)).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query(BEGIN);
      try {
        await client.query(sql);
        await client.query(INSERT_MIGRATION, [file]);
        await client.query(COMMIT);
      } catch (err) {
        await client.query(ROLLBACK);
        throw err;
      }
      log?.info({ migration: file }, "migration applied");
    }
  } finally {
    await client.query(MIGRATION_UNLOCK).catch(() => {});
    client.release();
  }
}

/**
 * Polls the database until it answers, so a cold start comes up by itself.
 * @param pool - Pool to ping.
 * @param attempts - How many tries before giving up.
 * @param delayMs - Wait between tries.
 * @throws The last connection error after the final attempt.
 */
export async function waitUntilDatabaseReady(pool: pg.Pool, attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query(PING);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
