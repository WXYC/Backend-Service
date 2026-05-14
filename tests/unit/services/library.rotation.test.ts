/**
 * Unit tests for `getRotationFromDB` (read-side fix for #689 / #694).
 *
 * The read query is the only thing that defends the dropdown shape because
 * tubafrenzy is the upstream writer and BS cannot constrain what it writes.
 * Three shapes the test covers:
 *
 *   1. Duplicate active rows for the same `(album_id, rotation_bin)` —
 *      collapsed to one row per group via `DISTINCT ON ... ORDER BY
 *      add_date DESC, id ASC`.
 *   2. Rows with `album_id IS NULL` — surface via the LEFT JOIN with
 *      artist/album/label fields populated from the rotation row's
 *      denormalized snapshot columns.
 *   3. The mixed case (real albums + duplicates + NULL-album rows)
 *      together — exercises the `coalesce(album_id, -id)` partition
 *      key that keeps NULL rows in distinct groups.
 *
 * The query itself uses raw `sql` template + `db.execute` (because
 * Drizzle's query builder doesn't surface `DISTINCT ON`), so the tests
 * mock `db.execute` directly with the rows the underlying SQL would
 * have returned post-DISTINCT-ON. That asserts the *serialization*
 * layer (LEFT JOIN nullability, identity stripping, COALESCE shape)
 * without re-implementing Postgres's deduplication semantics.
 *
 * Integration coverage of the actual SQL (DISTINCT ON dedup against
 * the shape fixture's 3 duplicate groups + 2 NULL-album rows) lives in
 * `tests/integration/library.spec.js`.
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
}));

import { getRotationFromDB } from '../../../apps/backend/services/library.service';

type RawRotationRow = {
  id: number | null;
  code_letters: string | null;
  code_artist_number: number | null;
  code_number: number | null;
  artist_name: string | null;
  alphabetical_name: string | null;
  album_title: string | null;
  record_label: string | null;
  label_id: number | null;
  genre_name: string | null;
  format_name: string | null;
  rotation_id: number;
  add_date: Date | null;
  rotation_add_date: string;
  rotation_bin: 'S' | 'L' | 'M' | 'H' | 'N';
  rotation_kill_date: string | null;
  plays: number | null;
  discogs_artist_id: number | null;
  musicbrainz_artist_id: string | null;
  wikidata_qid: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
};

/** Build a fully-populated joined-album row for the rotation query. */
function joinedRow(overrides: Partial<RawRotationRow> = {}): RawRotationRow {
  return {
    id: 1,
    code_letters: 'JU',
    code_artist_number: 1,
    code_number: 1,
    artist_name: 'Juana Molina',
    alphabetical_name: 'Juana Molina',
    album_title: 'DOGA',
    record_label: 'Sonamos',
    label_id: 10,
    genre_name: 'Rock',
    format_name: 'CD',
    rotation_id: 100,
    add_date: new Date('2024-01-15'),
    rotation_add_date: '2024-01-15',
    rotation_bin: 'H',
    rotation_kill_date: null,
    plays: 5,
    discogs_artist_id: null,
    musicbrainz_artist_id: null,
    wikidata_qid: null,
    spotify_artist_id: null,
    apple_music_artist_id: null,
    bandcamp_id: null,
    ...overrides,
  };
}

/**
 * Build a row that the LEFT JOIN to library produced with NULL on the
 * library/artists/format/genres side — i.e. a rotation row whose
 * `album_id` was NULL or didn't resolve. The COALESCEs in the SELECT
 * surface artist_name/album_title/record_label from the rotation row's
 * denormalized columns, so those *do* end up populated; everything else
 * derived from the joined tables is NULL.
 */
function orphanRow(overrides: Partial<RawRotationRow> = {}): RawRotationRow {
  return {
    id: null, // library.id (no joined library row)
    code_letters: null, // artists.code_letters
    code_artist_number: null, // genre_artist_crossreference.artist_genre_code
    code_number: null, // library.code_number
    artist_name: 'Shape Fixture Orphan One', // COALESCE(artists.artist_name, rotation.artist_name)
    alphabetical_name: 'Shape Fixture Orphan One', // COALESCE(artists.alphabetical_name, rotation.artist_name)
    album_title: 'Shape Fixture Orphan Album One', // COALESCE(library.album_title, rotation.album_title)
    record_label: null, // COALESCE(library.label, rotation.record_label) — null on both sides here
    label_id: null,
    genre_name: null, // genres.genre_name
    format_name: null, // format.format_name
    rotation_id: 200,
    add_date: null, // library.add_date
    rotation_add_date: '2024-05-20',
    rotation_bin: 'L',
    rotation_kill_date: null,
    plays: null, // library.plays
    discogs_artist_id: null,
    musicbrainz_artist_id: null,
    wikidata_qid: null,
    spotify_artist_id: null,
    apple_music_artist_id: null,
    bandcamp_id: null,
    ...overrides,
  };
}

