/**
 * Tests for the library-identity-consumer logger's pure helpers.
 *
 * `pgDiagnostics` exists because Drizzle wraps every postgres-js failure in a
 * `DrizzleQueryError` whose `.message` is the hardcoded
 * `Failed query: <SQL>\nparams: <params>` — the SQLSTATE code, detail line, and
 * offending constraint all live on `.cause`. These tests pin the two properties
 * the catch sites depend on: a wrapped driver error yields its diagnostics, and
 * anything else yields an object that spreads to nothing.
 *
 * The init / JSON-line behavior is shared verbatim with the sibling job loggers
 * and is exercised by `tests/unit/jobs/flowsheet-etl/logger.test.ts`.
 */

import {
  errorMessage,
  pgDiagnostics,
  resolveTracesSampleRate,
} from '../../../../jobs/library-identity-consumer/logger';

/** Shaped like a real DrizzleQueryError wrapping a postgres-js error. */
const drizzleError = (cause: Record<string, unknown>): Error => {
  const err = new Error('Failed query: insert into "library_identity" ...\nparams: 1,2,3');
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
};

describe('resolveTracesSampleRate', () => {
  it('defaults to 1 when env var is unset', () => {
    expect(resolveTracesSampleRate(undefined)).toBe(1);
  });

  it('parses valid values in [0, 1]', () => {
    expect(resolveTracesSampleRate('0')).toBe(0);
    expect(resolveTracesSampleRate('0.5')).toBe(0.5);
    expect(resolveTracesSampleRate('1')).toBe(1);
  });

  it('falls back to 1 on malformed or out-of-range values', () => {
    expect(resolveTracesSampleRate('abc')).toBe(1);
    expect(resolveTracesSampleRate('-0.5')).toBe(1);
    expect(resolveTracesSampleRate('1.5')).toBe(1);
  });
});

describe('pgDiagnostics', () => {
  it('lifts the PG fields off a wrapped driver error', () => {
    const error = drizzleError({
      message: 'duplicate key value violates unique constraint "library_identity_pkey"',
      code: '23505',
      detail: 'Key (library_id)=(4271) already exists.',
      constraint_name: 'library_identity_pkey',
      column_name: 'library_id',
      table_name: 'library_identity',
      routine: '_bt_check_unique',
    });

    expect(pgDiagnostics(error)).toEqual({
      pg_message: 'duplicate key value violates unique constraint "library_identity_pkey"',
      pg_code: '23505',
      pg_detail: 'Key (library_id)=(4271) already exists.',
      pg_constraint: 'library_identity_pkey',
      pg_column: 'library_id',
      pg_table: 'library_identity',
      pg_routine: '_bt_check_unique',
    });
  });

  it('distinguishes two failures whose DrizzleQueryError messages are identical', () => {
    // The whole point: `.message` is the same query text for both, so only
    // `.cause` can tell a unique violation from a not-null violation.
    const sql = 'Failed query: insert into "library_identity" ...\nparams: 1,2,3';
    const unique = drizzleError({ code: '23505', constraint_name: 'library_identity_pkey' });
    const notNull = drizzleError({ code: '23502', column_name: 'canonical_entity_id' });

    expect(unique.message).toBe(sql);
    expect(notNull.message).toBe(sql);
    expect(pgDiagnostics(unique).pg_code).toBe('23505');
    expect(pgDiagnostics(notNull).pg_code).toBe('23502');
  });

  it('omits fields the driver did not set, so JSON.stringify drops them', () => {
    const diagnostics = pgDiagnostics(drizzleError({ code: '23505' }));

    expect(diagnostics.pg_code).toBe('23505');
    expect(diagnostics.pg_detail).toBeUndefined();
    // A log line for a partial diagnostic must not sprout empty keys.
    expect(JSON.parse(JSON.stringify({ ...diagnostics }))).toEqual({ pg_code: '23505' });
  });

  it.each([
    ['a plain Error with no cause', new Error('boom')],
    ['a thrown string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an error whose cause is a string', Object.assign(new Error('boom'), { cause: 'nested' })],
  ])('returns an empty object for %s', (_label, thrown) => {
    // Spreading the result must be a no-op — a catch block is the worst place
    // to introduce a new way to throw.
    expect(pgDiagnostics(thrown)).toEqual({});
    expect({ error_message: 'x', ...pgDiagnostics(thrown) }).toEqual({ error_message: 'x' });
  });

  it('ignores non-string diagnostic values rather than logging objects', () => {
    expect(pgDiagnostics(drizzleError({ code: 23505, detail: { nested: true } }))).toEqual({
      pg_message: undefined,
      pg_code: undefined,
      pg_detail: undefined,
      pg_constraint: undefined,
      pg_column: undefined,
      pg_table: undefined,
      pg_routine: undefined,
    });
  });
});

describe('errorMessage', () => {
  it('reads .message from an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it.each([
    ['a thrown string', 'boom', 'boom'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a number', 42, '42'],
    ['an object with a non-string message', { message: 7 }, '[object Object]'],
  ])('stringifies %s instead of throwing', (_label, thrown, expected) => {
    // `(error as Error).message` returns undefined here, and the JSON logger
    // then drops the key entirely — the failure logs as if it had no message.
    expect(errorMessage(thrown)).toBe(expected);
  });
});
