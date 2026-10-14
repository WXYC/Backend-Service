/**
 * The re-ask's guarded `album_metadata` write, as a statement (BS#3145, tracker BS#3137 "Data safety").
 *
 * The unit tier mocks `drizzle-orm`, so these pin the statement's text and its bound values. That the backup and the
 * update commit together, the race guard and the artist rule against real rows are
 * `tests/integration/album-metadata-reask.spec.js`.
 *
 * @see WXYC/Backend-Service#3145
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { db } from '@wxyc/database';
import { renderSql } from '../../../utils/render-sql';
import { CLEAR_RELEASE_GROUP, type RebindPayload } from '../../../../jobs/album-metadata-reask/payload';
import { writeAlbum, writeAlbumSql, type AlbumWrite } from '../../../../jobs/album-metadata-reask/write';

const execute = db.execute as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const flat = (chunk: unknown): string => renderSql(chunk).replace(/\s+/g, ' ');

const STORED_URL = 'https://www.discogs.com/release/1001-Juana-Molina-DOGA';
const PAYLOAD: RebindPayload = {
  release: {
    discogs_url: 'https://www.discogs.com/release/3003-Juana-Molina-DOGA',
    artwork_url: 'https://i.discogs.com/3003.jpg',
    release_year: null,
    label: 'Sonamos',
    full_release_date: '2017-04-21',
    genres: ['Rock', 'Electronic'],
    styles: ['Experimental'],
    tracklist: [{ position: 'A1', title: 'la paradoja' }],
  },
  artist: {
    discogs_artist_id: 61002,
    artist_bio: null,
    artist_wikipedia_url: null,
    artist_image_url: null,
    bio_tokens: null,
  },
};

const write = (verdict: AlbumWrite['verdict']): AlbumWrite => ({
  run_id: 'run-1',
  pin_export_sha256: 'abc123',
  tier: 'rebind',
  verdict,
  row: {
    album_id: 42,
    legacy_release_id: 1001,
    discogs_url: STORED_URL,
    artwork_url: null,
    library_artwork_url: null,
    stored_release_id: 1001,
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
    reason: 'pin_mismatch',
    pin_release_id: 3003,
    pin_source: 'alex-l-2026-masters-api',
  },
});

const REBIND = write({ kind: 'rebind', release_id: 3003, payload: PAYLOAD });
const CLEAR = write({ kind: 'clear', payload: { release: CLEAR_RELEASE_GROUP, artist: null } });

const COLUMNS = [
  'discogs_url',
  'artwork_url',
  'release_year',
  'label',
  'full_release_date',
  'genres',
  'styles',
  'tracklist',
  'discogs_artist_id',
  'artist_bio',
  'artist_wikipedia_url',
  'artist_image_url',
  'bio_tokens',
];

describe('writeAlbumSql', () => {
  const statement = flat(writeAlbumSql(REBIND));

  it('locks the row only while it still stores the enumerated release (the race guard)', () => {
    expect(statement).toContain(
      `am."album_id" = 42::int AND am."discogs_url" IS NOT DISTINCT FROM ${STORED_URL}::text`
    );
    expect(statement).toContain('FOR UPDATE OF am');
  });

  it('writes the backup row in the same statement, and the update only once it exists', () => {
    expect(statement).toMatch(/backup AS \( INSERT INTO "wxyc_schema"\."album_metadata_reask_backup"/);
    expect(statement).toContain(`SELECT run-1::text, 'album_metadata', n."album_id", n."album_id", n.before_image,`);
    expect(statement).toContain('AND EXISTS (SELECT 1 FROM backup)');
  });

  it('sets the 13 release- and artist-group columns and updated_at, and no other column', () => {
    const set = statement.slice(statement.indexOf(' SET ') + 5, statement.lastIndexOf(' FROM next n'));

    expect(set.split(', ')).toEqual([...COLUMNS.map((c) => `"${c}" = n."${c}"`), '"updated_at" = NOW()']);
  });

  it('images all 13 columns before and after, keyed by column name', () => {
    for (const alias of ['p', 'n']) {
      expect(statement).toContain(`jsonb_build_object(${COLUMNS.map((c) => `'${c}', ${alias}."${c}"`).join(', ')})`);
    }
  });

  it.each([
    ['release_year', '::smallint AS "release_year"'],
    ['genres', '{"Rock","Electronic"}::text[] AS "genres"'],
    ['styles', '{"Experimental"}::text[] AS "styles"'],
    ['tracklist', `${JSON.stringify(PAYLOAD.release.tracklist)}::jsonb AS "tracklist"`],
  ])('binds %s with an explicit cast', (_col, expected) => {
    expect(statement).toContain(expected);
  });

  it('applies the artist rule to the artist group', () => {
    expect(statement).toContain('CASE WHEN p."discogs_artist_id" = 61002::int THEN p."artist_bio" END');
  });

  it('on clear, writes the release group NULL and keeps the artist group', () => {
    const cleared = flat(writeAlbumSql(CLEAR));

    expect(cleared).toContain('::text AS "discogs_url"');
    expect(cleared).toContain('::text[] AS "genres"');
    for (const col of COLUMNS.slice(8)) expect(cleared).toContain(`p."${col}" AS "${col}"`);
  });

  it.each([
    [REBIND, 3003],
    [CLEAR, null],
  ])('stamps the provenance as jsonb', (w, newReleaseId) => {
    const provenance = {
      reason: 'pin_mismatch',
      verdict: w.verdict.kind,
      tier: 'rebind',
      legacy_release_id: 1001,
      pin_release_id: 3003,
      pin_source: 'alex-l-2026-masters-api',
      pin_export_sha256: 'abc123',
      prior_release_id: 1001,
      new_release_id: newReleaseId,
    };

    expect(flat(writeAlbumSql(w))).toContain(`${JSON.stringify(provenance)}::jsonb, NOW()`);
  });
});

describe('writeAlbum', () => {
  beforeEach(() => execute.mockReset());

  it.each([
    ['a written row', [{ album_id: 42, artist_cleared: false }], { written: true, artist_cleared: false }],
    [
      'a written row whose stored bio the answer cleared',
      [{ album_id: 42, artist_cleared: true }],
      { written: true, artist_cleared: true },
    ],
    ['no row: the guard failed, so skipped_raced', [], { written: false }],
  ])('reports %s', async (_label, rows, outcome) => {
    execute.mockResolvedValueOnce(rows);

    expect(await writeAlbum(REBIND)).toEqual(outcome);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
