import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';

/**
 * BS#2231: the CTA cascade arm's SELECT must project every column its return
 * type promises.
 *
 * `searchLibraryByCTARaw` reaches `TaggedLibraryViewEntry` through a raw
 * `db.execute` result. Raw SQL is opaque to `tsc`, so nothing in the type
 * system relates the SELECT's column list to the fields that type declares:
 * every column the SELECT forgets becomes `undefined` at runtime behind a
 * non-nullable declaration, with no compile error. It cost `artist_id`
 * (BS#2228) and, since BS#1895, the three `discogs*` columns.
 *
 * The fix is structural, in three links. `LIBRARY_VIEW_PROJECTION` is
 * constrained to cover every key of `LibraryArtistViewEntry`;
 * `LIBRARY_VIEW_PROJECTION_RAW` is derived from it; the CTA arm interpolates
 * that one constant instead of hand-rolling a list. The first two links fail
 * the build when broken. The third can't — a hand-rolled list type-checks
 * fine — so this file pins it.
 *
 * What this file cannot prove is that a projected column arrives with a value:
 * the unit suite's `db.execute` never runs the statement it captures, and its
 * fixtures supply row fields by hand. That assertion lives against real SQL in
 * `tests/integration/library-query.spec.js`.
 */

const spanInstance = { setAttribute: jest.fn(), setAttributes: jest.fn() };
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: unknown, callback: (span: unknown) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance)),
  getActiveSpan: () => spanInstance,
}));

import { searchLibraryByCTARaw, LIBRARY_VIEW_PROJECTION_RAW } from '../../../apps/backend/services/library.service';

/**
 * The CTA statement, picked out of the `db.execute` calls by its own columns.
 *
 * `searchLibraryByCTARaw` awaits `checkLibraryArtistNameHealth()` first, whose
 * two probes issue their own calls — but memoize, so the CTA statement's index
 * in `mock.calls` differs between the first test in a file and the rest.
 * Selecting by content keeps each case independent of that memoization.
 */
function capturedCtaSql(): string {
  const rendered = db.execute.mock.calls.map((call) => renderSql(call[0]));
  const match = rendered.find((text) => text.includes('cta_track_title'));
  if (match === undefined) {
    throw new Error(`no CTA statement among ${rendered.length} db.execute call(s)`);
  }
  return match;
}

describe('searchLibraryByCTARaw: shared view projection (BS#2231)', () => {
  beforeEach(() => {
    db.execute.mockReset();
    db.execute.mockResolvedValue([]);
  });

  it('interpolates the shared projection rather than a hand-rolled column list', async () => {
    // The structural assertion, and the reason the per-column ones below stay
    // short: with the shared constant interpolated, a column added to
    // `LibraryArtistViewEntry` reaches this SELECT without anyone remembering
    // to come here. A hand-rolled list that happens to be complete today is
    // exactly how the defect shipped twice.
    await searchLibraryByCTARaw('Bioluminescence', 5);

    expect(capturedCtaSql()).toContain(renderSql(LIBRARY_VIEW_PROJECTION_RAW));
  });

  // The four columns that actually went missing, named so a regression reads
  // as itself rather than as a diff of the whole SELECT.
  it.each(['artist_id', 'discogs_unavailable', 'discogs_unavailable_note', 'last_discogs_recheck_at'])(
    'projects %s',
    async (alias) => {
      await searchLibraryByCTARaw('Bioluminescence', 5);

      expect(capturedCtaSql()).toContain(`AS "${alias}"`);
    }
  );

  it('still projects the CTA-only join columns alongside the shared projection', async () => {
    await searchLibraryByCTARaw('Bioluminescence', 5);

    // Read back by the grouping pass below the query, so they have to survive
    // the switch to the shared projection.
    const text = capturedCtaSql();
    expect(text).toContain('AS cta_track_title');
    expect(text).toContain('AS cta_artist_name');
  });
});
