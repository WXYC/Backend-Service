import { DrizzleQueryError } from 'drizzle-orm/errors';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { user } from '../../shared/database/src/schema';

/**
 * Error shapes the way the real driver and ORM build them (BS#3054). A fixture
 * made with `Object.assign` has writable, configurable properties and passes
 * against code that crashes on the real thing, so tests of the redaction must
 * use these.
 */

// The unit setup replaces `sql` from 'drizzle-orm' with a stub; the real error needs the real tag.
const { sql } = jest.requireActual<typeof import('drizzle-orm')>('drizzle-orm');

export const UPDATE_SQL = 'update "auth_user" set "real_name" = $1 where "id" = $2';

/**
 * A driver error as postgres.js 3.4.9's `queryError` (node_modules/postgres/cjs/src/connection.js)
 * builds it: `query`, `parameters`, `args` and `types` are defined with
 * `Object.defineProperties` and no `writable`/`configurable` flags, so they are
 * non-writable and non-configurable. Defined exactly as connection.js does,
 * because a server error needs a database to produce.
 */
export function postgresJsServerError(bound: unknown[], extra: Record<string, unknown> = {}): Error {
  const err = Object.assign(new Error('null value in column "real_name" violates not-null constraint'), extra);
  Object.defineProperties(err, {
    query: { value: UPDATE_SQL, enumerable: false },
    parameters: { value: bound, enumerable: false },
    args: { value: bound, enumerable: false },
    types: { value: [], enumerable: false },
  });
  return err;
}

/** drizzle-orm's real `DrizzleQueryError` around a postgres.js-shaped driver error. */
export function realDrizzleQueryError(bound: string[], extra: Record<string, unknown> = {}): DrizzleQueryError {
  return new DrizzleQueryError(UPDATE_SQL, bound, postgresJsServerError(bound, extra));
}

/**
 * A `DrizzleQueryError` thrown by drizzle and postgres.js themselves, with no
 * database: a client pointed at a closed local port rejects in milliseconds.
 * Its cause is postgres.js's own error, built by the library's `queryError`.
 */
export async function captureRealDrizzleQueryError(bound: string): Promise<DrizzleQueryError> {
  const client = postgres('postgres://user:pass@127.0.0.1:1/db', { max: 1, connect_timeout: 2 });
  try {
    await drizzle(client).execute(sql`update "auth_user" set "real_name" = ${bound} where "id" = ${'u1'}`);
  } catch (error) {
    if (error instanceof DrizzleQueryError) return error;
    throw error;
  } finally {
    await client.end({ timeout: 0 });
  }
  throw new Error('expected the query to fail');
}

export const SIGNUP_REAL_NAME = 'Test Reviewer';
export const SIGNUP_DJ_NAME = 'DJ Cat Scratch';

/**
 * A `DrizzleQueryError` for a failed station-signup-shaped `auth_user` insert, thrown by drizzle and
 * postgres.js against a closed port. Its params line ends `...,<real name>,<DJ name>,...,<ISO timestamp>`,
 * so Sentry's line parser reads a frame (with a line number) out of it.
 */
export async function captureFailedStationSignupInsert(): Promise<DrizzleQueryError> {
  const client = postgres('postgres://user:pass@127.0.0.1:1/db', { max: 1, connect_timeout: 2 });
  try {
    await drizzle(client)
      .insert(user)
      .values({
        id: 'abc123',
        name: SIGNUP_DJ_NAME,
        email: 'dj@example.org',
        username: 'djcat',
        realName: SIGNUP_REAL_NAME,
        djName: SIGNUP_DJ_NAME,
        selfSignupAt: new Date('2026-10-08T16:23:45.123Z'),
      });
  } catch (error) {
    if (error instanceof DrizzleQueryError) return error;
    throw error;
  } finally {
    await client.end({ timeout: 0 });
  }
  throw new Error('expected the insert to fail');
}
