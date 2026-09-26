/**
 * BS#2398, catalog half — the same byte-exact `=` that made quoted playlist
 * search case-sensitive is in the `GET /library/query` builder too, at two
 * sites rather than three. A librarian typing a release title in lower case
 * inside quotes got a silent empty page and no way to tell whether the release
 * was missing or their shift key was.
 *
 * Sibling to `search.service.exactMatch.test.ts`, which carries the reasoning
 * for asserting over the rendered predicate; result-set identity across
 * casings is pinned in
 * `tests/integration/search-exact-case-insensitive.spec.js`.
 *
 * These assertions name the operator and count its occurrences instead of
 * naming the columns, because most of the `library_artist_view` double's
 * columns are absent and render as the empty string — and filling them in is
 * not a free fix: the double's own docblock records that a complete double
 * would have disarmed the suite guarding wrong-table substitution (BS#2448).
 * Which columns the branch reaches is not what this change touches; the
 * operator is.
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';

// The cascade is a separate read path with its own suites, and a quoted term
// fails the cascade gate anyway; the primary SELECT carries the predicate.
jest.mock('../../../apps/backend/services/library.service', () => ({
  runCatalogTrackSearchCascade: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
}));

type SpanLike = { setAttribute: jest.Mock; setAttributes: jest.Mock };
type SpanOpts = { name: string; op: string; attributes?: Record<string, unknown> };
const spanInstance: SpanLike = { setAttribute: jest.fn(), setAttributes: jest.fn() };
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance)),
  getActiveSpan: () => spanInstance,
}));

import { searchLibrary } from '../../../apps/backend/services/library-search.service';

/** Renders the data query `searchLibrary` compiled for `q` (call 0; call 1 is the count). */
async function predicateFor(q: string): Promise<string> {
  db.execute.mockReset();
  db.execute.mockResolvedValue([]);
  await searchLibrary({ q, page: 0, limit: 20, sort: 'artist', order: 'asc' });
  return renderSql(db.execute.mock.calls[0][0]);
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('searchLibrary: quoted terms are case-insensitive (BS#2398)', () => {
  it('matches a quoted all-field term case-insensitively once per searched column', async () => {
    const sql = await predicateFor('"cat power"');

    // artist / album / label — the three columns buildAllFieldMatch ORs over.
    expect(occurrences(sql, 'ILIKE cat power ESCAPE')).toBe(3);
  });

  it('matches a quoted field-prefixed term case-insensitively', async () => {
    const sql = await predicateFor('artist:"cat power"');

    expect(occurrences(sql, 'ILIKE cat power ESCAPE')).toBe(1);
  });

  it.each([
    ['all-field', '"cat power"'],
    ['field-prefixed', 'artist:"cat power"'],
  ])('leaves no byte-exact %s comparison behind', async (_label, q) => {
    const sql = await predicateFor(q);

    // The whole defect in one assertion: `= <value>` is the byte-exact form,
    // and a single surviving site is enough to reproduce the report.
    expect(sql).not.toContain('= cat power');
  });

  it('still means whole-value, not contains', async () => {
    // Quoting narrows the match; only the case-sensitivity was wrong. A
    // wildcard-wrapped pattern here would silently turn every quoted term
    // back into a substring search.
    const sql = await predicateFor('artist:"cat"');

    expect(sql).toContain('ILIKE cat ESCAPE');
    expect(sql).not.toContain('ILIKE %cat%');
  });

  it('matches LIKE metacharacters in a quoted value literally', async () => {
    // Under `=` a quoted `%` or `_` was literal by luck, because `=` has no
    // pattern language at all. ILIKE does, so the escaping has to be explicit
    // or `"100%_pure"` becomes a wildcard search.
    const sql = await predicateFor('album:"100%_pure"');

    expect(sql).toContain('ILIKE 100\\%\\_pure ESCAPE');
  });
});
