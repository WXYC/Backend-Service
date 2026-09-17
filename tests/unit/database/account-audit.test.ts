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
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { db } from '../../mocks/database.mock';
import { recordAccountAuditEvent, type AccountAuditEventInput } from '../../../shared/database/src/account-audit';

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
});
