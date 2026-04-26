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

const queryClient = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  connection: {
    application_name: process.env.DB_APPLICATION_NAME ?? 'wxyc-backend',
    // Server-enforced per-statement timeout. postgres-js issues this as
    // `SET statement_timeout = '<n>ms'` after each session is established.
    statement_timeout: statementTimeoutMs,
  },
});

console.log(`[database] statement_timeout=${statementTimeoutMs}ms${statementTimeoutMs === 0 ? ' (disabled)' : ''}`);

export const db = drizzle(queryClient, { schema });

export function closeDatabaseConnection(): Promise<void> {
  return queryClient.end().then(() => console.log('Database connection closed.'));
}
