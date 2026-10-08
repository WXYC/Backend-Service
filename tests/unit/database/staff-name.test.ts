/**
 * Unit tests for the staff-name helper (shared/database/src/staff-name.ts, BS#3051).
 *
 * The real-name-else-`auth_user.name` choice is made by Postgres, so a fake handle cannot decide it on its own. `fakeHandle`
 * renders the fragment `readStaffName` selects with the real dialect and EVALUATES it against a stored row, the way Postgres
 * would: `coalesce` picks the first non-null argument, `nullif(x, '')` turns an empty string into null, and `btrim(x, set)`
 * strips the characters in `set` (just the space when it has no set, as in Postgres) from both ends. A fragment this fake does
 * not recognise throws, so a changed fragment fails loudly instead of being mis-modelled. That makes the parameterized cases
 * able to fail when the SQL is wrong: a fragment that returns `name` only fails the real-name case, one without the
 * `nullif(btrim(...))` guard fails the blank cases, and one with the old space-only `btrim(x)` fails the tab, newline and NBSP
 * cases. The same choice against real rows is `tests/integration/dj-real-name-sentinel.spec.js`.
 */

jest.unmock('drizzle-orm');

import { PgDialect, alias } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { user } from '../../../shared/database/src/schema';
import { AUTHOR_MAX, readStaffName, snapshotAuthor, staffNameSql } from '../../../shared/database/src/staff-name';

const dialect = new PgDialect();

type StoredAccount = { name: string | null; realName: string | null };

const NAME = '"auth_user"."name"';
const REAL = '"auth_user"."real_name"';
/** The strip set `staffNameSql` spells out: space, tab, LF, CR, NBSP. */
const STRIP = 'chr(32) || chr(9) || chr(10) || chr(13) || chr(160)';

/** `chr(32) || chr(9) || ...` as the string those calls build. */
const chrList = (list: string) =>
  list.split(' || ').map((c) => String.fromCodePoint(Number(c.slice('chr('.length, -1))));

/** Postgres `btrim(value, set)`: strips every leading and trailing character found in `set`. */
const btrim = (value: string | null, set: string) => {
  if (value === null) return null;
  const chars = new Set(set);
  const cps = [...value];
  let from = 0;
  let to = cps.length;
  while (from < to && chars.has(cps[from])) from++;
  while (to > from && chars.has(cps[to - 1])) to--;
  return cps.slice(from, to).join('');
};

/** Evaluates the three fragment shapes `staffNameSql` has had (or could regress to) against one stored account. */
const evaluate = (text: string, stored: StoredAccount): string | null => {
  if (text === NAME) return stored.name;
  if (text === `coalesce(${REAL}, ${NAME})`) return stored.realName ?? stored.name;
  const guarded = new RegExp(
    `^coalesce\\(nullif\\(btrim\\(${REAL}(?:, ((?:chr\\(\\d+\\)(?: \\|\\| )?)+))?\\), ''\\), ${NAME}\\)$`
  ).exec(text);
  if (!guarded) throw new Error(`fakeHandle cannot evaluate this fragment: ${text}`);
  const stripped = btrim(stored.realName, guarded[1] ? chrList(guarded[1]).join('') : ' ');
  return (stripped === '' ? null : stripped) ?? stored.name;
};

/** A `select` handle over one stored account (or none) that evaluates the selected `name` fragment the way Postgres reads it. */
const fakeHandle = (stored: StoredAccount | undefined) => ({
  select: (fields: { name: SQL }) => ({
    from: () => ({
      where: () => Promise.resolve(stored ? [{ name: evaluate(dialect.sqlToQuery(fields.name).sql, stored) }] : []),
    }),
  }),
});

describe('staffNameSql', () => {
  test('is the real name when it holds text, else auth_user.name, with the guard on blank real names', () => {
    expect(dialect.sqlToQuery(staffNameSql(user)).sql).toBe(`coalesce(nullif(btrim(${REAL}, ${STRIP}), ''), ${NAME})`);
  });

  test('qualifies both columns by the alias it is given, for a join', () => {
    expect(dialect.sqlToQuery(staffNameSql(alias(user, 'author'))).sql).toBe(
      `coalesce(nullif(btrim("author"."real_name", ${STRIP}), ''), "author"."name")`
    );
  });
});

describe('readStaffName', () => {
  test.each([
    ['a real name', { name: 'Test Handle', realName: 'Test Reviewer' }, 'Test Reviewer'],
    ['a null real name', { name: 'Test Handle', realName: null }, 'Test Handle'],
    ['an empty real name', { name: 'Test Handle', realName: '' }, 'Test Handle'],
    ['a whitespace-only real name', { name: 'Test Handle', realName: '   ' }, 'Test Handle'],
    ['a tab-only real name', { name: 'Test Handle', realName: '\t' }, 'Test Handle'],
    ['a newline-only real name', { name: 'Test Handle', realName: '\n' }, 'Test Handle'],
    ['a CRLF-only real name', { name: 'Test Handle', realName: '\r\n' }, 'Test Handle'],
    ['a non-breaking-space-only real name', { name: 'Test Handle', realName: '\u00a0' }, 'Test Handle'],
    ['a mixed-whitespace real name', { name: 'Test Handle', realName: ' \t\n\r\u00a0 ' }, 'Test Handle'],
    [
      'a real name padded with whitespace, which comes back trimmed',
      { name: 'Test Handle', realName: ' \tTest Reviewer\u00a0 ' },
      'Test Reviewer',
    ],
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