describe('library.service / getRotationFromDB', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('post-DISTINCT-ON serialization', () => {
    /**
     * Postgres collapses 3 active rows for the same (album_id,
     * rotation_bin) to 1 via DISTINCT ON. This test asserts that when
     * the SQL returns the post-collapse shape (1 row, the most-recent
     * add per group), the serializer passes it through cleanly with
     * the reconciled-identity rewrite.
     */
    it('returns one row per (album_id, rotation_bin) group with the latest add_date', async () => {
      const collapsed = joinedRow({
        rotation_id: 7002, // The 2024-08-22 row, latest of the 3-row Little Brother group
        rotation_add_date: '2024-08-22',
      });
      db.execute.mockResolvedValueOnce([collapsed]);

      const result = await getRotationFromDB();

      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        rotation_id: 7002,
        rotation_add_date: '2024-08-22',
        rotation_bin: 'H',
      });
      // Reconciled-identity rewrite: nested object replaces flat columns.
      expect(result[0]).toHaveProperty('reconciled_identity');
      expect(result[0]).not.toHaveProperty('discogs_artist_id');
      expect(result[0]).not.toHaveProperty('musicbrainz_artist_id');
    });

    /**
     * Two rotation rows with NULL `album_id` (different rotation_ids)
     * survive the LEFT JOIN. Each has its own row in the response with
     * artist_name/album_title coming from rotation's denormalized
     * columns (via COALESCE in the SELECT).
     */
    it('surfaces NULL-album_id rows with denormalized artist/album fields populated', async () => {
      const orphan1 = orphanRow({
        rotation_id: 7007,
        rotation_bin: 'L',
        rotation_add_date: '2024-05-20',
        artist_name: 'Shape Fixture Orphan One',
        album_title: 'Shape Fixture Orphan Album One',
        alphabetical_name: 'Shape Fixture Orphan One',
      });
      const orphan2 = orphanRow({
        rotation_id: 7008,
        rotation_bin: 'M',
        rotation_add_date: '2024-07-04',
        artist_name: 'Shape Fixture Orphan Two',
        album_title: 'Shape Fixture Orphan Album Two',
        alphabetical_name: 'Shape Fixture Orphan Two',
      });
      db.execute.mockResolvedValueOnce([orphan1, orphan2]);

      const result = await getRotationFromDB();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: null,
        rotation_id: 7007,
        artist_name: 'Shape Fixture Orphan One',
        album_title: 'Shape Fixture Orphan Album One',
        rotation_bin: 'L',
        // ancillary metadata that came from the (NULL) joined tables stays null
        code_letters: null,
        genre_name: null,
        format_name: null,
        plays: null,
      });
      expect(result[1]).toMatchObject({
        id: null,
        rotation_id: 7008,
        artist_name: 'Shape Fixture Orphan Two',
        album_title: 'Shape Fixture Orphan Album Two',
        rotation_bin: 'M',
      });
      // Both rows still get the reconciled_identity rewrite (nested null object).
      expect(result[0].reconciled_identity).toBeNull();
      expect(result[1].reconciled_identity).toBeNull();
    });

    /**
     * Mixed shape: 5 distinct linked rows (e.g. albums 7000/7001/7002
     * with their duplicate groups already collapsed by DISTINCT ON, plus
     * 2 stand-alone rows on different albums) and 3 NULL-album_id rows.
     * Asserts the serializer handles the heterogeneous wave without
     * dropping or coalescing across album boundaries.
     */
    it('handles mixed linked + NULL-album rows in one response', async () => {
      const linked = [
        joinedRow({ id: 7000, rotation_id: 7002, rotation_bin: 'H', artist_name: 'Alpha' }),
        joinedRow({ id: 7001, rotation_id: 7006, rotation_bin: 'M', artist_name: 'Beta' }),
        joinedRow({ id: 7002, rotation_id: 7004, rotation_bin: 'L', artist_name: 'Gamma' }),
        joinedRow({ id: 7003, rotation_id: 7012, rotation_bin: 'M', artist_name: 'Delta' }),
        joinedRow({ id: 7005, rotation_id: 7013, rotation_bin: 'H', artist_name: 'Epsilon' }),
      ];
      const orphans = [
        orphanRow({ rotation_id: 9001, artist_name: 'Orphan A' }),
        orphanRow({ rotation_id: 9002, artist_name: 'Orphan B' }),
        orphanRow({ rotation_id: 9003, artist_name: 'Orphan C' }),
      ];
      db.execute.mockResolvedValueOnce([...linked, ...orphans]);

      const result = await getRotationFromDB();

      expect(result).toHaveLength(8); // 5 linked + 3 orphans
      // Linked rows preserve their library id; orphans have null id.
      const linkedIds = result.filter((r) => r.id !== null).map((r) => r.id);
      expect(linkedIds).toEqual([7000, 7001, 7002, 7003, 7005]);
      const orphanRows = result.filter((r) => r.id === null);
      expect(orphanRows).toHaveLength(3);
      expect(orphanRows.map((r) => r.artist_name)).toEqual(['Orphan A', 'Orphan B', 'Orphan C']);
      // None of the rows leak the flat external-ID columns.
      for (const row of result) {
        expect(row).not.toHaveProperty('discogs_artist_id');
        expect(row).not.toHaveProperty('musicbrainz_artist_id');
        expect(row).not.toHaveProperty('wikidata_qid');
        expect(row).not.toHaveProperty('spotify_artist_id');
        expect(row).not.toHaveProperty('apple_music_artist_id');
        expect(row).not.toHaveProperty('bandcamp_id');
        expect(row).toHaveProperty('reconciled_identity');
      }
    });

    /**
     * COALESCE picks library.label when present and falls back to
     * rotation.record_label when the joined library row is NULL or
     * library.label is NULL. Asserts both branches.
     */
    it('COALESCEs record_label across the library and rotation snapshot columns', async () => {
      const fromLibrary = joinedRow({
        record_label: 'Sonamos', // COALESCE(library.label='Sonamos', rotation.record_label='ignored') = 'Sonamos'
      });
      const fromRotation = orphanRow({
        rotation_id: 9100,
        record_label: 'Drag City', // COALESCE(library.label=NULL, rotation.record_label='Drag City')
      });
      db.execute.mockResolvedValueOnce([fromLibrary, fromRotation]);

      const result = await getRotationFromDB();

      expect(result[0].record_label).toBe('Sonamos');
      expect(result[1].record_label).toBe('Drag City');
    });

    it('returns an empty array when there are no active rotation rows', async () => {
      db.execute.mockResolvedValueOnce([]);

      const result = await getRotationFromDB();

      expect(result).toEqual([]);
    });

    /**
     * #862: NULL-album_id rows with the same (artist, album, bin) used
     * to escape DISTINCT ON because the old partition key was
     * `-rotation.id` (unique per row). The new key hashes the
     * denormalized (artist_name, album_title) snapshot columns when
     * album_id IS NULL, so unlinked dupes collapse. Postgres returns
     * the post-collapse shape; we assert the serializer ships exactly
     * one row through with the most-recent rotation_add_date (per
     * ORDER BY add_date DESC).
     */
    it('passes through collapsed NULL-album duplicate groups as a single row (#862)', async () => {
      const collapsed = orphanRow({
        rotation_id: 7015,
        artist_name: 'Shape Fixture Orphan One',
        album_title: 'Shape Fixture Orphan Album One',
        alphabetical_name: 'Shape Fixture Orphan One',
        rotation_bin: 'L',
        rotation_add_date: '2024-09-12',
      });
      db.execute.mockResolvedValueOnce([collapsed]);

      const result = await getRotationFromDB();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: null,
        rotation_id: 7015,
        artist_name: 'Shape Fixture Orphan One',
        album_title: 'Shape Fixture Orphan Album One',
        rotation_bin: 'L',
        rotation_add_date: '2024-09-12',
      });
    });
  });

  /**
   * SQL-shape contract: the rotation query has to use a hash-based
   * partition key when album_id IS NULL (#862). The unit-level mock
   * can't observe Postgres's DISTINCT ON behavior, so this test
   * inspects the SQL template handed to `db.execute` to make sure the
   * intended fragment is wired in. Integration coverage of the actual
   * dedup against real rows lives in tests/integration/library.spec.js.
   */
  describe('SQL shape', () => {
    it('uses hashtext on (artist_name, album_title) as the NULL-album partition key (#862)', async () => {
      db.execute.mockResolvedValueOnce([]);

      await getRotationFromDB();

      expect(db.execute).toHaveBeenCalledTimes(1);
      const sqlArg = db.execute.mock.calls[0][0];
      // Drizzle SQL objects expose their literal text fragments via
      // `queryChunks` (an array of StringChunk + Column objects).
      // Stringify and assert the new partition key is present.
      const stringified = JSON.stringify(sqlArg);
      expect(stringified).toMatch(/hashtext/);
      expect(stringified).toMatch(/lower/);
      // The pre-#862 `-rotation.id` partition trick should no longer
      // appear in the query.
      expect(stringified).not.toMatch(/-"rotation"\."id"/);
    });
  });
});
