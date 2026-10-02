/**
 * The bio fill's cohort SQL, as text.
 *
 * Every read in this job and (from BS#2778) its one UPDATE share
 * `cohortPredicateSql`, so the predicate's exact shape is the job's whole
 * definition of "a row that needs a bio". These pin that shape and the three
 * things about the enumeration that are easy to get subtly wrong: which
 * artist-name column wins, that the card id is selected for the guard, and
 * that the resume cursor actually reaches the SQL.
 *
 * Behaviour against real Postgres is the integration spec's job (BS#2778).
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect } from '@jest/globals';
import {
  cohortPredicateSql,
  countCohortSql,
  countEligibleSql,
  enumerateCohortSql,
} from '../../../../jobs/album-metadata-bio-fill/cohort';

describe('cohortPredicateSql', () => {
  it('is exactly: a non-empty Discogs URL and no bio', () => {
    // Pinned as a literal. A third conjunct would silently narrow the fill,
    // and dropping the nullif would admit the synthetic-match '' sentinel.
    expect(cohortPredicateSql().replace(/\s+/g, ' ')).toBe(
      `nullif("discogs_url", '') IS NOT NULL AND "artist_bio" IS NULL`
    );
  });

  it('qualifies both columns with the alias, leaving no bare reference for a JOIN to misread', () => {
    const predicate = cohortPredicateSql('am');

    expect(predicate).toContain('am."discogs_url"');
    expect(predicate).toContain('am."artist_bio"');
    expect(predicate).not.toMatch(/(?<!am\.)"(discogs_url|artist_bio)"/);
  });
});

describe('count statements', () => {
  it('counts the cohort with the shared predicate and nothing else', () => {
    expect(countCohortSql()).toContain(cohortPredicateSql());
    expect(countCohortSql()).not.toContain('JOIN');
  });

  it('counts the drainable subset over the same FROM/WHERE the enumeration reads', () => {
    // The enumeration adds only the cursor conjunct after the shared block, so
    // the count's FROM/WHERE must be a prefix of the enumeration's.
    const fromOnward = (statement: string) => statement.slice(statement.indexOf('FROM'));

    expect(fromOnward(enumerateCohortSql(0, 0)).startsWith(fromOnward(countEligibleSql()))).toBe(true);
  });
});

describe('enumerateCohortSql', () => {
  const statement = enumerateCohortSql(0, 0);

  it('prefers library.artist_name over artists.artist_name, matching the catalog export library.db is built from', () => {
    expect(statement).toContain('COALESCE(l."artist_name", a."artist_name") AS artist_name');
    expect(statement).toContain('COALESCE(l."artist_name", a."artist_name") IS NOT NULL');
  });

  it('selects the legacy card id the verdict compares against LML library_item.id', () => {
    expect(statement).toContain('l."legacy_release_id" AS legacy_release_id');
  });

  it('skips albums a music director has marked as not on Discogs', () => {
    expect(statement).toContain('l."discogs_unavailable" = false');
  });

  it('orders by album_id so a cursor resume covers the same ground in the same order', () => {
    expect(statement).toContain('ORDER BY am."album_id"');
  });

  it.each([
    { limit: 0, after: 0, hasLimit: false, cursor: 'am."album_id" > 0' },
    { limit: 25, after: 0, hasLimit: true, cursor: 'am."album_id" > 0' },
    { limit: 2400, after: 53799, hasLimit: true, cursor: 'am."album_id" > 53799' },
  ])('carries limit=$limit and cursor=$after into the statement', ({ limit, after, hasLimit, cursor }) => {
    const sql = enumerateCohortSql(limit, after);

    expect(sql).toContain(cursor);
    expect(sql.includes(`LIMIT ${limit}`)).toBe(hasLimit);
  });

  it.each([
    ['a fractional limit', 2.5, 0],
    ['a negative limit', -1, 0],
    ['a fractional cursor', 0, 1.5],
    ['a negative cursor', 0, -3],
    ['a non-finite cursor', 0, Number.NaN],
  ])('refuses %s rather than interpolating it', (_label, limit, after) => {
    expect(() => enumerateCohortSql(limit, after)).toThrow(/non-negative integer/);
  });
});
