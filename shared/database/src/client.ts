import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Validate required environment variables
const requiredEnvVars = ['DB_HOST', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD'];
const missingVars = requiredEnvVars.filter((v) => process.env[v] === undefined);
if (missingVars.length > 0) {
  console.error('[ERROR] Missing required database environment variables:', missingVars.join(', '));
  throw new Error(`Missing required database environment variables: ${missingVars.join(', ')}`);
}

/**
 * Resolve the per-connection `statement_timeout` (in ms) for this process.
 *
 * Three classes of caller:
 *   - HTTP request handlers (apps/backend, apps/auth) — every query should
 *     finish within seconds. Express's own request timeout is 30s. A query
 *     longer than that is always an orphan (the HTTP response went out long
 *     ago). The default 5s catches that aggressively.
 *   - Migrations (db-migrate image) — DDL is normally instant but ALTER
 *     against contended tables can need a few seconds. Set
 *     `DB_STATEMENT_TIMEOUT_MS=300000` (5 min) in the migrate container.
 *   - One-shot backfills (jobs/<x>-backfill/) — bounded batches, but each
 *     batch can be 30-60s on a hot table. Set
 *     `DB_STATEMENT_TIMEOUT_MS=300000` or higher in the backfill container.
 *
 * Setting `0` disables the timeout (postgres-js default behaviour). Use that
 * only for unit-test fixtures or one-off scripts.
 *
 * Reason this lives at connection level: HTTP request abort does not
 * propagate to postgres-js, so a 504 returned to the client leaves the SQL
 * running. Without a server-side cap, a backend with a few sluggish
 * endpoints will accumulate orphans until the connection pool is exhausted
 * — exactly the wedge from incident #511.
 */
/**
 * Pure helper for resolving the `statement_timeout` from environment input.
 * Exported so unit tests can validate parsing behaviour without dragging in
 * the real postgres-js connection.
 */
export const resolveStatementTimeoutMs = (raw: string | undefined = process.env.DB_STATEMENT_TIMEOUT_MS): number => {
  if (raw === undefined) return 5000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid DB_STATEMENT_TIMEOUT_MS=${JSON.stringify(raw)}; must be a non-negative integer (ms). Use 0 to disable.`
    );
  }
  return parsed;
};

const statementTimeoutMs = resolveStatementTimeoutMs();

/**
 * Resolve the per-connection `synchronous_commit` value. Default `on` matches
 * Postgres's own default and preserves durability for the API and ETLs.
 *
 * Bulk one-shot backfills should set `DB_SYNCHRONOUS_COMMIT=off` in their
 * Dockerfile/run env: each per-batch COMMIT then returns as soon as WAL is in
 * the OS buffer, instead of waiting for fsync. Under live RDS load, fsync
 * waits dominated batch latency — `pg_stat_wal.wal_buffers_full` was in the
 * millions and individual batches stalled for minutes. Backfills here are
 * idempotent (each restart resumes via `WHERE dj_name IS NULL` or equivalent),
 * so losing a few unfsync'd commits to a hypothetical RDS crash just means
 * those rows get redone — safe by design.
 *
 * Anything stricter than `off` (e.g., `local`, `remote_write`, `on`) is
 * accepted unchanged so callers can dial durability up rather than down if
 * they need to.
 */
export const resolveSynchronousCommit = (raw: string | undefined = process.env.DB_SYNCHRONOUS_COMMIT): string => {
  if (raw === undefined) return 'on';
  const v = raw.trim().toLowerCase();
  const allowed = new Set(['on', 'off', 'local', 'remote_write', 'remote_apply']);
  if (!allowed.has(v)) {
    throw new Error(
      `Invalid DB_SYNCHRONOUS_COMMIT=${JSON.stringify(raw)}; must be one of: ${[...allowed].join(', ')}.`
    );
  }
  return v;
};

const synchronousCommit = resolveSynchronousCommit();

/**
 * Build a postgres-js client from the shared env-driven defaults, with
 * optional per-call overrides for connection-level options.
 *
 * The shared `db` is built from this with no overrides. Specialized
 * callers (e.g., the `album_plays` materialized-view refresh, which
 * legitimately needs a longer per-statement timeout than the API's 5s
 * default) build their own dedicated client by passing overrides — that
 * keeps the override scoped to one connection rather than mutating the
 * pool that serves request-path traffic.
 *
 * Overrides applied to the returned client:
 *   - `statementTimeoutMs` — overrides `connection.statement_timeout`. Use
 *     this when a job legitimately needs more than the process default.
 *   - `applicationName` — overrides `connection.application_name`. Set a
 *     distinct name so `pg_stat_activity` makes the source obvious during
 *     incident triage.
 *   - `max` — pool size. Defaults to postgres-js's own default (10). Set
 *     to `1` for serial single-purpose clients.
 *   - `maxLifetimeSeconds` — overrides postgres-js's `max_lifetime` (the
 *     interval after which an idle connection is proactively recycled;
 *     library default is a random 30–60 min). Pass `0` to disable recycling
 *     entirely for a client that holds session-scoped state which must not
 *     silently drop mid-run — e.g. a `pg_advisory_lock` single-flight guard,
 *     whose lock is released the instant its owning connection is torn down.
 */
export function createPostgresClient(
  overrides: { statementTimeoutMs?: number; applicationName?: string; max?: number; maxLifetimeSeconds?: number } = {}
): ReturnType<typeof postgres> {
  return postgres({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    ...(overrides.max !== undefined && { max: overrides.max }),
    ...(overrides.maxLifetimeSeconds !== undefined && { max_lifetime: overrides.maxLifetimeSeconds }),
    connection: {
      application_name: overrides.applicationName ?? process.env.DB_APPLICATION_NAME ?? 'wxyc-backend',
      // Server-enforced per-statement timeout. postgres-js issues this as
      // `SET statement_timeout = '<n>ms'` after each session is established.
      statement_timeout: overrides.statementTimeoutMs ?? statementTimeoutMs,
      synchronous_commit: synchronousCommit,
    },
  });
}

const queryClient = createPostgresClient();

console.log(
  `[database] statement_timeout=${statementTimeoutMs}ms${statementTimeoutMs === 0 ? ' (disabled)' : ''} synchronous_commit=${synchronousCommit}`
);

export const db = drizzle(queryClient, { schema });

export function closeDatabaseConnection(): Promise<void> {
  return queryClient.end().then(() => console.log('Database connection closed.'));
}
