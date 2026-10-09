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

const ALTERED_SQL =
  'update "reviews" set "review" = $1, "dj_name" = $2, "real_name" = $3, "updated_at" = $4 where "id" = $5';
/** The first value is DJ text with a line shaped like a stack frame, the way a review body can be, and it binds before the names. */
export const ALTERED_BOUND = [
  `great record\n    at ${SIGNUP_REAL_NAME},${SIGNUP_DJ_NAME}`,
  SIGNUP_DJ_NAME,
  SIGNUP_REAL_NAME,
  '2026-10-08T16:23:45.123Z',
  'r1',
];

/**
 * A failed query whose message was changed after V8 formatted its stack (V8 formats `stack` on first read, so the
 * stack still holds the original message and the params line). `drizzle` is drizzle's real class, `plain` an `Error`
 * with the same message and nothing else. `alter` gets the original message and returns the new one.
 */
export function alteredFailedQuery(kind: 'drizzle' | 'plain', alter: (message: string) => string): Error {
  const drizzleError = new DrizzleQueryError(ALTERED_SQL, ALTERED_BOUND, postgresJsServerError(ALTERED_BOUND));
  const error = kind === 'drizzle' ? drizzleError : new Error(drizzleError.message);
  if (!String(error.stack).includes('\nparams: '))
    throw new Error('the stack must hold the params line before the message changes');
  error.message = alter(error.message);
  return error;
}

const MARKER = '\nparams: ';
/** Where a length cap or an edit can land in the message; each is the new message's length. */
export const MESSAGE_CUTS: ReadonlyArray<[string, (message: string) => number]> = [
  ['inside the marker', (m) => m.indexOf(MARKER) + 4],
  ['right after the marker', (m) => m.indexOf(MARKER) + MARKER.length],
  ['inside the first value', (m) => m.indexOf(MARKER) + MARKER.length + 3],
  ["at the first value's own frame-shaped line", (m) => m.indexOf('\n    at ')],
  ['inside a later value', (m) => m.lastIndexOf(SIGNUP_REAL_NAME) + 4],
];
