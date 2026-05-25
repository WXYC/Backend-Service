/**
 * PG-semantics pin for the value-aware setWhere on library-etl's
 * onConflictDoUpdate sites (BS#1063). Same uses-xmin / hand-written-SQL
 * shape as flowsheet-etl-setwhere.spec.js — the integration runner is
 * babel-jest and can't import the ETL's drizzle-orm code.
 *
 * Covers four UPSERT sites in jobs/library-etl/job.ts:
 *   - library                          (15-column SET, conflict on legacy_release_id)
 *   - genre_artist_crossreference      (1-column SET on artist_genre_code)
 *   - artist_crossreference            (1-column SET on comment)
 *   - artist_library_crossreference    (1-column SET on comment)
 *
 * All four use IS DISTINCT FROM rather than = so NULL transitions
 * propagate correctly on the nullable comment columns.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Use a high legacy_release_id range so this spec cannot collide with
// seeded library rows 1-6 or the rotation seed (which only references
// album_id, not legacy_release_id).
const LIBRARY_LEGACY_ID = 2000001063;

async function upsertLibraryEtlShape(sql, row) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, artist_name, genre_id, format_id, alternate_artist_name,
       album_artist, album_title, code_number, code_volume_letters,
       disc_quantity, legacy_release_id, add_date, last_modified, date_lost,
       date_found, on_streaming)
    VALUES
      (${row.artist_id}, ${row.artist_name}, ${row.genre_id}, ${row.format_id},
       ${row.alternate_artist_name}, ${row.album_artist}, ${row.album_title},
       ${row.code_number}, ${row.code_volume_letters}, ${row.disc_quantity},
       ${row.legacy_release_id}, ${row.add_date}, ${row.last_modified},
       ${row.date_lost}, ${row.date_found}, ${row.on_streaming})
    ON CONFLICT (legacy_release_id) DO UPDATE SET
      artist_id             = excluded.artist_id,
      artist_name           = excluded.artist_name,
      genre_id              = excluded.genre_id,
      format_id             = excluded.format_id,
      alternate_artist_name = excluded.alternate_artist_name,
      album_artist          = excluded.album_artist,
      album_title           = excluded.album_title,
      code_number           = excluded.code_number,
      code_volume_letters   = excluded.code_volume_letters,
      disc_quantity         = excluded.disc_quantity,
      add_date              = excluded.add_date,
      last_modified         = excluded.last_modified,
      date_lost             = excluded.date_lost,
      date_found            = excluded.date_found,
      on_streaming          = excluded.on_streaming
    WHERE
      ${sql(SCHEMA)}.library.artist_id             IS DISTINCT FROM excluded.artist_id OR
      ${sql(SCHEMA)}.library.artist_name           IS DISTINCT FROM excluded.artist_name OR
      ${sql(SCHEMA)}.library.genre_id              IS DISTINCT FROM excluded.genre_id OR
      ${sql(SCHEMA)}.library.format_id             IS DISTINCT FROM excluded.format_id OR
      ${sql(SCHEMA)}.library.alternate_artist_name IS DISTINCT FROM excluded.alternate_artist_name OR
      ${sql(SCHEMA)}.library.album_artist          IS DISTINCT FROM excluded.album_artist OR
      ${sql(SCHEMA)}.library.album_title           IS DISTINCT FROM excluded.album_title OR
      ${sql(SCHEMA)}.library.code_number           IS DISTINCT FROM excluded.code_number OR
      ${sql(SCHEMA)}.library.code_volume_letters   IS DISTINCT FROM excluded.code_volume_letters OR
      ${sql(SCHEMA)}.library.disc_quantity         IS DISTINCT FROM excluded.disc_quantity OR
      ${sql(SCHEMA)}.library.add_date              IS DISTINCT FROM excluded.add_date OR
      ${sql(SCHEMA)}.library.last_modified         IS DISTINCT FROM excluded.last_modified OR
      ${sql(SCHEMA)}.library.date_lost             IS DISTINCT FROM excluded.date_lost OR
      ${sql(SCHEMA)}.library.date_found            IS DISTINCT FROM excluded.date_found OR
      ${sql(SCHEMA)}.library.on_streaming          IS DISTINCT FROM excluded.on_streaming
  `;
}

async function upsertGenreArtistCrossref(sql, artistId, genreId, code) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference
      (artist_id, genre_id, artist_genre_code)
    VALUES
      (${artistId}, ${genreId}, ${code})
    ON CONFLICT (artist_id, genre_id) DO UPDATE SET
      artist_genre_code = excluded.artist_genre_code
    WHERE
      ${sql(SCHEMA)}.genre_artist_crossreference.artist_genre_code IS DISTINCT FROM excluded.artist_genre_code
  `;
}

async function upsertArtistCrossref(sql, sourceId, targetId, comment) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.artist_crossreference
      (source_artist_id, target_artist_id, comment)
    VALUES
      (${sourceId}, ${targetId}, ${comment})
    ON CONFLICT (source_artist_id, target_artist_id) DO UPDATE SET
      comment = excluded.comment
    WHERE
      ${sql(SCHEMA)}.artist_crossreference.comment IS DISTINCT FROM excluded.comment
  `;
}

async function upsertArtistLibraryCrossref(sql, artistId, libraryId, comment) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.artist_library_crossreference
      (artist_id, library_id, comment)
    VALUES
      (${artistId}, ${libraryId}, ${comment})
    ON CONFLICT (artist_id, library_id) DO UPDATE SET
      comment = excluded.comment
    WHERE
      ${sql(SCHEMA)}.artist_library_crossreference.comment IS DISTINCT FROM excluded.comment
  `;
}

describe('library-etl value-aware setWhere (BS#1063)', () => {
  let sql;
  let seededArtistId;
  let seededGenreId;
  let seededFormatId;
  let secondaryArtistId;
  let seededLibraryId;

  beforeAll(async () => {
    sql = getTestDb();
    // Pin to the first seeded artist + genre + format (Built to Spill /
    // Rock / CD per dev_env/seed_db.sql). The FK targets are stable across
    // dev + CI because both load the same fixture.
    const [artist] = await sql`
      SELECT id FROM ${sql(SCHEMA)}.artists ORDER BY id LIMIT 1
    `;
    seededArtistId = artist.id;
    const [genre] = await sql`
      SELECT id FROM ${sql(SCHEMA)}.genres ORDER BY id LIMIT 1
    `;
    seededGenreId = genre.id;
    const [format] = await sql`
      SELECT id FROM ${sql(SCHEMA)}.format ORDER BY id LIMIT 1
    `;
    seededFormatId = format.id;
    // Grab a second artist so the artist_crossreference test has both a
    // source and target.
    const secondaryArtists = await sql`
      SELECT id FROM ${sql(SCHEMA)}.artists ORDER BY id OFFSET 1 LIMIT 1
    `;
    secondaryArtistId = secondaryArtists[0].id;
    // Grab any seeded library row for the artist_library_crossreference test.
    const [lib] = await sql`
      SELECT id FROM ${sql(SCHEMA)}.library ORDER BY id LIMIT 1
    `;
    seededLibraryId = lib.id;
  });

  afterAll(async () => {
    // Pool is shared with the rest of the integration suite; do NOT close it.
    await sql`
      DELETE FROM ${sql(SCHEMA)}.library WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE source_artist_id = ${seededArtistId} AND target_artist_id = ${secondaryArtistId}
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_library_crossreference
      WHERE artist_id = ${secondaryArtistId} AND library_id = ${seededLibraryId}
    `;
  });

  describe('library upsert (15-column SET)', () => {
    test('re-upserting an identical row produces no UPDATE (xmin unchanged)', async () => {
      const row = {
        artist_id: seededArtistId,
        artist_name: 'Juana Molina',
        genre_id: seededGenreId,
        format_id: seededFormatId,
        alternate_artist_name: null,
        album_artist: null,
        album_title: 'DOGA',
        code_number: 99,
        code_volume_letters: null,
        disc_quantity: 1,
        legacy_release_id: LIBRARY_LEGACY_ID,
        add_date: new Date('2026-05-24T00:00:00Z'),
        last_modified: new Date('2026-05-24T12:00:00Z'),
        date_lost: null,
        date_found: null,
        on_streaming: null,
      };
      await upsertLibraryEtlShape(sql, row);
      const before = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
      `;
      expect(before.length).toBe(1);

      await upsertLibraryEtlShape(sql, row);
      const after = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
      `;
      expect(after[0].xmin).toBe(before[0].xmin);
    });

    test('re-upserting with one changed field produces an UPDATE (xmin changes)', async () => {
      const before = await sql`
        SELECT xmin::text AS xmin, album_title
        FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
      `;

      await upsertLibraryEtlShape(sql, {
        artist_id: seededArtistId,
        artist_name: 'Juana Molina',
        genre_id: seededGenreId,
        format_id: seededFormatId,
        alternate_artist_name: null,
        album_artist: null,
        album_title: 'DOGA (Remastered)',
        code_number: 99,
        code_volume_letters: null,
        disc_quantity: 1,
        legacy_release_id: LIBRARY_LEGACY_ID,
        add_date: new Date('2026-05-24T00:00:00Z'),
        last_modified: new Date('2026-05-24T12:00:00Z'),
        date_lost: null,
        date_found: null,
        on_streaming: null,
      });
      const after = await sql`
        SELECT xmin::text AS xmin, album_title
        FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
      `;
      expect(after[0].xmin).not.toBe(before[0].xmin);
      expect(after[0].album_title).toBe('DOGA (Remastered)');
    });

    test('NULL → string transition fires an UPDATE (IS DISTINCT FROM semantics)', async () => {
      // album_artist is nullable; the seeded test row has it as NULL. A
      // plain `=` predicate would yield NULL and skip the UPDATE, silently
      // dropping the new value. IS DISTINCT FROM is the right operator.
      const before = await sql`
        SELECT xmin::text AS xmin, album_artist
        FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
      `;
      expect(before[0].album_artist).toBeNull();

      await upsertLibraryEtlShape(sql, {
        artist_id: seededArtistId,
        artist_name: 'Juana Molina',
        genre_id: seededGenreId,
        format_id: seededFormatId,
        alternate_artist_name: null,
        album_artist: 'Various Artists',
        album_title: 'DOGA (Remastered)',
        code_number: 99,
        code_volume_letters: null,
        disc_quantity: 1,
        legacy_release_id: LIBRARY_LEGACY_ID,
        add_date: new Date('2026-05-24T00:00:00Z'),
        last_modified: new Date('2026-05-24T12:00:00Z'),
        date_lost: null,
        date_found: null,
        on_streaming: null,
      });
      const after = await sql`
        SELECT xmin::text AS xmin, album_artist
        FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${LIBRARY_LEGACY_ID}
      `;
      expect(after[0].xmin).not.toBe(before[0].xmin);
      expect(after[0].album_artist).toBe('Various Artists');
    });
  });

  describe('genre_artist_crossreference upsert (1-column SET)', () => {
    test('re-upserting same artist_genre_code produces no UPDATE', async () => {
      // The seed already attaches the first seeded artist to genre_id=11
      // (or whichever genre the seed uses). Use that pair; re-upsert with
      // the existing code and assert xmin unchanged.
      const [existing] = await sql`
        SELECT artist_genre_code, xmin::text AS xmin
        FROM ${sql(SCHEMA)}.genre_artist_crossreference
        WHERE artist_id = ${seededArtistId}
        ORDER BY genre_id
        LIMIT 1
      `;
      expect(existing).toBeDefined();
      const genreIdOfPair = await sql`
        SELECT genre_id FROM ${sql(SCHEMA)}.genre_artist_crossreference
        WHERE artist_id = ${seededArtistId} AND artist_genre_code = ${existing.artist_genre_code}
        LIMIT 1
      `;
      const pairedGenre = genreIdOfPair[0].genre_id;

      await upsertGenreArtistCrossref(sql, seededArtistId, pairedGenre, existing.artist_genre_code);
      const after = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.genre_artist_crossreference
        WHERE artist_id = ${seededArtistId} AND genre_id = ${pairedGenre}
      `;
      expect(after[0].xmin).toBe(existing.xmin);
    });

    test('re-upserting with a changed code produces an UPDATE', async () => {
      const [existing] = await sql`
        SELECT genre_id, artist_genre_code, xmin::text AS xmin
        FROM ${sql(SCHEMA)}.genre_artist_crossreference
        WHERE artist_id = ${seededArtistId}
        ORDER BY genre_id
        LIMIT 1
      `;
      const newCode = existing.artist_genre_code + 1;
      try {
        await upsertGenreArtistCrossref(sql, seededArtistId, existing.genre_id, newCode);
        const after = await sql`
          SELECT xmin::text AS xmin, artist_genre_code
          FROM ${sql(SCHEMA)}.genre_artist_crossreference
          WHERE artist_id = ${seededArtistId} AND genre_id = ${existing.genre_id}
        `;
        expect(after[0].xmin).not.toBe(existing.xmin);
        expect(after[0].artist_genre_code).toBe(newCode);
      } finally {
        // Restore the seeded code so this spec is idempotent across runs.
        await sql`
          UPDATE ${sql(SCHEMA)}.genre_artist_crossreference
          SET artist_genre_code = ${existing.artist_genre_code}
          WHERE artist_id = ${seededArtistId} AND genre_id = ${existing.genre_id}
        `;
      }
    });
  });

  describe('artist_crossreference upsert (nullable comment)', () => {
    test('NULL → NULL re-upsert produces no UPDATE (IS DISTINCT FROM correctness)', async () => {
      await upsertArtistCrossref(sql, seededArtistId, secondaryArtistId, null);
      const before = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.artist_crossreference
        WHERE source_artist_id = ${seededArtistId} AND target_artist_id = ${secondaryArtistId}
      `;
      expect(before.length).toBe(1);

      await upsertArtistCrossref(sql, seededArtistId, secondaryArtistId, null);
      const after = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.artist_crossreference
        WHERE source_artist_id = ${seededArtistId} AND target_artist_id = ${secondaryArtistId}
      `;
      expect(after[0].xmin).toBe(before[0].xmin);
    });

    test('NULL → string fires an UPDATE; identical string re-upsert no-ops', async () => {
      const before = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.artist_crossreference
        WHERE source_artist_id = ${seededArtistId} AND target_artist_id = ${secondaryArtistId}
      `;

      await upsertArtistCrossref(sql, seededArtistId, secondaryArtistId, 'see also');
      const afterChange = await sql`
        SELECT xmin::text AS xmin, comment
        FROM ${sql(SCHEMA)}.artist_crossreference
        WHERE source_artist_id = ${seededArtistId} AND target_artist_id = ${secondaryArtistId}
      `;
      expect(afterChange[0].xmin).not.toBe(before[0].xmin);
      expect(afterChange[0].comment).toBe('see also');

      await upsertArtistCrossref(sql, seededArtistId, secondaryArtistId, 'see also');
      const afterNoop = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.artist_crossreference
        WHERE source_artist_id = ${seededArtistId} AND target_artist_id = ${secondaryArtistId}
      `;
      expect(afterNoop[0].xmin).toBe(afterChange[0].xmin);
    });
  });

  describe('artist_library_crossreference upsert (nullable comment)', () => {
    test('identical re-upsert with NULL comment produces no UPDATE', async () => {
      await upsertArtistLibraryCrossref(sql, secondaryArtistId, seededLibraryId, null);
      const before = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.artist_library_crossreference
        WHERE artist_id = ${secondaryArtistId} AND library_id = ${seededLibraryId}
      `;
      expect(before.length).toBe(1);

      await upsertArtistLibraryCrossref(sql, secondaryArtistId, seededLibraryId, null);
      const after = await sql`
        SELECT xmin::text AS xmin
        FROM ${sql(SCHEMA)}.artist_library_crossreference
        WHERE artist_id = ${secondaryArtistId} AND library_id = ${seededLibraryId}
      `;
      expect(after[0].xmin).toBe(before[0].xmin);
    });
  });
});
