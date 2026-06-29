/**
 * Drift guard for the Phase-2 catalog-popularity *logical-album key* (BS#1486 /
 * #1505).
 *
 * The key — the `master:<id>` / `release:<id>` / `library:<id>` string that
 * collapses pressings of one album into a single popularity count — was once
 * hand-written in three places that had to stay in agreement, with no type or
 * compile error to catch drift: a divergence just silently nulls the nullable
 * `popularity` column, indistinguishable from a legitimately-absent signal.
 *
 * #1505 collapsed the two SQL sites (the catalog-export reader JOIN and the
 * album_popularity-rebuild writer GROUP BY) into ONE `logicalAlbumKeySql`
 * builder; `freetextLogicalKey` stays the JS form of the free-text leg.
 *
 * This is a UNIT suite, so it does NOT touch Postgres — `drizzle-orm` is
 * auto-mocked (`tests/__mocks__/drizzle-orm.ts`), so `sql` only CAPTURES its
 * template (`{ sql, values }`) and never evaluates it. Be precise about what
 * that does and does not buy:
 *
 *   - PINNED HERE: the builder renders to one canonical CASE — so a change to the
 *     SQL-text derivation (strip pattern, NULL fallback, an added branch) fails
 *     loudly. Both production sites consume this one builder, so they share its
 *     derivation by construction; that they keep consuming it (rather than
 *     re-inlining a divergent CASE) is enforced by code review and the pg specs,
 *     not by this unit suite. And `freetextLogicalKey` returns the documented
 *     master:/release:/null keys.
 *   - NOT PINNED HERE: that the SQL CASE, run by Postgres, actually EVALUATES
 *     `discogs:master:<id>` to `master:<id>` — and therefore that the SQL key and
 *     the free-text JS key are truly equal strings. That is proven by the pg
 *     specs `tests/integration/library-catalog-export.spec.js` and
 *     `album-popularity-refresh.spec.js`. The `sqlKeyForCanonical` model below is
 *     a hand-maintained stand-in for that evaluation, kept honest by code review
 *     against `PINNED_CASE`, not mechanically.
 */
import { describe, test, expect } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { logicalAlbumKeySql, freetextLogicalKey } from '../../../apps/backend/services/logical-album-key.service';

// Shape of the auto-mock's captured `sql` template (NOT a real drizzle `SQL`).
type CapturedSql = { sql: readonly string[]; values: unknown[] };
type RawValue = { raw: string };

// Render the auto-mock's capture back to text: interleave the template strings
// with each `sql.raw(...)` chunk's literal. This file only ever feeds `sql.raw`,
// so every interpolated value is a `{ raw }` (the production reader's Drizzle
// column refs are NOT, but that call is exercised against real Postgres in the
// pg specs, not here). This is a different mock shape than the inline
// `{ __sql, text }` mock in `album-popularity-refresh.service.test.ts`, so the
// two render helpers are deliberately separate rather than shared.
const renderMockSql = (fragment: unknown): string => {
  const { sql: strings, values } = fragment as CapturedSql;
  return strings.map((chunk, i) => `${chunk}${i < values.length ? (values[i] as RawValue).raw : ''}`).join('');
};

const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim();
const renderKey = (canonicalExpr: string, idExpr: string): string =>
  normalizeWs(renderMockSql(logicalAlbumKeySql(sql.raw(canonicalExpr), sql.raw(idExpr))));

// The CASE the builder renders, with neutral CANON/LID tokens in the column
// slots. Whitespace-normalized, so re-indenting doesn't churn it; a change to
// the operators does.
const PINNED_CASE =
  "CASE WHEN CANON LIKE 'discogs:%' THEN substring(CANON from 'discogs:(.*)') " +
  "WHEN CANON IS NOT NULL THEN CANON ELSE 'library:' || LID::text END";

// Hand-maintained model of the rendered CASE, used only to make the SQL-vs-JS
// equivalence executable without Postgres. It mirrors PINNED_CASE branch for
// branch (`substring(x from 'discogs:(.*)')` = strip the `discogs:` prefix). It
// is NOT mechanically tied to the production fragment — the pg specs are what
// prove the real SQL evaluates this way; keep it in step with PINNED_CASE.
const sqlKeyForCanonical = (canonicalEntityId: string | null, libraryId: number): string => {
  if (canonicalEntityId !== null && canonicalEntityId.startsWith('discogs:')) {
    return canonicalEntityId.slice('discogs:'.length);
  }
  if (canonicalEntityId !== null) return canonicalEntityId;
  return `library:${libraryId}`;
};

// All three CASE branches. `master`/`release` are the resolved Discogs ids the
// free-text leg keys off; `canonical` is the `canonical_entity_id` the SQL keys
// off. For the master/release rows the two encode the SAME logical album (the
// `master` row also carries a `release` to pin master-wins), so the two legs
// must produce the same key.
const CASES = [
  { name: 'master', canonical: 'discogs:master:123', id: 1, master: 123, release: 999, expectedKey: 'master:123' },
  { name: 'release', canonical: 'discogs:release:456', id: 2, master: null, release: 456, expectedKey: 'release:456' },
  {
    name: 'other-scheme',
    canonical: 'spotify:album:abc',
    id: 3,
    master: null,
    release: null,
    expectedKey: 'spotify:album:abc',
  },
  { name: 'NULL-fallback', canonical: null, id: 4, master: null, release: null, expectedKey: 'library:4' },
] as const;

describe('logicalAlbumKeySql renders one canonical derivation', () => {
  test('the builder renders the pinned CASE', () => {
    // Both production sites pass their own column expressions into this builder
    // (the reader Drizzle column refs, the writer raw aliased SQL); rendering it
    // here with neutral tokens pins the derivation those sites share. The actual
    // call-site SQL — the reader JOIN and the writer INSERT — is exercised
    // against real Postgres in the pg specs, which the auto-mock precludes here.
    expect(renderKey('CANON', 'LID')).toBe(PINNED_CASE);
  });
});

describe('freetextLogicalKey agrees with the SQL key model', () => {
  test.each(CASES)('the SQL model yields the documented key ($name)', ({ canonical, id, expectedKey }) => {
    expect(sqlKeyForCanonical(canonical, id)).toBe(expectedKey);
  });

  test.each(CASES)('freetextLogicalKey matches the SQL key for resolved inputs ($name)', (c) => {
    if (c.master === null && c.release === null) {
      // No resolved master/release: the free-text leg drops the row entirely
      // (unattributable). There is no canonical-string analogue to compare.
      expect(freetextLogicalKey({ discogs_master_id: c.master, discogs_release_id: c.release })).toBeNull();
      return;
    }
    // The free-text key (off the resolved ids, master winning over release) must
    // equal the key the SQL model derives from the equivalent `discogs:` string.
    expect(freetextLogicalKey({ discogs_master_id: c.master, discogs_release_id: c.release })).toBe(
      sqlKeyForCanonical(c.canonical, c.id)
    );
  });
});
