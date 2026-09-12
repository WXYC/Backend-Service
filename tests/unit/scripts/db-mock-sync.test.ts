/**
 * Unit tests for the db-mock drift guard's comparison logic
 * (`tests/utils/db-mock-parity.ts`, run by `npm run check:db-mock-sync`).
 *
 * The logic is tested here rather than in the runner because `scripts/**` is
 * excluded from ESLint and `npm run typecheck` — the same split, for the same
 * reason, as `tests/unit/scripts/better-auth-mock-sync.test.ts`.
 *
 * Two halves are covered:
 *
 *  1. `compareDbMock` against hand-built inputs — including the cases that
 *     make the allowlist shrink-only, which is what stops it decaying into a
 *     permanent exemption list.
 *  2. `parseMockDoubles` against the REAL `tests/mocks/database.mock.ts`, and
 *     the real allowlist against the REAL `schema.ts`. Without that second
 *     half the guard could be perfectly correct about inputs it never sees —
 *     precisely the "compares the mock to itself" failure it exists to close.
 */
// The unit harness resolves 'drizzle-orm' to tests/__mocks__/drizzle-orm.ts,
// which models the `sql` tag and the comparison helpers but carries no `is`,
// `Table`, or `getTableColumns`. Reading the real schema's column sets needs
// the real library — same reason, same mechanism, as
// tests/unit/database/last-logged-show-entry.test.ts.
jest.unmock('drizzle-orm');

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableColumns, getViewSelectedFields, is, Table, View } from 'drizzle-orm';

import { compareDbMock, groupFindings, parseMockDoubles, type DbMockAllowlist } from '../../utils/db-mock-parity';
import { DB_MOCK_ALLOWLIST } from '../../utils/db-mock-allowlist';
import * as schema from '../../../shared/database/src/schema';

const EMPTY_ALLOWLIST: DbMockAllowlist = { missingDoubles: [], missingColumns: {} };

const doubles = (spec: Record<string, Record<string, string>>) =>
  new Map(Object.entries(spec).map(([table, columns]) => [table, new Map(Object.entries(columns))]));

const tables = (spec: Record<string, string[]>) => new Map(Object.entries(spec));

