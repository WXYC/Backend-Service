/**
 * DB failure classification for the `/healthcheck` probe (BS#662, epic #665).
 *
 * `db.execute(sql`SELECT 1`)` fails through drizzle-orm's postgres-js
 * session (`drizzle-orm/pg-core/session.js`), which wraps every driver
 * error in a `DrizzleQueryError` whose `.cause` is the original error:
 *   - a `PostgresError` (the `postgres` package) for anything the server
 *     itself rejected — postgres-js parses the wire `ErrorResponse`'s `C`
 *     field straight onto `.code`, so `.code` is the raw Postgres SQLSTATE
 *     (see `postgres/src/connection.js`'s `errorFields` / `parseError`).
 *   - a raw Node socket error (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`,
 *     `ECONNRESET`, `ETIMEDOUT`) or one of postgres-js's own
 *     `Errors.connection(...)` codes (`CONNECT_TIMEOUT`, `CONNECTION_CLOSED`,
 *     `CONNECTION_DESTROYED`, `CONNECTION_ENDED`) for anything that failed
 *     before, or without, a Postgres wire response.
 *
 * Classification checks both `error.cause.code` and `error.code` — the same
 * dual-path idiom as `extractSqlState` in
 * `jobs/flowsheet-metadata-backfill/orchestrate.ts` and
 * `apps/backend/routes/internal-bans.route.ts` — so a test that throws a
 * bare `{code}` error and a prod run that throws the real
 * `DrizzleQueryError` wrapper both classify identically. The reported
 * `cause` string prefers `error.cause.message` for the same reason: the
 * wrapper's own message is just `"Failed query: ..."`, not the useful part.
 *
 * Vocabulary mirrors LML's `/health` `discogs_api` probe
 * (WXYC/library-metadata-lookup#226) per Epic #665 §Ordering, so operators
 * can pattern-match `services.database` against `services.discogs_api`
 * across both endpoints: `auth-error | rate-limited | upstream-error |
 * network-error | error`. Postgres has no probe-timeout bucket distinct
 * from "couldn't get a response" the way LML's httpx client does, so a
 * canceled statement (SQLSTATE 57014 — includes `statement_timeout`
 * cancels, see `shared/database/src/client.ts`'s `DB_STATEMENT_TIMEOUT_MS`)
 * is grouped under `network-error`, mirroring LML's own "connection /
 * timeout" grouping for `NETWORK_ERROR`.
 */
import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

export type DbCheckStatus = 'auth-error' | 'rate-limited' | 'upstream-error' | 'network-error' | 'error';

export type DbCheckResult = { status: 'ok' } | { status: DbCheckStatus; cause: string };

// SQLSTATE class 28 — Invalid Authorization Specification (bad password,
// unknown role, rejected by pg_hba.conf).
const AUTH_ERROR_CODES = new Set(['28000', '28P01']);

// SQLSTATE class 53 — Insufficient Resources. The DB is refusing more work
// (too many connections, out of memory/disk) — the closest Postgres analog
// to an HTTP 429.
const RATE_LIMITED_CODES = new Set(['53000', '53100', '53200', '53300', '53400']);

// SQLSTATE class 57 — Operator Intervention. The server itself is shutting
// down, crashed, or not accepting connections yet — the closest Postgres
// analog to an HTTP 5xx from an upstream.
const UPSTREAM_ERROR_CODES = new Set(['57000', '57P01', '57P02', '57P03', '57P04']);

// SQLSTATE class 08 — Connection Exception. The wire connection itself
// failed, whether or not it round-tripped the server first.
const CONNECTION_EXCEPTION_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '08P01']);

// SQLSTATE 57014 — query_canceled, which covers `statement_timeout` cancels.
const STATEMENT_TIMEOUT_CODE = '57014';

// Raw Node socket error codes surfaced before any Postgres wire handshake.
const NETWORK_ERROR_NODE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT']);

// postgres-js's own `Errors.connection(...)` codes (see
// `postgres/src/errors.js` + its call sites in `postgres/src/connection.js`
// and `postgres/src/index.js`).
const NETWORK_ERROR_DRIVER_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
]);

/**
 * Extract the SQLSTATE / driver error code, preferring the wrapped
 * `DrizzleQueryError.cause` shape and falling back to a bare `error.code` —
 * see the module doc comment.
 */
const extractErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const code = causeCode ?? (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Extract a human-readable message, preferring the wrapped
 * `DrizzleQueryError.cause`'s message (the underlying driver/server error)
 * over the wrapper's own generic `"Failed query: ..."` message.
 */
const extractErrorMessage = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'object' && cause !== null && typeof (cause as { message?: unknown }).message === 'string') {
      return (cause as { message: string }).message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

/** Classify a `db.execute` failure into the shared cross-service health-check vocabulary. */
export const classifyDatabaseError = (error: unknown): DbCheckResult => {
  const code = extractErrorCode(error);
  const cause = extractErrorMessage(error);

  if (code) {
    if (AUTH_ERROR_CODES.has(code)) return { status: 'auth-error', cause };
    if (RATE_LIMITED_CODES.has(code)) return { status: 'rate-limited', cause };
    if (UPSTREAM_ERROR_CODES.has(code)) return { status: 'upstream-error', cause };
    if (
      code === STATEMENT_TIMEOUT_CODE ||
      CONNECTION_EXCEPTION_CODES.has(code) ||
      NETWORK_ERROR_NODE_CODES.has(code) ||
      NETWORK_ERROR_DRIVER_CODES.has(code)
    ) {
      return { status: 'network-error', cause };
    }
  }

  return { status: 'error', cause };
};

/** Probe the database with `SELECT 1`, classifying any failure. */
export const checkDatabase = async (): Promise<DbCheckResult> => {
  try {
    await db.execute(sql`SELECT 1`);
    return { status: 'ok' };
  } catch (error) {
    return classifyDatabaseError(error);
  }
};
