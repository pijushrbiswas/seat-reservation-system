/** Cheapest possible query, used to check the database is reachable. */
export const PING = "SELECT 1";

/** Starts a transaction. */
export const BEGIN = "BEGIN";
/** Commits the current transaction. */
export const COMMIT = "COMMIT";
/** Abandons the current transaction. */
export const ROLLBACK = "ROLLBACK";

/** Takes the advisory lock that makes instances booting together apply migrations one at a time. */
export const MIGRATION_LOCK = "SELECT pg_advisory_lock(727001)";
/** Releases the migration advisory lock. */
export const MIGRATION_UNLOCK = "SELECT pg_advisory_unlock(727001)";

/** Creates the table that records which migrations have been applied. */
export const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
/** Names of the migrations already applied. */
export const SELECT_APPLIED_MIGRATIONS = "SELECT name FROM schema_migrations";
/** Records a migration as applied. $1 file name. */
export const INSERT_MIGRATION = "INSERT INTO schema_migrations(name) VALUES ($1)";
