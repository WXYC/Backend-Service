/**
 * BS#2398 — quoting a term narrows the match from "contains" to "is". It must
 * not also make it case-sensitive.
 *
 * Postgres `=` on text is byte-exact, so the three `exact` branches of the
 * flowsheet search builder used to answer `"hi scores"` with nothing while
 * answering `"Hi Scores"` with the release. Every unquoted sibling predicate
 * in the same file is already case-insensitive (ILIKE, or the `simple`
 * tsvector configuration, which folds case on both the document and the
 * query), and no part of the UI says quoting changes that.
 *
 * These assertions are phrased over the rendered predicate rather than over
 * returned rows because ILIKE's case-blindness is a property of the operator:
 * choosing it *is* the fix, and `db.execute` is a double here. Result-set
 * identity across casings — the claim a reader actually cares about — is
 * pinned against real Postgres in
 * `tests/integration/search-exact-case-insensitive.spec.js`.
 */
import { db } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet } from '../../../apps/backend/services/search.service';

/**
 * Renders the data query `searchFlowsheet` compiled for `q`.
 *
 * The rows are irrelevant — only the predicate is under test — but both
 * `db.execute` calls have to resolve or the service's `Promise.allSettled`
 * branch reports a count failure to Sentry instead of returning.
 */
async function predicateFor(q: string): Promise<string> {
  (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
  await searchFlowsheet({ q, page: 0, limit: 50, sort: 'date', order: 'desc' });
  return renderSql((db.execute as jest.Mock).mock.calls[0][0]);
}

describe('searchFlowsheet: quoted terms are case-insensitive (BS#2398)', () => {
  it('matches a quoted all-field term case-insensitively across all four columns', async () => {
    const sql = await predicateFor('"cat power"');

    for (const column of ['artist_name', 'track_title', 'album_title', 'record_label']) {
      expect(sql).toContain(`flowsheet.${column} ILIKE cat power ESCAPE`);
    }
  });

  it('matches a quoted field-prefixed term case-insensitively', async () => {
    const sql = await predicateFor('album:"cat power"');

    expect(sql).toContain('flowsheet.album_title ILIKE cat power ESCAPE');
  });

  it('matches a quoted dj: term case-insensitively', async () => {
    const sql = await predicateFor('dj:"cat power"');

    expect(sql).toContain('flowsheet.dj_name ILIKE cat power ESCAPE');
  });

  it.each([
    ['all-field', '"cat power"'],
    ['field-prefixed', 'album:"cat power"'],
    ['dj', 'dj:"cat power"'],
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
    const sql = await predicateFor('"cat"');

    expect(sql).toContain('flowsheet.artist_name ILIKE cat ESCAPE');
    expect(sql).not.toContain('ILIKE %cat%');
  });

  it('matches LIKE metacharacters in a quoted value literally', async () => {
    // Under `=` a quoted `%` or `_` was literal by luck, because `=` has no
    // pattern language at all. ILIKE does, so the escaping has to be explicit
    // or `"100%_pure"` becomes a wildcard search.
    const sql = await predicateFor('album:"100%_pure"');

    expect(sql).toContain('flowsheet.album_title ILIKE 100\\%\\_pure ESCAPE');
  });
});
