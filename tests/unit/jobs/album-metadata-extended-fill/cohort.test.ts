/**
 * The extended fill's cohort SQL, as text (BS#1442).
 *
 * The predicate is the job's whole definition of "a row this job can still
 * add to", so its shape is pinned here. Behaviour against real Postgres is
 * `tests/integration/album-metadata-extended-fill.spec.js`.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect } from '@jest/globals';
import {
  cohortPredicateSql,
  cohortStatsSql,
  enumerateCohortSql,
} from '../../../../jobs/album-metadata-extended-fill/cohort';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('cohortPredicateSql', () => {
  it('is a parseable release URL and at least one fillable NULL column', () => {
    expect(flat(cohortPredicateSql())).toBe(
      flat(`"discogs_url" ~ '/release/[0-9]+'
       AND ("tracklist" IS NULL OR "genres" IS NULL OR "styles" IS NULL OR "label" IS NULL
         OR "full_release_date" IS NULL OR "discogs_artist_id" IS NULL
         OR "artist_image_url" IS NULL
         OR ("bio_tokens" IS NULL AND "artist_bio" IS NOT NULL))`)
    );
  });
});

describe('cohortStatsSql', () => {
  it('counts the cohort and each NULL column over the same predicate', () => {
    const statement = cohortStatsSql();

    expect(statement).toContain(cohortPredicateSql());
    expect(statement).toContain('count(*)::int AS cohort');
    for (const column of ['tracklist', 'genres', 'styles', 'label', 'full_release_date', 'discogs_artist_id']) {
      expect(statement).toContain(`FILTER (WHERE "${column}" IS NULL)::int AS ${column}`);
    }
    // A row with no bio never gets tokens, so it is not counted as missing them.
    expect(flat(statement)).toContain(
      `FILTER (WHERE ("bio_tokens" IS NULL AND "artist_bio" IS NOT NULL))::int AS bio_tokens`
    );
  });
});

describe('enumerateCohortSql', () => {
  it('selects the stored URL the write guards on, in album_id order above the cursor', () => {
    const statement = enumerateCohortSql(25, 1442);

    expect(statement).toContain('"discogs_url" AS discogs_url');
    // The pin gate keys on the catalog card id, not library.id.
    expect(statement).toMatch(
      /SELECT l\."legacy_release_id" FROM .*"library" l WHERE l\."id" = "album_metadata"\."album_id"\) AS legacy_release_id/
    );
    expect(statement).toContain(cohortPredicateSql());
    expect(statement).toContain('"album_id" > 1442');
    expect(statement).toMatch(/ORDER BY "album_id"\s+LIMIT 25$/);
  });

  it('has no LIMIT when the cap is 0', () => {
    expect(enumerateCohortSql(0, 0)).not.toContain('LIMIT');
  });

  it.each([
    ['a retry list with no cursor', 0, [7, 9], `"album_id" > 0 AND "album_id" IN (7, 9)`],
    ['a list carried into a cursor run', 100, [7, 9], `("album_id" > 100 OR "album_id" IN (7, 9))`],
  ])('narrows by %s', (_label, cursor, ids, expected) => {
    expect(flat(enumerateCohortSql(0, cursor, ids))).toContain(expected);
  });

  it.each([
    ['limit', () => enumerateCohortSql(-1, 0)],
    ['afterAlbumId', () => enumerateCohortSql(0, 1.5)],
    ['albumIds', () => enumerateCohortSql(0, 0, [Number.NaN])],
  ])('refuses a %s that is not a non-negative integer, since it is interpolated', (_label, build) => {
    expect(build).toThrow(/non-negative integer/);
  });
});
