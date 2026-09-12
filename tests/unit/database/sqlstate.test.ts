/**
 * Unit tests for `extractSqlState` and the lock-contention vocabulary built on
 * it (shared/database/src/sqlstate.ts).
 *
 * The contract these pin is narrow but load-bearing: prefer `.cause.code`,
 * fall back to a top-level `.code`, and return `undefined` for anything that
 * isn't a string code. Five call sites had written that decode by hand before
 * it was extracted, and the sixth — `deleteAlbumFromDB`'s `lock_unavailable`
 * (503) arm — had written only half of it, reading the bare `.code` that
 * drizzle's `DrizzleQueryError` wrapper always leaves `undefined`. The bug was
 * invisible because a unit test cannot construct the wrapper by accident: a
 * hand-built `{ code }` double passes against a classifier that never fires in
 * production. So the wrapped shape is the first case here, not an afterthought.
 */

import {
  extractSqlState,
  isLockContentionError,
  LOCK_CONTENTION_SQLSTATES,
  SUB_DEADLOCK_LOCK_TIMEOUT_MS,
} from '../../../shared/database/src/sqlstate';

const pgError = (code: unknown, message = 'driver error'): Error => Object.assign(new Error(message), { code });
const drizzleWrapped = (cause: unknown): Error => Object.assign(new Error('Failed query: <sql>\nparams: '), { cause });

describe('extractSqlState', () => {
  it('reads the SQLSTATE off the drizzle wrapper’s cause', () => {
    expect(extractSqlState(drizzleWrapped(pgError('55P03')))).toBe('55P03');
  });

  it('falls back to a top-level code when there is no cause', () => {
    expect(extractSqlState(pgError('23505'))).toBe('23505');
  });

  it('prefers cause.code over a top-level code', () => {
    // The wrapper itself can carry an unrelated `code`; the driver error under
    // it is the authority.
    expect(extractSqlState(Object.assign(new Error('wrapper'), { code: '40P01', cause: { code: '22001' } }))).toBe(
      '22001'
    );
  });

  it('accepts a plain object cause, not only an Error', () => {
    expect(extractSqlState({ cause: { code: 'ECONNREFUSED' } })).toBe('ECONNREFUSED');
  });

  it.each([
    ['a bare Error with no code', new Error('boom')],
    ['a wrapper whose cause carries no code', drizzleWrapped(new Error('boom'))],
    ['a non-string code', pgError(42809)],
    ['a null cause', { cause: null, code: undefined }],
    ['a thrown string', 'just a string'],
    ['null', null],
    ['undefined', undefined],
  ])('returns undefined for %s', (_label, input) => {
    expect(extractSqlState(input)).toBeUndefined();
  });
});

describe('isLockContentionError', () => {
  it.each([['55P03'], ['40P01']])('classifies wrapped %s as contention', (code) => {
    expect(isLockContentionError(drizzleWrapped(pgError(code)))).toBe(true);
  });

  it.each([['55P03'], ['40P01']])('classifies bare %s as contention too', (code) => {
    expect(isLockContentionError(pgError(code))).toBe(true);
  });

  it('does not mistake an unrelated wrapped error for contention', () => {
    // A wrapper is not evidence of anything on its own — reading the SQLSTATE
    // out of `.cause` must not degrade into "any wrapped error is contention".
    expect(isLockContentionError(drizzleWrapped(pgError('23503')))).toBe(false);
  });

  it('excludes 57014 (query_canceled) deliberately', () => {
    // `statement_timeout` raises 57014, and that is exactly the error a caller
    // sees when its `SET LOCAL lock_timeout` guard failed to bind. Treating it
    // as a clean stand-down would hide the guard being broken.
    expect(LOCK_CONTENTION_SQLSTATES.has('57014')).toBe(false);
    expect(isLockContentionError(drizzleWrapped(pgError('57014')))).toBe(false);
  });

  it('returns false when no SQLSTATE can be read', () => {
    expect(isLockContentionError(new Error('boom'))).toBe(false);
    expect(isLockContentionError(null)).toBe(false);
  });
});

describe('SUB_DEADLOCK_LOCK_TIMEOUT_MS', () => {
  it('stays under Postgres’s default 1s deadlock_timeout', () => {
    // The whole point of the value: give up before the deadlock detector can
    // run, so this side is always the one that stands down rather than
    // sometimes being the chosen victim.
    expect(SUB_DEADLOCK_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SUB_DEADLOCK_LOCK_TIMEOUT_MS).toBeLessThan(1000);
  });
});
