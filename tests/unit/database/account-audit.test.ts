/**
 * Unit tests for shared/database/src/account-audit.ts (BS#2536, parent epic
 * #2534). Tests the REAL module directly (bypassing the package-level
 * `@wxyc/database` mock, mirroring tests/unit/database/concerts-recompute.test.ts)
 * so the values object asserted below is the module's actual INSERT payload,
 * not a hand-duplicated stub.
 *
 * Per the issue's Tests section, the only unit-level contract is the
 * writer's swallow-and-capture behavior — never throw, always reach the
 * injected `onError` on failure. The prune's cutoff BOUNDARY is proven only
 * in tests/integration/auth-log-prune.spec.js: the hand-written db double
 * cannot prove a retention boundary, since it never actually filters rows.
 *
 * The `jest.mock(...)` below is NOT redundant with the
 * `shared-database-src-client` moduleNameMapper entry in
 * `jest.unit.config.ts`, despite that entry's name suggesting it would
 * cover this. That entry's pattern requires the literal substring
 * `shared/database/src/client` in the import specifier's own text, which is
 * true for a deep relative path written from a test file
 * (`../../../shared/database/src/client.js`, as this line uses) but false
 * for `account-audit.ts`'s OWN internal `./client.js` import — a short
 * specifier written from a file that already lives inside
 * `shared/database/src/`. Without this `jest.mock`, that internal import
 * falls through to the config's later extension-stripping entry instead,
 * resolves to the REAL `client.ts`, and throws on the missing
 * `DB_HOST`/`DB_NAME`/`DB_USERNAME`/`DB_PASSWORD` env vars — confirmed by
 * temporarily deleting this call and re-running the suite. This is the same
 * `jest.mock` `tests/unit/database/concerts-recompute.test.ts` carries for
 * the identical reason; both exist because Jest mocks are keyed by resolved
 * absolute module path, not by the calling file's specifier text, so a
 * `jest.mock` registered here (keyed off this file's own relative path to
 * `client.js`) also intercepts `account-audit.ts`'s resolution of the same
 * file.
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { db } from '../../mocks/database.mock';
import {
  recordAccountAuditEvent,
  pruneAccountAuditEvents,
  ACCOUNT_AUDIT_EVENT_DEFAULT_RETENTION_DAYS,
  type AccountAuditEventInput,
} from '../../../shared/database/src/account-audit';

const BASE_EVENT: AccountAuditEventInput = {
  action: 'admin.set-role',
  actorUserId: 'actor-1',
  impersonatorUserId: 'impersonator-1',
  subjectUserId: 'subject-1',
  outcome: 200,
  errorCode: null,
  ipHash: 'abcdef0123456789',
  source: 'http',
};

beforeEach(() => {
  db._chain.values.mockReset();
  db._chain.values.mockReturnValue(db._chain);
});

describe('recordAccountAuditEvent — writer contract', () => {
  test('inserts a row with all ten columns', async () => {
    const onError = jest.fn();

    await recordAccountAuditEvent(BASE_EVENT, { onError });

    expect(db._chain.insert).toHaveBeenCalled();
    const values = db._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(values).sort()).toEqual(
      [
        'id',
        'occurredAt',
        'action',
        'actorUserId',
        'impersonatorUserId',
        'subjectUserId',
        'outcome',
        'errorCode',
        'ipHash',
        'source',
      ].sort()
    );
    expect(values.action).toBe('admin.set-role');
    expect(values.actorUserId).toBe('actor-1');
    expect(values.impersonatorUserId).toBe('impersonator-1');
    expect(values.subjectUserId).toBe('subject-1');
    expect(values.outcome).toBe(200);
    expect(values.errorCode).toBeNull();
    expect(values.ipHash).toBe('abcdef0123456789');
    expect(values.source).toBe('http');
    expect(typeof values.id).toBe('string');
    expect(values.occurredAt).toBeInstanceOf(Date);
    expect(onError).not.toHaveBeenCalled();
  });

  test('defaults every optional field to NULL when omitted', async () => {
    const onError = jest.fn();

    await recordAccountAuditEvent({ action: 'job.self-signup-downgrade', outcome: 200, source: 'job' }, { onError });

    const values = db._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.actorUserId).toBeNull();
    expect(values.impersonatorUserId).toBeNull();
    expect(values.subjectUserId).toBeNull();
    expect(values.errorCode).toBeNull();
    expect(values.ipHash).toBeNull();
  });

  test('a failed INSERT invokes onError and never throws or rejects', async () => {
    const dbError = new Error('connection reset');
    db._chain.values.mockImplementationOnce(() => {
      throw dbError;
    });
    const onError = jest.fn();

    await expect(recordAccountAuditEvent(BASE_EVENT, { onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(dbError);
  });

  test('a rejected INSERT promise also invokes onError and never throws or rejects', async () => {
    const dbError = new Error('deadlock detected');
    db._chain.values.mockReturnValueOnce(Promise.reject(dbError));
    const onError = jest.fn();

    await expect(recordAccountAuditEvent(BASE_EVENT, { onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(dbError);
  });

  test('a throwing onError itself never escapes recordAccountAuditEvent', async () => {
    const dbError = new Error('connection reset');
    db._chain.values.mockImplementationOnce(() => {
      throw dbError;
    });
    const onError = jest.fn(() => {
      throw new Error('Sentry transport unavailable');
    });

    await expect(recordAccountAuditEvent(BASE_EVENT, { onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(dbError);
  });
});

describe('ACCOUNT_AUDIT_EVENT_DEFAULT_RETENTION_DAYS', () => {
  test('is pinned at the decided 730-day (2-year) value (parent epic #2534 decision 9)', () => {
    expect(ACCOUNT_AUDIT_EVENT_DEFAULT_RETENTION_DAYS).toBe(730);
  });
});

describe('pruneAccountAuditEvents — retention guard', () => {
  beforeEach(() => {
    db._chain.where.mockReset();
    db._chain.where.mockReturnValue(db._chain);
  });

  test.each([0, -1, -730, NaN, Infinity, -Infinity])(
    'rejects olderThanDays=%p rather than deleting the entire table',
    async (olderThanDays) => {
      await expect(pruneAccountAuditEvents({ olderThanDays })).rejects.toThrow(
        /olderThanDays must be a positive finite number/
      );
      expect(db._chain.delete).not.toHaveBeenCalled();
    }
  );

  test('a valid positive olderThanDays proceeds to the DELETE', async () => {
    await pruneAccountAuditEvents({ olderThanDays: 730 });

    expect(db._chain.delete).toHaveBeenCalled();
  });
});