describe('compareDbMock', () => {
  it('reports nothing when every double matches its table', () => {
    const findings = compareDbMock(
      tables({ rotation: ['id', 'album_id'] }),
      doubles({ rotation: { id: 'rotation.id', album_id: 'rotation.album_id' } }),
      EMPTY_ALLOWLIST
    );
    expect(findings).toEqual([]);
  });

  it('flags a column the schema has and the double lacks', () => {
    // The BS#2409 case verbatim: schema.ts gained `format_id`, the double
    // did not, and the test pinning the widened projection passed anyway.
    const findings = compareDbMock(
      tables({ rotation: ['id', 'format_id'] }),
      doubles({ rotation: { id: 'rotation.id' } }),
      EMPTY_ALLOWLIST
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing-column');
    expect(findings[0].detail).toContain('rotation.format_id');
  });

  it('flags a schema table with no double at all', () => {
    const findings = compareDbMock(tables({ dj_stats: ['id'] }), doubles({}), EMPTY_ALLOWLIST);
    expect(findings.map((f) => f.kind)).toEqual(['missing-double']);
  });

  it('flags a double whose name is not a table in the schema', () => {
    // A renamed or dropped table, or a typo — the double would otherwise sit
    // there forever, silently backing assertions against nothing real.
    const findings = compareDbMock(tables({}), doubles({ rotatoin: { id: 'rotatoin.id' } }), EMPTY_ALLOWLIST);
    expect(findings.map((f) => f.kind)).toEqual(['unknown-double']);
  });

  it('flags a sentinel that is not qualified by its own table', () => {
    const findings = compareDbMock(
      tables({ rotation: ['label_id'] }),
      doubles({ rotation: { label_id: 'label_id' } }),
      EMPTY_ALLOWLIST
    );
    expect(findings.map((f) => f.kind)).toEqual(['unqualified-sentinel']);
  });

  it('flags a sentinel qualified by a DIFFERENT table (the copy-paste mistake)', () => {
    // This is the one that matters: `'library.label_id'` sitting on the
    // `rotation` double reintroduces exactly the collision qualification
    // removed, and it looks entirely plausible in review.
    const findings = compareDbMock(
      tables({ rotation: ['label_id'] }),
      doubles({ rotation: { label_id: 'library.label_id' } }),
      EMPTY_ALLOWLIST
    );
    expect(findings.map((f) => f.kind)).toEqual(['unqualified-sentinel']);
  });

  it('accepts a sentinel whose suffix differs from its key (the `user` camelCase mapping)', () => {
    // `user.emailVerified` is `'user.email_verified'`: the suffix is the DB
    // column name, not the drizzle property key. Only the qualifier is pinned.
    const findings = compareDbMock(
      tables({ user: ['emailVerified'] }),
      doubles({ user: { emailVerified: 'user.email_verified' } }),
      EMPTY_ALLOWLIST
    );
    expect(findings).toEqual([]);
  });

  describe('allowlist', () => {
    it('suppresses an allowlisted missing column', () => {
      const findings = compareDbMock(
        tables({ rotation: ['id', 'format_id'] }),
        doubles({ rotation: { id: 'rotation.id' } }),
        { missingDoubles: [], missingColumns: { rotation: ['format_id'] } }
      );
      expect(findings).toEqual([]);
    });

    it('suppresses an allowlisted absent double', () => {
      const findings = compareDbMock(tables({ dj_stats: ['id'] }), doubles({}), {
        missingDoubles: ['dj_stats'],
        missingColumns: {},
      });
      expect(findings).toEqual([]);
    });

    it('still flags a NON-allowlisted column on a table that has allowlisted ones', () => {
      // The allowlist is per-column, not per-table — otherwise one legacy
      // entry would blanket-exempt every column added to that table later.
      const findings = compareDbMock(tables({ rotation: ['format_id', 'label_id'] }), doubles({ rotation: {} }), {
        missingDoubles: [],
        missingColumns: { rotation: ['format_id'] },
      });
      expect(findings.map((f) => f.detail)).toEqual([expect.stringContaining('rotation.label_id')]);
    });

    it('flags an entry for a column the double now declares — the list may only shrink', () => {
      const findings = compareDbMock(
        tables({ rotation: ['format_id'] }),
        doubles({ rotation: { format_id: 'rotation.format_id' } }),
        { missingDoubles: [], missingColumns: { rotation: ['format_id'] } }
      );
      expect(findings.map((f) => f.kind)).toEqual(['stale-allowlist']);
      expect(findings[0].detail).toContain('the double now declares it');
    });

    it('flags an entry for a column the schema no longer declares', () => {
      const findings = compareDbMock(tables({ rotation: ['id'] }), doubles({ rotation: { id: 'rotation.id' } }), {
        missingDoubles: [],
        missingColumns: { rotation: ['dropped_column'] },
      });
      expect(findings.map((f) => f.kind)).toEqual(['stale-allowlist']);
      expect(findings[0].detail).toContain('no longer declares');
    });

    it('flags an absent-double entry once the double exists', () => {
      const findings = compareDbMock(tables({ dj_stats: ['id'] }), doubles({ dj_stats: { id: 'dj_stats.id' } }), {
        missingDoubles: ['dj_stats'],
        missingColumns: {},
      });
      expect(findings.map((f) => f.kind)).toEqual(['stale-allowlist']);
      expect(findings[0].detail).toContain('the double now exists');
    });

    it('flags an absent-double entry for a table the schema no longer has', () => {
      const findings = compareDbMock(tables({}), doubles({}), { missingDoubles: ['gone'], missingColumns: {} });
      expect(findings.map((f) => f.kind)).toEqual(['stale-allowlist']);
    });

    it('flags a table listed in BOTH missingDoubles and missingColumns as redundant', () => {
      const findings = compareDbMock(tables({ dj_stats: ['id'] }), doubles({}), {
        missingDoubles: ['dj_stats'],
        missingColumns: { dj_stats: ['id'] },
      });
      expect(findings.map((f) => f.kind)).toEqual(['stale-allowlist']);
      expect(findings[0].detail).toContain('BOTH');
    });
  });
});

describe('parseMockDoubles', () => {
  it('collects exported object literals and their string values', () => {
    const parsed = parseMockDoubles(`
      export const rotation = { id: 'rotation.id', album_id: 'rotation.album_id' };
      export const labels = {};
    `);
    expect([...parsed.keys()].sort()).toEqual(['labels', 'rotation']);
    expect(parsed.get('rotation')?.get('album_id')).toBe('rotation.album_id');
    expect(parsed.get('labels')?.size).toBe(0);
  });

  it('ignores non-object exports, and object literals that are not exported', () => {
    const parsed = parseMockDoubles(`
      export const db = createMockDb();
      export const helper = () => ({ id: 'id' });
      const internal = { id: 'internal.id' };
      export const rotation = { id: 'rotation.id' };
    `);
    expect([...parsed.keys()]).toEqual(['rotation']);
  });

  it('records a column whose value is not a string literal, with an empty sentinel', () => {
    // The column IS declared (so it is not the `undefined` hazard), but it
    // cannot be a valid sentinel — `compareDbMock` flags it as unqualified.
    const parsed = parseMockDoubles(`export const rotation = { id: someExpression };`);
    expect(parsed.get('rotation')?.get('id')).toBe('');
  });
});

describe('the REAL mock, allowlist and schema', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const realDoubles = parseMockDoubles(readFileSync(path.join(repoRoot, 'tests/mocks/database.mock.ts'), 'utf8'));

  const realTables = new Map<string, string[]>();
  for (const [name, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!value) continue;
    if (is(value as never, Table)) realTables.set(name, Object.keys(getTableColumns(value as never)));
    else if (is(value as never, View)) realTables.set(name, Object.keys(getViewSelectedFields(value as never)));
  }

  it('extracts a plausible number of doubles and tables (guards against a silent empty parse)', () => {
    // An empty extraction would make the guard pass forever — the same
    // vacuity, one level up. The runner exits 4 on this; assert it here too so
    // a parser regression fails in the suite as well.
    expect(realDoubles.size).toBeGreaterThan(40);
    expect(realTables.size).toBeGreaterThan(50);
  });

  it('is conformant under the shipped allowlist', () => {
    // Mirrors exactly what `npm run check:db-mock-sync` asserts, so a drift
    // introduced alongside a test change fails the suite too, not only the
    // pre-push hook (which `--no-verify` can skip).
    const findings = compareDbMock(realTables, realDoubles, DB_MOCK_ALLOWLIST);
    expect(findings.map((f) => `[${f.kind}] ${f.detail}`)).toEqual([]);
  });

  it('would flag the BS#2409 regression if the rotation double lost format_id again', () => {
    // The acceptance case from #2448, now asserted in its second form. This
    // test used to drop the two columns from the ALLOWLIST, because the double
    // still lacked them and the allowlist was what covered them. PR #2443 has
    // since added both to the double and the stale entries were deleted, so
    // there is no allowlist entry left to remove — re-deleting one now proves
    // nothing. What the guard must still catch is the original regression
    // itself: a column `schema.ts` declares that the double does not. So the
    // deletion moves to the double, which is where BS#2409 made it.
    const rotationDouble = new Map(realDoubles.get('rotation'));
    rotationDouble.delete('format_id');
    rotationDouble.delete('label_id');
    const regressedDoubles = new Map(realDoubles).set('rotation', rotationDouble);

    const findings = compareDbMock(realTables, regressedDoubles, DB_MOCK_ALLOWLIST);
    expect(findings.map((f) => f.detail)).toEqual([
      expect.stringContaining('rotation.format_id'),
      expect.stringContaining('rotation.label_id'),
    ]);
    expect(findings.every((f) => f.kind === 'missing-column')).toBe(true);
  });
});

describe('groupFindings', () => {
  it('groups by kind, preserving order within each group', () => {
    const grouped = groupFindings([
      { kind: 'missing-column', table: 'a', detail: '1' },
      { kind: 'stale-allowlist', table: 'b', detail: '2' },
      { kind: 'missing-column', table: 'c', detail: '3' },
    ]);
    expect(grouped.get('missing-column')?.map((f) => f.detail)).toEqual(['1', '3']);
    expect(grouped.get('stale-allowlist')?.map((f) => f.detail)).toEqual(['2']);
    expect(grouped.get('unknown-double')).toBeUndefined();
  });
});
