/**
 * Integration tests for DELETE /library/artists/:id (BS#2562).
 *
 * Covers the four `/wxycdb` `ArtistAdminServlet.processDeleteArtist`
 * refusals end to end against the real DB, mirroring
 * `library-delete.spec.js` (BS#2112)'s structure over a much smaller
 * dependent set:
 *
 *   - happy-path hard delete of a clean artist (204, bodiless), and the row
 *     is really gone (a second delete 404s).
 *   - the four refusals, each with its own `reason` and message, checked in
 *     the servlet's order: `artist_has_releases`, then
 *     `artist_crossreference_source`, then `artist_crossreference_target`,
 *     then `artist_library_crossreference`. Every refusal leaves the artist
 *     row (and whatever triggered the refusal) intact — asserted via a
 *     follow-up GET.
 *   - `genre_artist_crossreference` deleted in FULL for a multi-genre
 *     artist, not just one row — `artist_genre_key` is unique on
 *     `(artist_id, genre_id)`, not `artist_id` alone, and this FK carries no
 *     `onDelete`, so a single-row delete would leave the rest to raise a raw
 *     FK-violation 500 on the artist DELETE.
 *   - `compilation_track_artist.track_artist_id` is reported by
 *     `GET /library/artists/:id` (BS#2597) but never refuses: the delete
 *     goes through and the credit survives with its link nulled (`ON DELETE
 *     set null`), rather than being destroyed or blocking the delete.
 *   - the BS#2560 `catalog_delete_snapshot` row: written in the same
 *     transaction as the delete, scoped to the artist row plus the two
 *     dependents this endpoint resolves explicitly.
 *   - 404 on an unknown id.
 *
 * Uses the shared shape-fixture artist `ART` (id 7000, `code_letters 'XA'`)
 * as the stable OTHER SIDE of every cross-reference row this spec creates —
 * never the subject of a `DELETE /library/artists/:id` call, so other specs
 * that depend on it are unaffected.
 *
 * TEARDOWN: shares a database with the rest of the integration suite, and
 * its 409 cases deliberately create rows the endpoint under test refuses to
 * remove. Everything created is tracked and cleaned in `afterAll`.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // shape-fixture artist (code_letters 'XA') — never deleted by this spec
const GEN = 11; // 'Rock'
const GEN2 = 6; // 'Hiphop' — the second genre for the multi-genre case
const FMT = 1; // 'cd'

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('DELETE /library/artists/:id (BS#2562)', () => {
  let auth;
  let sql;
  const uniq = Date.now();
  // Every artist and library row this spec creates. Tracked for teardown —
  // the 409 cases leave both the artist row and whatever triggered the
  // refusal in place by design, so the endpoint under test can't clean up
  // after itself.
  const createdArtistIds = [];
  const createdLibraryIds = [];
  let helperRelease;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // The stable "other side" of the artist_library_crossreference and
    // compilation_track_artist fixtures below — filed under `ART`, never
    // under a test subject, so it survives every refusal case unscathed.
    const res = await auth
      .post('/library')
      .send({
        album_title: `BS#2562 Helper Release ${uniq}`,
        artist_id: ART,
        label: `BS#2562 Delete Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    helperRelease = res.body;
    createdLibraryIds.push(helperRelease.id);
  });

  /**
   * Order matters: library rows first (their cascades clear
   * `artist_library_crossreference` and `compilation_track_artist` for us),
   * then the explicit `genre_artist_crossreference` rows (no `onDelete`, so
   * a leftover row would fail the `artists` delete below with a raw FK
   * violation), then the artist rows themselves (whose own delete cascades
   * away any leftover `artist_crossreference` row), then the snapshot rows
   * the successful deletes wrote (no FK ties them to the now-gone artist).
   */
  afterAll(async () => {
    if (sql) {
      try {
        if (createdLibraryIds.length > 0) {
          await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1::int[])`, [createdLibraryIds]);
        }
        if (createdArtistIds.length > 0) {
          await sql.unsafe(`DELETE FROM "${SCHEMA}".genre_artist_crossreference WHERE artist_id = ANY($1::int[])`, [
            createdArtistIds,
          ]);
          await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE id = ANY($1::int[])`, [createdArtistIds]);
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'artist' AND entity_id = ANY($1::int[])`,
            [createdArtistIds]
          );
        }
      } finally {
        await sql.end();
      }
    }
  });

  let seq = 0;
  const createArtist = async () => {
    seq += 1;
    const codeLetters = `${uniq.toString(36).toUpperCase().slice(-2)}${seq}`.slice(0, 4);
    const res = await auth
      .post('/library/artists')
      .send({ artist_name: `BS#2562 Artist ${uniq}-${seq}`, code_letters: codeLetters, genre_id: GEN })
      .expect(201);
    createdArtistIds.push(res.body.id);
    return res.body;
  };

  const createReleaseForArtist = async (artistId) => {
    const res = await auth
      .post('/library')
      .send({
        album_title: `BS#2562 Release ${uniq}-${artistId}`,
        artist_id: artistId,
        label: `BS#2562 Delete Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    createdLibraryIds.push(res.body.id);
    return res.body;
  };

  test('hard-deletes a clean artist, returns a bodiless 204, and writes a catalog_delete_snapshot row', async () => {
    const artist = await createArtist();

    const del = await auth.delete(`/library/artists/${artist.id}`).expect(204);
    expect(del.text).toBe('');

    // The row is really gone (hard delete) — a second delete has nothing
    // left to find.
    await auth.delete(`/library/artists/${artist.id}`).expect(404);
    await auth.get(`/library/artists/${artist.id}`).expect(404);

    const rows = await sql.unsafe(
      `SELECT entity_kind, entity_id, captured, actor_user_id
         FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'artist' AND entity_id = $1`,
      [artist.id]
    );
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].actor_user_id).toBe('string');
    const { captured } = rows[0];
    expect(captured.entity.table).toBe('artists');
    expect(captured.entity.row.id).toBe(artist.id);
    expect(captured.entity.row.artist_name).toBe(artist.artist_name);
    // The one genre_artist_crossreference row addArtist inserted at create
    // time — captured before the delete removes it.
    expect(captured.children.genre_artist_crossreference).toHaveLength(1);
    expect(captured.children.genre_artist_crossreference[0].genre_id).toBe(GEN);
    // Present as an empty array, not omitted — this artist has no
    // compilation credits.
    expect(captured.children.compilation_track_artist).toEqual([]);
  });

  // Closes the loop the snapshot assertions above stop short of: the archive
  // listing has to describe an ARTIST batch, and the `unrecoverable` list is
  // the field that can get this wrong silently. It was a single constant for
  // every batch, so an artist batch was handed the five RELEASE tables -- none
  // of which an artist delete touches -- while saying nothing about the five it
  // does. The restore consumer is the reader that would be misled.
  test('lists the artist batch with the ARTIST unrecoverable dependents, not the release ones', async () => {
    const artist = await createArtist();
    await auth.delete(`/library/artists/${artist.id}`).expect(204);

    const res = await auth.get('/library/deleted').query({ search: artist.artist_name }).expect(200);

    // Located by entity id rather than by taking `results[0]`. `search` is a
    // substring match, and these fixtures end in a sequence number, so
    // `... Artist X-1` is a prefix of `... Artist X-10` -- picking the first
    // result would make this test's correctness depend on where it sits in the
    // file.
    const batch = res.body.results.find((candidate) =>
      candidate.entities.some((entity) => entity.row?.id === artist.id)
    );
    expect(batch).toBeDefined();
    expect(batch.entities).toHaveLength(1);
    expect(batch.entities[0].entity_kind).toBe('artist');
    expect(batch.entities[0].table).toBe('artists');

    expect([...batch.unrecoverable].sort()).toEqual(
      ['artist_search_alias', 'artist_similar_artists', 'artist_station_plays', 'concerts', 'concert_performers'].sort()
    );
    // Named explicitly rather than left to the equality above: these are the
    // five the defect put here, and a future change that re-broadened the list
    // should fail on the reason, not just on the shape.
    for (const releaseTable of [
      'album_metadata',
      'library_identity',
      'library_identity_source',
      'uncovered_release_search_markers',
      'album_review_submissions',
    ]) {
      expect(batch.unrecoverable).not.toContain(releaseTable);
    }
  });

  test('returns 404 for an unknown id', async () => {
    await auth.delete('/library/artists/999999999').expect(404);
  });

  test('refuses with 409 artist_has_releases when the artist still holds a release', async () => {
    const artist = await createArtist();
    await createReleaseForArtist(artist.id);

    const res = await auth.delete(`/library/artists/${artist.id}`).expect(409);
    expect(res.body).toEqual({
      message: 'Cannot delete: artist has 1 release on file. Delete or move those releases first.',
      reason: 'artist_has_releases',
      count: 1,
    });

    // Refused, not destroyed.
    await auth.get(`/library/artists/${artist.id}`).expect(200);
  });

  test('refuses with 409 artist_crossreference_source when the artist is the source of a legacy cross-reference', async () => {
    const artist = await createArtist();
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_crossreference (source_artist_id, target_artist_id) VALUES ($1, $2)`,
      [artist.id, ART]
    );

    const res = await auth.delete(`/library/artists/${artist.id}`).expect(409);
    expect(res.body).toEqual({
      message: 'Cannot delete: artist is the source of 1 cross-reference to other artists.',
      reason: 'artist_crossreference_source',
      count: 1,
    });

    await auth.get(`/library/artists/${artist.id}`).expect(200);
  });

  test('refuses with 409 artist_crossreference_target when the artist is the target of a legacy cross-reference', async () => {
    const artist = await createArtist();
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artist_crossreference (source_artist_id, target_artist_id) VALUES ($1, $2)`,
      [ART, artist.id]
    );

    const res = await auth.delete(`/library/artists/${artist.id}`).expect(409);
    expect(res.body).toEqual({
      message: 'Cannot delete: artist is the target of 1 cross-reference from other artists.',
      reason: 'artist_crossreference_target',
      count: 1,
    });

    await auth.get(`/library/artists/${artist.id}`).expect(200);
  });

  test('refuses with 409 artist_library_crossreference when the artist holds a legacy release cross-reference', async () => {
    const artist = await createArtist();
    await sql.unsafe(`INSERT INTO "${SCHEMA}".artist_library_crossreference (artist_id, library_id) VALUES ($1, $2)`, [
      artist.id,
      helperRelease.id,
    ]);

    const res = await auth.delete(`/library/artists/${artist.id}`).expect(409);
    expect(res.body).toEqual({
      message: 'Cannot delete: artist has 1 release cross-reference on file.',
      reason: 'artist_library_crossreference',
      count: 1,
    });

    await auth.get(`/library/artists/${artist.id}`).expect(200);
  });

  test('deletes every genre_artist_crossreference row for a multi-genre artist, not just one', async () => {
    const artist = await createArtist();
    // A second genre membership — `POST /library/artists` files an artist in
    // exactly one genre, so the second row is seeded directly, matching how
    // a legacy-imported multi-genre artist actually arises.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".genre_artist_crossreference (artist_id, genre_id, artist_genre_code) VALUES ($1, $2, $3)`,
      [artist.id, GEN2, 500000 + (uniq % 100000)]
    );
    const before = await sql.unsafe(
      `SELECT genre_id FROM "${SCHEMA}".genre_artist_crossreference WHERE artist_id = $1`,
      [artist.id]
    );
    expect(before).toHaveLength(2);

    await auth.delete(`/library/artists/${artist.id}`).expect(204);

    const after = await sql.unsafe(
      `SELECT genre_id FROM "${SCHEMA}".genre_artist_crossreference WHERE artist_id = $1`,
      [artist.id]
    );
    expect(after).toHaveLength(0);
    await auth.get(`/library/artists/${artist.id}`).expect(404);

    // The snapshot has to carry BOTH memberships, and this is the one
    // population where that can fail silently: `getArtistCardById` reports a
    // multi-genre artist under its lowest `genre_id` alone, so a capture built
    // from a card-shaped read would store one row here and every other
    // assertion in this test would stay green while the snapshot lost the only
    // record of the artist's second shelf section.
    const [snapshot] = await sql.unsafe(
      `SELECT captured FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'artist' AND entity_id = $1`,
      [artist.id]
    );
    const capturedGenres = snapshot.captured.children.genre_artist_crossreference;
    expect(capturedGenres).toHaveLength(2);
    expect(capturedGenres.map((row) => row.genre_id).sort((a, b) => a - b)).toEqual(
      [GEN, GEN2].sort((a, b) => a - b)
    );
    // Each membership carries its own shelf code, and a restore needs both:
    // one code cannot stand in for the other.
    for (const row of capturedGenres) {
      expect(typeof row.artist_genre_code).toBe('number');
    }
  });

  test('deletes through a compilation_track_artist credit, nulling track_artist_id rather than refusing', async () => {
    const artist = await createArtist();
    const [cta] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_artist_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [helperRelease.id, `BS#2562 Compilation Credit ${uniq}`, artist.id]
    );

    // Reported, never a refusal reason (BS#2597 count 5) — the delete
    // proceeds regardless of this count.
    const card = await auth.get(`/library/artists/${artist.id}`).expect(200);
    expect(card.body.compilation_credit_count).toBe(1);

    await auth.delete(`/library/artists/${artist.id}`).expect(204);

    // The credit SURVIVES — `ON DELETE set null`, not cascade — with its
    // canonicalization link cleared.
    const rows = await sql.unsafe(`SELECT track_artist_id FROM "${SCHEMA}".compilation_track_artist WHERE id = $1`, [
      cta.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].track_artist_id).toBeNull();

    // And the snapshot holds the credit as it stood BEFORE the null, which is
    // the only surviving record of which artist that track was canonicalized
    // to. `track_artist_id` is the field that matters: the live row's copy is
    // now NULL, so a capture that read after the delete — or that stored an
    // empty array for an artist that has credits — would leave the link
    // unrecoverable with every other assertion here still green.
    const [snapshot] = await sql.unsafe(
      `SELECT captured FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'artist' AND entity_id = $1`,
      [artist.id]
    );
    const capturedCredits = snapshot.captured.children.compilation_track_artist;
    expect(capturedCredits).toHaveLength(1);
    expect(capturedCredits[0].id).toBe(cta.id);
    expect(capturedCredits[0].track_artist_id).toBe(artist.id);
  });
});
