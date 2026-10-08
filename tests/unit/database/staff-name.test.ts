/**
 * Unit tests for the staff-name helper (shared/database/src/staff-name.ts, BS#3051).
 *
 * The real-name-else-`auth_user.name` choice is made by Postgres, so a fake handle cannot decide it on its own. `fakeHandle`
 * renders the fragment `readStaffName` selects with the real dialect and applies what that SQL says to a stored row: the
 * `nullif(btrim(...))` guard turns an empty or whitespace-only real name into "absent" before `coalesce` picks. Remove the
 * guard from the fragment and the fallback cases here fail, which is the point. The same choice against real rows is
 * `tests/integration/dj-real-name-sentinel.spec.js`.
 */

jest.unmock('drizzle-orm');

import { PgDialect, alias } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { user } from '../../../shared/database/src/schema';
import { AUTHOR_MAX, readStaffName, snapshotAuthor, staffNameSql } from '../../../shared/database/src/staff-name';

const dialect = new PgDialect();

type StoredAccount = { name: string | null; realName: string | null };

/** A `select` handle over one stored account (or none) that evaluates the selected `name` fragment the way Postgres reads it. */
const fakeHandle = (stored: StoredAccount | undefined) => ({
  select: (fields: { name: SQL }) => ({
    from: () => ({
      where: () => {
        if (!stored) return Promise.resolve([]);
        const text = dialect.sqlToQuery(fields.name).sql;
        const guarded = text.includes('nullif(btrim(') && text.startsWith('coalesce(');
        const real = guarded && stored.realName?.trim() === '' ? null : stored.realName;
        return Promise.resolve([{ name: real ?? stored.name }]);
      },
    }),
  }),
});

describe('staffNameSql', () => {
  test('is the real name when it holds text, else auth_user.name, with the guard on blank real names', () => {
    expect(dialect.sqlToQuery(staffNameSql(user)).sql).toBe(
      `coalesce(nullif(btrim("auth_user"."real_name"), ''), "auth_user"."name")`
    );
  });

  test('qualifies both columns by the alias it is given, for a join', () => {
    expect(dialect.sqlToQuery(staffNameSql(alias(user, 'author'))).sql).toBe(
      `coalesce(nullif(btrim("author"."real_name"), ''), "author"."name")`
    );
  });
});

describe('readStaffName', () => {
  test.each([
    ['a real name', { name: 'Test Handle', realName: 'Test Reviewer' }, 'Test Reviewer'],
    ['a null real name', { name: 'Test Handle', realName: null }, 'Test Handle'],
    ['an empty real name', { name: 'Test Handle', realName: '' }, 'Test Handle'],
    ['a whitespace-only real name', { name: 'Test Handle', realName: '   ' }, 'Test Handle'],
    ['a real name over 128 code points', { name: 'Test Handle', realName: '😀'.repeat(200) }, '😀'.repeat(AUTHOR_MAX)],
    ['no real name and a name over 128 code points', { name: 'n'.repeat(200), realName: null }, 'n'.repeat(AUTHOR_MAX)],
  ])('reads %s', async (_label, stored, expected) => {
    expect(await readStaffName(fakeHandle(stored) as any, 'user-1')).toBe(expected);
  });

  test('is null for an account that is gone', async () => {
    expect(await readStaffName(fakeHandle(undefined) as any, 'missing')).toBeNull();
  });

  test('is null for an account with no name and no real name', async () => {
    expect(await readStaffName(fakeHandle({ name: null, realName: null }) as any, 'user-1')).toBeNull();
  });
});

describe('snapshotAuthor', () => {
  test('keeps a short name whole', () => {
    expect(snapshotAuthor('Cat Power')).toBe('Cat Power');
  });

  test.each([['a'], ['😀']])('cuts a 200-code-point name of %s to its first 128 code points', (ch) => {
    const out = snapshotAuthor(ch.repeat(200));
    expect([...out]).toHaveLength(AUTHOR_MAX);
    expect(out).toBe(ch.repeat(128));
  });

  test('has no name to snapshot for a missing account', () => {
    expect(snapshotAuthor(undefined)).toBeNull();
  });
});
