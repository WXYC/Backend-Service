/**
 * Unit tests for the `/healthcheck` DB failure classifier (BS#662).
 *
 * `classifyDatabaseError` is pure and covers every branch directly.
 * `checkDatabase` is covered through the mocked `db.execute` (moduleNameMapper
 * routes `@wxyc/database` to `tests/mocks/database.mock.ts` for the unit
 * suite — see `jest.unit.config.ts`).
 *
 * Test doubles mirror the dual shape a real failure can take — see
 * `jobs/flowsheet-metadata-backfill/orchestrate.test.ts`'s `withCode` /
 * `withCauseCode` precedent:
 *   - `withCauseCode(code)` — the real `DrizzleQueryError` wrapper shape,
 *     `error.cause.code` (drizzle-orm/pg-core/session.js wraps every driver
 *     error this way).
 *   - `withCode(code)` — a bare `error.code`, for callers/tests that throw
 *     the unwrapped driver error directly.
 */
import { db } from '../../../mocks/database.mock';
import { classifyDatabaseError, checkDatabase } from '../../../../apps/backend/services/health/database-check';

const withCauseCode = (code: string, message = 'drizzle wrapper'): Error =>
  Object.assign(new Error('Failed query: SELECT 1'), { cause: Object.assign(new Error(message), { code }) });
const withCode = (code: string, message = 'db error'): Error => Object.assign(new Error(message), { code });

describe('classifyDatabaseError', () => {
  it('classifies SQLSTATE 28P01/28000 (invalid password / auth spec) as auth-error', () => {
    expect(classifyDatabaseError(withCauseCode('28P01', 'password authentication failed for user "wxyc"'))).toEqual({
      status: 'auth-error',
      cause: 'password authentication failed for user "wxyc"',
    });
    expect(classifyDatabaseError(withCauseCode('28000', 'role "wxyc" does not exist'))).toEqual({
      status: 'auth-error',
      cause: 'role "wxyc" does not exist',
    });
  });

  it('classifies SQLSTATE class 53 (insufficient resources) as rate-limited', () => {
    expect(classifyDatabaseError(withCauseCode('53300', 'sorry, too many clients already'))).toEqual({
      status: 'rate-limited',
      cause: 'sorry, too many clients already',
    });
    expect(classifyDatabaseError(withCauseCode('53400'))).toEqual({ status: 'rate-limited', cause: 'drizzle wrapper' });
  });

  it('classifies SQLSTATE class 57 (operator intervention) as upstream-error', () => {
    expect(
      classifyDatabaseError(withCauseCode('57P01', 'terminating connection due to administrator command'))
    ).toEqual({ status: 'upstream-error', cause: 'terminating connection due to administrator command' });
    expect(classifyDatabaseError(withCauseCode('57P03', 'the database system is starting up'))).toEqual({
      status: 'upstream-error',
      cause: 'the database system is starting up',
    });
  });

  it('classifies SQLSTATE 57014 (statement timeout / query_canceled) as network-error', () => {
    expect(classifyDatabaseError(withCauseCode('57014', 'canceling statement due to statement timeout'))).toEqual({
      status: 'network-error',
      cause: 'canceling statement due to statement timeout',
    });
  });

  it('classifies SQLSTATE class 08 (connection exception) as network-error', () => {
    expect(classifyDatabaseError(withCauseCode('08006', 'connection to server was lost'))).toEqual({
      status: 'network-error',
      cause: 'connection to server was lost',
    });
  });

  it('classifies raw Node socket error codes as network-error', () => {
    expect(classifyDatabaseError(withCauseCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'))).toEqual({
      status: 'network-error',
      cause: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
    expect(classifyDatabaseError(withCauseCode('ENOTFOUND', 'getaddrinfo ENOTFOUND db.internal'))).toEqual({
      status: 'network-error',
      cause: 'getaddrinfo ENOTFOUND db.internal',
    });
    expect(classifyDatabaseError(withCauseCode('EHOSTUNREACH'))).toEqual({
      status: 'network-error',
      cause: 'drizzle wrapper',
    });
  });

  it("classifies postgres-js's own connection-error codes as network-error", () => {
    expect(classifyDatabaseError(withCauseCode('CONNECT_TIMEOUT'))).toEqual({
      status: 'network-error',
      cause: 'drizzle wrapper',
    });
    expect(classifyDatabaseError(withCauseCode('CONNECTION_CLOSED'))).toEqual({
      status: 'network-error',
      cause: 'drizzle wrapper',
    });
  });

  it('falls back to generic error for an unrecognized or missing SQLSTATE', () => {
    expect(classifyDatabaseError(withCauseCode('42501', 'permission denied for table flowsheet'))).toEqual({
      status: 'error',
      cause: 'permission denied for table flowsheet',
    });
    expect(classifyDatabaseError(new Error('something unexpected'))).toEqual({
      status: 'error',
      cause: 'something unexpected',
    });
    expect(classifyDatabaseError('just a string')).toEqual({ status: 'error', cause: 'just a string' });
    expect(classifyDatabaseError(null)).toEqual({ status: 'error', cause: 'null' });
  });

  it('reads the code off error.code when there is no cause (bare error shape)', () => {
    expect(classifyDatabaseError(withCode('28P01', 'password authentication failed'))).toEqual({
      status: 'auth-error',
      cause: 'password authentication failed',
    });
  });

  it('prefers cause.code over a top-level code (drizzle wrapper shape)', () => {
    const wrapped = Object.assign(new Error('wrapper'), {
      code: 'ECONNREFUSED',
      cause: { code: '28P01', message: 'password authentication failed' },
    });
    expect(classifyDatabaseError(wrapped)).toEqual({ status: 'auth-error', cause: 'password authentication failed' });
  });

  it("prefers the wrapped cause's message over the DrizzleQueryError wrapper's own 'Failed query: ...' message", () => {
    const wrapped = withCauseCode('57P01', 'terminating connection due to administrator command');
    expect(wrapped.message).toBe('Failed query: SELECT 1');
    expect(classifyDatabaseError(wrapped).cause).toBe('terminating connection due to administrator command');
  });
});

describe('checkDatabase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns { status: "ok" } when db.execute resolves', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
    await expect(checkDatabase()).resolves.toEqual({ status: 'ok' });
  });

  it('returns the classified failure when db.execute rejects', async () => {
    (db.execute as jest.Mock).mockRejectedValue(withCauseCode('28P01', 'password authentication failed'));
    await expect(checkDatabase()).resolves.toEqual({
      status: 'auth-error',
      cause: 'password authentication failed',
    });
  });

  it('classifies a connection-refused failure as network-error', async () => {
    (db.execute as jest.Mock).mockRejectedValue(withCauseCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'));
    await expect(checkDatabase()).resolves.toEqual({
      status: 'network-error',
      cause: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
  });
});
