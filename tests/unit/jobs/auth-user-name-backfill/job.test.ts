/**
 * Unit tests for the auth_user.name backfill job orchestration (DJ real-name
 * PII safeguards plan, Track 2d). The pure decisions (per-row rewrite, gate
 * predicate) are tested directly in decide.test.ts; this file drives
 * fetchAllUsers / runPreconditionGate / applyUpdate / runBackfill against a
 * mocked db.execute.
 */

import { db } from '@wxyc/database';
import {
  fetchAllUsers,
  runPreconditionGate,
  applyUpdate,
  runBackfill,
} from '../../../../jobs/auth-user-name-backfill/job';
import { renderSql } from '../../../utils/render-sql';

const rawRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'user-1',
  name: 'Jane Doe',
  username: 'jane_dj',
  dj_name: 'DJ Jazzy Jane',
  real_name: 'Jane Doe',
  is_anonymous: false,
  ...overrides,
});

describe('auth-user-name-backfill: fetchAllUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FINDING 7 (2297 review): the un-filtered SELECT pulled every anonymous
  // per-device row — and everyone's real_name — into memory only for
  // decideAuthUserNameBackfill to discard the anonymous ones immediately.
  // Anonymous rows plausibly dominate auth_user; there's no reason to pull
  // legal names into process memory for rows the job throws away unread.
  // The WHERE clause is behavior-identical: decideAuthUserNameBackfill (and
  // the precondition gate) already skip is_anonymous rows unconditionally,
  // so excluding them earlier changes nothing about which rows get written.
  it('issues a SELECT against auth_user filtered to non-anonymous rows, with no LIMIT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await fetchAllUsers();

    const call = (db.execute as jest.Mock).mock.calls[0];
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/SELECT[\s\S]*FROM[\s\S]*auth_user/i);
    expect(sqlText).toMatch(/WHERE[\s\S]*is_anonymous[\s\S]*DISTINCT FROM[\s\S]*true/i);
    expect(sqlText).not.toMatch(/LIMIT/i);
  });

  it('maps snake_case columns onto the camelCase row shape', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([rawRow()]);

    const rows = await fetchAllUsers();

    expect(rows).toEqual([
      {
        id: 'user-1',
        name: 'Jane Doe',
        username: 'jane_dj',
        djName: 'DJ Jazzy Jane',
        realName: 'Jane Doe',
        isAnonymous: false,
      },
    ]);
  });

  it('defaults a null is_anonymous to false', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([rawRow({ is_anonymous: null })]);

    const rows = await fetchAllUsers();

    expect(rows[0].isAnonymous).toBe(false);
  });
});

describe('auth-user-name-backfill: runPreconditionGate', () => {
  it('does not throw when no row violates the 2a preserve-first predicate', () => {
    expect(() =>
      runPreconditionGate([
        { id: 'u1', name: 'jane_dj', username: 'jane_dj', djName: null, realName: null, isAnonymous: false },
        { id: 'u2', name: 'Jane Doe', username: 'jane_dj', djName: null, realName: 'Jane Doe', isAnonymous: false },
      ])
    ).not.toThrow();
  });

  it('throws naming Track 2a when a row still holds its only legal-name copy in name', () => {
    expect(() =>
      runPreconditionGate([
        {
          id: 'sentinel-user',
          name: 'Jane Doe',
          username: 'jane_dj',
          djName: null,
          realName: null,
          isAnonymous: false,
        },
      ])
    ).toThrow(/Track 2a/);
  });

  it('includes the violating row id(s) in the error message', () => {
    expect(() =>
      runPreconditionGate([
        {
          id: 'sentinel-user-001',
          name: 'Jane Doe',
          username: 'jane_dj',
          djName: null,
          realName: null,
          isAnonymous: false,
        },
      ])
    ).toThrow(/sentinel-user-001/);
  });
});

describe('auth-user-name-backfill: applyUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the derived name for the given id', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await applyUpdate('user-1', 'DJ Jazzy Jane');

    const call = (db.execute as jest.Mock).mock.calls[0];
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/UPDATE[\s\S]*auth_user[\s\S]*SET[\s\S]*name/i);
    expect(sqlText).toMatch(/WHERE[\s\S]*id/i);
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('user-1');
    expect(serialized).toContain('DJ Jazzy Jane');
  });
});

describe('auth-user-name-backfill: runBackfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aborts before writing anything when the precondition gate fails, even in dry-run', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      rawRow({ id: 'sentinel-user', real_name: null, name: 'Jane Doe', username: 'jane_dj' }),
    ]);

    await expect(runBackfill({ dryRun: true })).rejects.toThrow(/Track 2a/);
    // Only the SELECT ran — no UPDATE was issued.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
  });

  it('writes updated rows and skips unchanged ones in execute mode', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        rawRow({ id: 'u1', name: 'Jane Doe', username: 'jane_dj', dj_name: 'DJ Jazzy Jane', real_name: 'Jane Doe' }),
        rawRow({ id: 'u2', name: 'bob_dj', username: 'bob_dj', dj_name: null, real_name: 'Bob Smith' }),
        rawRow({ id: 'u3', name: 'Anonymous', username: null, dj_name: null, real_name: null, is_anonymous: true }),
      ])
      .mockResolvedValue({ count: 1 });

    const summary = await runBackfill({ dryRun: false });

    expect(summary).toEqual({ scanned: 3, updated: 1, skipped: 2, dryRun: false });
    // SELECT + one UPDATE (u1 only — u2 already matches its derived value, u3 is anonymous).
    expect((db.execute as jest.Mock).mock.calls.length).toBe(2);
    const updateCall = (db.execute as jest.Mock).mock.calls[1];
    const serialized = JSON.stringify(updateCall?.[0]);
    expect(serialized).toContain('u1');
    expect(serialized).toContain('DJ Jazzy Jane');
  });

  it('computes the same summary in dry-run mode but issues no UPDATE', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      rawRow({ id: 'u1', name: 'Jane Doe', username: 'jane_dj', dj_name: 'DJ Jazzy Jane', real_name: 'Jane Doe' }),
    ]);

    const summary = await runBackfill({ dryRun: true });

    expect(summary).toEqual({ scanned: 1, updated: 1, skipped: 0, dryRun: true });
    // Only the SELECT — dry-run issues no write.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
  });
});
