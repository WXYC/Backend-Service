/**
 * Integration tests for DELETE /library/:id (BS#2112).
 *
 * Covers the D10 dependent-row policy end to end against the real DB:
 *   - happy-path hard delete (200, with a play-count body — not 204, which
 *     Express strips the body from), and the row is really gone (a second
 *     delete 404s) rather than soft-tombstoned.
 *   - the library_watermark advance so a client holding a pre-delete
 *     Last-Modified re-pulls the catalog instead of 304-ing stale.
 *   - the flowsheet play count (BS#2565 D1 removed the 409 refusal over it):
 *     a release carrying plays deletes anyway, and the 200 body reports the
 *     damage split by path, never summed.
 *   - the four blocking FKs (`bins`, `library_identity`,
 *     `library_identity_source`, `artist_library_crossreference`) resolved
 *     inside the same transaction as the delete, rather than the DELETE
 *     raising a raw FK-violation 500. `artist_library_crossreference` is
 *     the surprise fourth: schema.ts declares its FK `onDelete: 'cascade'`,
 *     but the live constraint (migration 0022) was created `ON DELETE no
 *     action` and never migrated to match — verified against
 *     `pg_constraint.confdeltype`, not just the Drizzle model.
 *   - the real cascading dependents (`rotation`, `rotation_urls`,
 *     `album_metadata`, `album_critic_reviews`, `reviews`,
 *     `compilation_track_artist`, `uncovered_release_search_markers`) left
 *     to their own `onDelete: 'cascade'` FK, plus
 *     `album_review_submissions`'s `onDelete: 'set null'` divergence (the
 *     row survives, unlinked) — a subset of these are ALSO snapshotted
 *     before the cascade runs, see the BS#2560 bullet below.
 *   - the DIGITAL-ASSET refusal (BS#2560 finding 2): `digital_asset.library_id`
 *     has no `onDelete` at all (no cascade, no set-null), so a bound release
 *     is refused with 409 (`reason: 'digital_asset_references'`) rather than
 *     raising a raw FK-violation 500.
 *   - the TRANSITIVE count: plays reachable only via `flowsheet.rotation_id`
 *     -> `rotation.album_id` (`set null` behind a `cascade`), the routine
 *     shape the tubafrenzy webhook produces when it resolves the two columns
 *     independently. A direct-FK-only count would miss these silently.
 *   - the delete-denylist row: `jobs/library-etl` consults it on every
 *     invocation (scheduled or by hand — see the job's own docstring for why
 *     that distinction matters post-`cd8f058e`) and skips a denylisted
 *     release, so without this row it would re-import the still-present
 *     upstream release under a new `library.id` the next time anything
 *     re-selects it upstream. NOT on a 30-minute timer either way: the ETL's
 *     delta filter is `TIME_LAST_MODIFIED >` and this delete never touches
 *     tubafrenzy.
 *   - the actor recorded on that denylist row: `catalog:write` is held by two
 *     roles, so what-and-when without who leaves incident response unable to
 *     tell a legitimate deletion from an abusive one.
 *   - the LEGACY-ID count: plays that name the release only via
 *     `flowsheet.legacy_release_id`, which `jobs/legacy-linkage-resolve` has
 *     not yet resolved to an `album_id`. Deleting strands them permanently —
 *     the denylist guarantees no future library row carries that legacy id,
 *     so the resolver can never link them — which is why this arm is
 *     reported separately from the other two, never summed into them.
 *   - `library_identity_history` deliberately RETAINED and left dangling: a
 *     supersedure audit log has to outlive the row it describes.
 *   - migration 0148's `flowsheet_rotation_id_idx`, without which the
 *     transitive count seq-scans a ~2.6M-row heap past the 5s statement
 *     timeout while holding FOR UPDATE on live rows.
 *   - `album_popularity.representative_library_id` nulled — it names a
 *     library row and carries no FK, so nothing else stops it dangling.
 *   - migration 0147's repair of the drifted
 *     `artist_library_crossreference.library_id` ON DELETE action, asserted
 *     against `pg_constraint.confdeltype` rather than the Drizzle model
 *     (which claimed cascade all along).
 *   - 404 on an unknown id.
 *   - BS#2560 (F1): the delete writes a `catalog_delete_snapshot` row in the
 *     same transaction, capturing the eight irreplaceable children
 *     (`compilation_track_artist`, `library_urls`, `reviews`,
 *     `album_critic_reviews`, `bins`, `rotation`,
 *     `rotation_urls` — a depth-2 child of `rotation`, not of `library`
 *     directly — and `artist_library_crossreference`) as JSON, and a
 *     snapshot write that fails rolls the whole delete back — no listener,
 *     no swallow.
 *   - and that `album_review_submissions` is NOT among them: the row survives
 *     the delete unlinked, and its `reviewer_raw` / `social_consent_raw` are
 *     ADR-0011 PII that must never be copied into the permanently-retained
 *     `captured` column.
 *
 * TEARDOWN: this spec shares a database with the rest of the integration
 * suite, and its 409 cases deliberately create rows the endpoint under test
 * refuses to remove. Everything it creates is tracked and cleaned in
 * `afterAll` — see the comment there.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // shape-fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DELETE /library/:id (BS#2112)', () => {
  let auth;
  let sql;
  const uniq = Date.now();
  // Every library row this spec creates, and every out-of-band row it inserts
  // that the endpoint can't reach. Tracked for teardown.
  const createdAlbumIds = [];
  const createdSubmissionKeys = [];

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
  });

  /**
   * The digital-asset 409 cases are the reason this teardown still needs to
   * be this thorough: they create a release and assert the endpoint REFUSES
   * to delete it, so the endpoint under test cannot clean up after itself by
   * design, and each run would otherwise leak a library row into the shared
   * integration database indefinitely. (The flowsheet-play cases no longer
   * refuse post-BS#2565 — the delete does the cleanup for them — but every
   * `DELETE` here is idempotent, so covering both is cheaper than splitting
   * the fixtures apart.)
   *
   * Order matters and mirrors the endpoint's own: children that block or
   * dangle first, then the library row (whose FKs cascade the rest).
   * `library_delete_denylist` is keyed on `legacy_release_id`, not
   * `library.id`, so it's cleared by joining through the rows we created —
   * before they're deleted.
   */
  afterAll(async () => {
    if (sql) {
      try {
        if (createdSubmissionKeys.length > 0) {
          // Explicit `::text[]` / `::int[]` casts throughout — postgres-js
          // won't infer the array type for a bare `ANY($1)` on an `unsafe`
          // call, the same reason the sibling cleanup blocks in
          // artist-unicode-dedup-merge.spec.js and
          // admin-create-user-email-verify.spec.js spell theirs out.
          await sql.unsafe(`DELETE FROM "${SCHEMA}".album_review_submissions WHERE source_key = ANY($1::text[])`, [
            createdSubmissionKeys,
          ]);
        }
        if (createdAlbumIds.length > 0) {
          // Denylist first: it is keyed on `legacy_release_id`, so the
          // subquery arm has to run while the library rows still exist. The
          // `library_id` arm covers the rows the happy-path tests already
          // deleted, whose library row is long gone.
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".library_delete_denylist
              WHERE legacy_release_id IN (SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = ANY($1::int[]))
                 OR library_id = ANY($1::int[])`,
            [createdAlbumIds]
          );
          // Same ordering constraint as the denylist above: this joins through
          // `library.legacy_release_id`, so it has to run while the library
          // rows are still present.
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".flowsheet
              WHERE legacy_release_id IN (SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = ANY($1::int[]))`,
            [createdAlbumIds]
          );
          await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = ANY($1::int[])`, [createdAlbumIds]);
          // No FK, so nothing removes these with the library row — that is the
          // retention property the spec asserts, and the reason teardown has
          // to clear them by hand.
          await sql.unsafe(`DELETE FROM "${SCHEMA}".library_identity_history WHERE library_id = ANY($1::int[])`, [
            createdAlbumIds,
          ]);
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".flowsheet
              WHERE rotation_id IN (SELECT id FROM "${SCHEMA}".rotation WHERE album_id = ANY($1::int[]))`,
            [createdAlbumIds]
          );
          await sql.unsafe(`DELETE FROM "${SCHEMA}".bins WHERE album_id = ANY($1::int[])`, [createdAlbumIds]);
          await sql.unsafe(`DELETE FROM "${SCHEMA}".library_identity_source WHERE library_id = ANY($1::int[])`, [
            createdAlbumIds,
          ]);
          await sql.unsafe(`DELETE FROM "${SCHEMA}".library_identity WHERE library_id = ANY($1::int[])`, [
            createdAlbumIds,
          ]);
          await sql.unsafe(`DELETE FROM "${SCHEMA}".artist_library_crossreference WHERE library_id = ANY($1::int[])`, [
            createdAlbumIds,
          ]);
          await sql.unsafe(
            `UPDATE "${SCHEMA}".album_popularity SET representative_library_id = NULL
              WHERE representative_library_id = ANY($1::int[])`,
            [createdAlbumIds]
          );
          // Last: its FKs cascade rotation, album_metadata, reviews,
          // album_critic_reviews and compilation_track_artist away with it.
          await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1::int[])`, [createdAlbumIds]);
          // No FK ties a snapshot row to the (now-gone) library row it
          // describes — that's the point, see the schema.ts docstring — so
          // it has to be cleared by hand like library_identity_history above.
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY($1::int[])`,
            [createdAlbumIds]
          );
        }
      } finally {
        await sql.end();
      }
    }
  });

  const createAlbum = async (title) => {
    const res = await auth
      .post('/library')
      .send({
        album_title: title,
        artist_name: 'Built to Spill',
        label: `BS#2112 Delete Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    createdAlbumIds.push(res.body.id);
    return res.body;
  };

  test('hard-deletes an unreferenced release, returns 200, and advances the catalog watermark', async () => {
    const album = await createAlbum(`BS#2112 Happy Path ${uniq}`);

    const before = await auth.get('/library/catalog').expect(200);
    const lastModified = before.headers['last-modified'];
    // Ensure the next watermark lands in a strictly later whole second than
    // the captured Last-Modified (HTTP Date precision is whole seconds) —
    // same guard `library-catalog-export.spec.js` uses.
    await sleep(1100);

    await auth.delete(`/library/${album.id}`).expect(200);

    // The row is really gone (hard delete, not a soft-delete tombstone) — a
    // second delete has nothing left to find.
    await auth.delete(`/library/${album.id}`).expect(404);

    // library_watermark advanced: a client polling with the pre-delete
    // Last-Modified must re-pull the catalog rather than 304 a stale clone.
    const after = await auth.get('/library/catalog').set('If-Modified-Since', lastModified);
    expect(after.status).toBe(200);
  });

  test('returns 404 for an unknown id', async () => {
    await auth.delete('/library/99999999').expect(404);
  });

  // BS#2565 (D1): the 409 refusal over flowsheet plays is gone. A release
  // carrying plays deletes, reports the damage on the 200 body split by
  // path, and leaves a catalog_delete_snapshot row behind — the actual undo
  // path now that there is nothing left to refuse over.
  test('deletes a release carrying flowsheet plays, reporting the direct play count on the 200 body', async () => {
    const album = await createAlbum(`BS#2112 Flowsheet Plays ${uniq}`);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9500, 'Built to Spill', $2, 'probe track one'),
              ($1, 'track', 9501, 'Built to Spill', $2, 'probe track two')`,
      [album.id, `BS#2112 Flowsheet Plays ${uniq}`]
    );

    const res = await auth.delete(`/library/${album.id}`).expect(200);
    expect(res.body.direct_play_count).toBe(2);
    expect(res.body.rotation_linked_play_count).toBe(0);
    expect(res.body.legacy_linked_play_count).toBe(0);

    // Really deleted, and the plays' FK went with it (set-null, not the row).
    await auth.get('/library/info').query({ album_id: album.id }).expect(404);
    const rows = await sql.unsafe(
      `SELECT album_id FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`,
      [`BS#2112 Flowsheet Plays ${uniq}`]
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.album_id === null)).toBe(true);

    const snapshot = await sql.unsafe(
      `SELECT 1 FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1`,
      [album.id]
    );
    expect(snapshot).toHaveLength(1);

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
      `BS#2112 Flowsheet Plays ${uniq}`,
    ]);
  });

  test('resolves bins, library_identity, library_identity_source, and artist_library_crossreference inside the transaction instead of raising an FK violation', async () => {
    const album = await createAlbum(`BS#2112 Blocking FK ${uniq}`);

    await sql.unsafe(`INSERT INTO "${SCHEMA}".bins (dj_id, album_id, track_title) VALUES ($1, $2, 'probe bin pick')`, [
      global.primary_dj_id,
      album.id,
    ]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_identity (library_id, last_verified_at, method, confidence)
       VALUES ($1, now(), 'test_probe', 0.9)`,
      [album.id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_identity_source (library_id, source, external_id, method, confidence, last_verified_at)
       VALUES ($1, 'discogs', 'probe-external-id', 'test_probe', 0.9, now())`,
      [album.id]
    );
    // `artist_library_crossreference`'s live FK is `ON DELETE no action`
    // (migration 0022) despite schema.ts's `onDelete: 'cascade'` annotation
    // — a genuine drift this spec caught. It must be resolved explicitly
    // like the other three, not left to the FK.
    await sql.unsafe(`INSERT INTO "${SCHEMA}".artist_library_crossreference (artist_id, library_id) VALUES ($1, $2)`, [
      ART,
      album.id,
    ]);

    await auth.delete(`/library/${album.id}`).expect(200);

    const counts = await sql.unsafe(
      `SELECT
         (SELECT count(*)::int FROM "${SCHEMA}".bins WHERE album_id = $1) AS bins,
         (SELECT count(*)::int FROM "${SCHEMA}".library_identity WHERE library_id = $1) AS library_identity,
         (SELECT count(*)::int FROM "${SCHEMA}".library_identity_source WHERE library_id = $1) AS library_identity_source,
         (SELECT count(*)::int FROM "${SCHEMA}".artist_library_crossreference WHERE library_id = $1) AS artist_library_crossreference
      `,
      [album.id]
    );
    expect(counts[0]).toEqual({
      bins: 0,
      library_identity: 0,
      library_identity_source: 0,
      artist_library_crossreference: 0,
    });
  });

  test('leaves the real cascading dependents to their own FK', async () => {
    const album = await createAlbum(`BS#2112 Cascade ${uniq}`);
    const sourceKey = `probe-source-key-${album.id}`;
    createdSubmissionKeys.push(sourceKey);

    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H')`, [album.id]);
    await sql.unsafe(`INSERT INTO "${SCHEMA}".album_metadata (album_id) VALUES ($1)`, [album.id]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_critic_reviews (album_id, source, source_url, snippet)
       VALUES ($1, 'Probe Zine', 'https://example.com/probe', 'a probe snippet')`,
      [album.id]
    );
    await sql.unsafe(`INSERT INTO "${SCHEMA}".reviews (album_id) VALUES ($1)`, [album.id]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name) VALUES ($1, 'Probe CTA Artist')`,
      [album.id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_review_submissions (source, source_key, norm_artist, norm_album, album_id)
       VALUES ('google_form', $1, 'probe artist', 'probe album', $2)`,
      [sourceKey, album.id]
    );

    await auth.delete(`/library/${album.id}`).expect(200);

    const counts = await sql.unsafe(
      `SELECT
         (SELECT count(*)::int FROM "${SCHEMA}".rotation WHERE album_id = $1) AS rotation,
         (SELECT count(*)::int FROM "${SCHEMA}".album_metadata WHERE album_id = $1) AS album_metadata,
         (SELECT count(*)::int FROM "${SCHEMA}".album_critic_reviews WHERE album_id = $1) AS album_critic_reviews,
         (SELECT count(*)::int FROM "${SCHEMA}".reviews WHERE album_id = $1) AS reviews,
         (SELECT count(*)::int FROM "${SCHEMA}".compilation_track_artist WHERE library_id = $1) AS compilation_track_artist
       `,
      [album.id]
    );
    expect(counts[0]).toEqual({
      rotation: 0,
      album_metadata: 0,
      album_critic_reviews: 0,
      reviews: 0,
      compilation_track_artist: 0,
    });

    // album_review_submissions is `onDelete: 'set null'` — the row survives,
    // unlinked, not deleted (BS#2112's dependent-row map).
    const submission = await sql.unsafe(
      `SELECT album_id FROM "${SCHEMA}".album_review_submissions WHERE source_key = $1`,
      [sourceKey]
    );
    expect(submission[0].album_id).toBeNull();
  });

  /**
   * The transitive count. `rotation.album_id` is `cascade` and
   * `flowsheet.rotation_id` is `set null`, so deleting a release blanks
   * `rotation_id` on plays that reached it only through the rotation entry.
   * That is the routine shape, not an edge case: the tubafrenzy webhook
   * resolves `album_id` and `rotation_id` independently, so a play regularly
   * carries a `rotation_id` with a NULL `album_id`. A count that counted only
   * `flowsheet.album_id` would report 0 here and silently miss the damage to
   * every one of those plays.
   */
  test('deletes a release whose plays reach it only through its rotation entry, reporting them apart from direct plays', async () => {
    const album = await createAlbum(`BS#2112 Rotation Transitive ${uniq}`);

    const rotationRows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
      [album.id]
    );
    const rotationId = rotationRows[0].id;

    // album_id deliberately NULL — the whole point of the transitive path.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (rotation_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9600, 'Built to Spill', $2, 'rotation-only probe')`,
      [rotationId, `BS#2112 Rotation Transitive ${uniq}`]
    );

    const res = await auth.delete(`/library/${album.id}`).expect(200);
    expect(res.body.direct_play_count).toBe(0);
    expect(res.body.rotation_linked_play_count).toBe(1);
    expect(res.body.legacy_linked_play_count).toBe(0);

    // The rotation row cascaded away with the release; the play survives with
    // its rotation_id blanked, not deleted.
    const surviving = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".flowsheet WHERE rotation_id = $1`, [
      rotationId,
    ]);
    expect(surviving[0].n).toBe(0);

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
      `BS#2112 Rotation Transitive ${uniq}`,
    ]);
  });

  test('counts a play linked by both paths once, not twice', async () => {
    const album = await createAlbum(`BS#2112 Both Paths ${uniq}`);

    const rotationRows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
      [album.id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, rotation_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, $2, 'track', 9700, 'Built to Spill', $3, 'both-paths probe')`,
      [album.id, rotationRows[0].id, `BS#2112 Both Paths ${uniq}`]
    );

    const res = await auth.delete(`/library/${album.id}`).expect(200);
    expect(res.body.direct_play_count).toBe(1);
    expect(res.body.rotation_linked_play_count).toBe(0);
    expect(res.body.legacy_linked_play_count).toBe(0);

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'Built to Spill' AND album_title = $1`, [
      `BS#2112 Both Paths ${uniq}`,
    ]);
  });

  /**
   * Durability against `jobs/library-etl`. A Backend-side delete does not
   * reach tubafrenzy, so the upstream `LIBRARY_RELEASE` row survives; the
   * ETL is still cron-registered every 30 minutes, and its next delta pass
   * would find no `library` row carrying this `legacy_release_id` and
   * re-insert the release under a new `library.id` — without the rotation,
   * metadata, and review rows that cascaded away. The denylist row is what
   * the ETL consults to skip it.
   */
  test('records the deleted release in the ETL delete-denylist', async () => {
    const album = await createAlbum(`BS#2112 Denylist ${uniq}`);

    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;
    expect(legacyReleaseId).not.toBeNull();

    await auth.delete(`/library/${album.id}`).expect(200);

    const denylisted = await sql.unsafe(
      `SELECT library_id, deleted_at FROM "${SCHEMA}".library_delete_denylist WHERE legacy_release_id = $1`,
      [legacyReleaseId]
    );
    expect(denylisted).toHaveLength(1);
    expect(denylisted[0].library_id).toBe(album.id);
    expect(denylisted[0].deleted_at).not.toBeNull();
  });

  // Flowsheet plays no longer refuse the delete post-BS#2565, so the only
  // remaining refusal is the digital-asset one — this asserts the denylist
  // stays clean for that path.
  test('writes no denylist row when the delete is refused over a live digital asset', async () => {
    const album = await createAlbum(`BS#2112 Denylist Refusal ${uniq}`);
    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset (library_id, provenance, disc_number, status)
       VALUES ($1, 'rotation_upload', 1, 'needs_review')`,
      [album.id]
    );

    try {
      await auth.delete(`/library/${album.id}`).expect(409);

      const denylisted = await sql.unsafe(
        `SELECT 1 FROM "${SCHEMA}".library_delete_denylist WHERE legacy_release_id = $1`,
        [legacyReleaseId]
      );
      expect(denylisted).toHaveLength(0);
    } finally {
      // Same reason as the digital-asset refusal test below: the shared
      // teardown's unconditional library DELETE would hit the FK violation
      // this test exists to catch.
      await sql.unsafe(`DELETE FROM "${SCHEMA}".digital_asset WHERE library_id = $1`, [album.id]);
    }
  });

  /**
   * `album_popularity.representative_library_id` names a library row but
   * carries no foreign key at all, so neither a cascade nor a set-null
   * reaches it — an unguarded delete leaves it pointing at an id that no
   * longer exists, which the Track 3 export then joins against.
   */
  test('nulls album_popularity.representative_library_id rather than leaving it dangling', async () => {
    const album = await createAlbum(`BS#2112 Popularity ${uniq}`);
    const popularityKey = `bs2112-popularity-${album.id}`;

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_popularity (logical_album_key, plays, linked_plays, freetext_plays, representative_library_id)
       VALUES ($1, 0, 0, 0, $2)`,
      [popularityKey, album.id]
    );

    await auth.delete(`/library/${album.id}`).expect(200);

    const rows = await sql.unsafe(
      `SELECT representative_library_id FROM "${SCHEMA}".album_popularity WHERE logical_album_key = $1`,
      [popularityKey]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].representative_library_id).toBeNull();

    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_popularity WHERE logical_album_key = $1`, [popularityKey]);
  });

  /**
   * Migration 0147. schema.ts and every meta snapshot from 0022 forward
   * declared this FK `onDelete: 'cascade'`; the live constraint was created
   * `ON DELETE no action` and never migrated to match. drizzle-kit diffs
   * schema.ts against the SNAPSHOT, never the database, so it could not
   * detect the drift and would never emit a corrective diff on its own.
   * Asserted against the catalog rather than the Drizzle model, because the
   * Drizzle model is the thing that was wrong.
   */
  test('artist_library_crossreference.library_id really is ON DELETE CASCADE (migration 0147)', async () => {
    const rows = await sql.unsafe(
      `SELECT confdeltype
         FROM pg_constraint
        WHERE conname = 'artist_library_crossreference_library_id_library_id_fk'
          AND conrelid = to_regclass($1)`,
      [`${SCHEMA}.artist_library_crossreference`]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].confdeltype).toBe('c');
  });

  /**
   * Migration 0148. The only index that touched `flowsheet.rotation_id` was
   * `flowsheet_rotation_no_match_idx`, partial on `metadata_status =
   * 'enriched_no_match'`. The transitive play-count query's predicate does not
   * imply that, so the planner could not use it and fell back to a sequential
   * scan of the ~2.6M-row / ~1.7 GB heap — past the 5s `DB_STATEMENT_TIMEOUT_MS`,
   * while this transaction holds FOR UPDATE on the library row and every one of
   * its rotation rows. Every binned release would have 500'd.
   *
   * Asserted against `pg_indexes` rather than the Drizzle model for the same
   * reason the 0147 assertion above is: what matters is what the database has.
   */
  test('flowsheet.rotation_id has a general partial index (migration 0148)', async () => {
    const rows = await sql.unsafe(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'flowsheet_rotation_id_idx'`,
      [SCHEMA]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/rotation_id/);
    // Partial on the linked rows only — the overwhelming majority of
    // `flowsheet` never sets the column, so the predicate is what keeps this
    // small on a multi-million-row table.
    expect(rows[0].indexdef).toMatch(/WHERE \(rotation_id IS NOT NULL\)/);
  });

  /**
   * BS#2112 review finding 8, still true post-BS#2565. The tubafrenzy webhook
   * writes `flowsheet.legacy_release_id` on every entry and resolves
   * `album_id` separately; `jobs/legacy-linkage-resolve` closes the gap on a
   * half-hourly cron. A play sitting in that window has a NULL `album_id` and
   * no `rotation_id`, so a count of only the two FK paths reads zero. Deleting
   * now strands it: the denylist means no future `library` row ever carries
   * that `legacy_release_id`, so the resolver can never link the play and its
   * provenance is gone for good — which is why this arm is reported apart
   * from the other two on the 200 body, never summed into them.
   */
  test('deletes a release whose plays name it only by its legacy release id, reporting them as the stranded arm', async () => {
    const album = await createAlbum(`BS#2112 Legacy Linked ${uniq}`);
    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;

    // Exactly the shape the webhook leaves behind: legacy id present,
    // album_id and rotation_id both NULL.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (legacy_release_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9900, 'Built to Spill', $2, 'unlinked probe')`,
      [legacyReleaseId, `BS#2112 Legacy Linked ${uniq}`]
    );

    const res = await auth.delete(`/library/${album.id}`).expect(200);
    expect(res.body.direct_play_count).toBe(0);
    expect(res.body.rotation_linked_play_count).toBe(0);
    expect(res.body.legacy_linked_play_count).toBe(1);

    const stillThere = await sql.unsafe(`SELECT id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    expect(stillThere).toHaveLength(0);

    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE legacy_release_id = $1`, [legacyReleaseId]);
  });

  /**
   * `catalog:write` is held by two roles (musicDirector, stationManager), so a
   * denylist row naming only the release and the timestamp leaves incident
   * response with no way to separate a legitimate deletion from an abusive
   * one. Migration 0149 adds the three attribution columns.
   */
  test('records who issued the delete on the denylist row', async () => {
    const album = await createAlbum(`BS#2112 Actor ${uniq}`);
    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;

    await auth.delete(`/library/${album.id}`).expect(200);

    const rows = await sql.unsafe(
      `SELECT deleted_by_user_id, deleted_by_email, deleted_by_role
         FROM "${SCHEMA}".library_delete_denylist WHERE legacy_release_id = $1`,
      [legacyReleaseId]
    );
    expect(rows).toHaveLength(1);
    // The suite's token carries a subject; assert a non-empty id rather than a
    // specific one, since the fixture user's id is allocated at setup time.
    expect(typeof rows[0].deleted_by_user_id).toBe('string');
    expect(rows[0].deleted_by_user_id.length).toBeGreaterThan(0);
  });

  /**
   * `library_identity_history` is the OTHER FK-less reference to `library.id`,
   * and unlike `album_popularity` it is deliberately left dangling: a
   * supersedure audit log has to outlive the row it describes, or cascading it
   * destroys exactly the record an auditor came for. Pinned so a later "tidy up
   * the orphans" change has to argue with this test — and so a reader who finds
   * an unresolvable `library_id` knows it is intended.
   */
  test('retains library_identity_history rows, deliberately dangling', async () => {
    const album = await createAlbum(`BS#2112 Identity History ${uniq}`);

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_identity_history (library_id, superseded_reason)
       VALUES ($1, 'BS#2112 retention probe')`,
      [album.id]
    );

    await auth.delete(`/library/${album.id}`).expect(200);

    const rows = await sql.unsafe(
      `SELECT h.library_id, l.id AS library_row
         FROM "${SCHEMA}".library_identity_history h
         LEFT JOIN "${SCHEMA}".library l ON l.id = h.library_id
        WHERE h.library_id = $1`,
      [album.id]
    );
    expect(rows).toHaveLength(1);
    // The audit row survives; the release it names does not. That is the
    // intended end state, not corruption.
    expect(rows[0].library_row).toBeNull();

    await sql.unsafe(`DELETE FROM "${SCHEMA}".library_identity_history WHERE library_id = $1`, [album.id]);
  });

  /**
   * BS#2560 (F1). Captures the eight irreplaceable children as JSON, keyed by
   * table name, in the same `catalog_delete_snapshot` row — one row per
   * insert into `bins`/`rotation`/`reviews`/etc, populated for every table
   * this delete can reach. `rotation_urls` is the depth-2 case (finding 1):
   * its own FK points at `rotation.id`, not `library.id`, so it proves
   * `captureCatalogDeleteSnapshot`'s `via` shape actually resolves through
   * the parent hop rather than silently capturing nothing. `album_metadata`,
   * `library_identity` + `library_identity_source`, and
   * `uncovered_release_search_markers` are deliberately absent (derived
   * data, re-obtained on restore rather than stored forever — see the
   * schema.ts docstring).
   */
  test('writes a catalog_delete_snapshot row capturing the eight irreplaceable children', async () => {
    const album = await createAlbum(`BS#2560 Snapshot ${uniq}`);
    // Two columns the ETL never refreshes (`LEGACY_SOURCED_LIBRARY_COLUMNS`
    // covers neither), so they are recoverable from the parent capture or
    // nowhere.
    // `library_discogs_unavailable_note_check` is `flag OR note IS NULL`, so
    // the flag has to be set for the note to be storable at all.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".library
          SET label = 'Snapshot Probe Label', discogs_unavailable = true, discogs_unavailable_note = 'snapshot probe note'
        WHERE id = $1`,
      [album.id]
    );
    const submissionSourceKey = `bs2560-snapshot-probe-${album.id}`;
    createdSubmissionKeys.push(submissionSourceKey);

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".bins (dj_id, album_id, track_title) VALUES ($1, $2, 'snapshot probe bin')`,
      [global.primary_dj_id, album.id]
    );
    const [rotationRow] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin) VALUES ($1, 'H') RETURNING id`,
      [album.id]
    );
    // Depth-2 child of `library` (finding 1): its FK is `rotation_id ->
    // rotation.id`, never `library.id` directly.
    await sql.unsafe(`INSERT INTO "${SCHEMA}".rotation_urls (rotation_id, url, position) VALUES ($1, $2, 0)`, [
      rotationRow.id,
      'https://example.com/snapshot-probe-rotation-url',
    ]);
    await sql.unsafe(`INSERT INTO "${SCHEMA}".reviews (album_id, review) VALUES ($1, 'snapshot probe review')`, [
      album.id,
    ]);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_critic_reviews (album_id, source, source_url, snippet)
       VALUES ($1, 'Probe Zine', 'https://example.com/snapshot-probe', 'a snapshot probe snippet')`,
      [album.id]
    );
    // `reviewer_raw` carries a distinctive probe value so the assertions below
    // can prove the PII neither reaches the snapshot as a KEY nor as a VALUE.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_review_submissions (source, source_key, norm_artist, norm_album, album_id, reviewer_raw)
       VALUES ('google_form', $1, 'snapshot probe artist', 'snapshot probe album', $2, 'BS2560-PII-PROBE-REVIEWER')`,
      [submissionSourceKey, album.id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name) VALUES ($1, 'Snapshot Probe Artist')`,
      [album.id]
    );
    await sql.unsafe(`INSERT INTO "${SCHEMA}".library_urls (library_id, url, position) VALUES ($1, $2, 0)`, [
      album.id,
      'https://example.com/snapshot-probe-url',
    ]);
    await sql.unsafe(`INSERT INTO "${SCHEMA}".artist_library_crossreference (artist_id, library_id) VALUES ($1, $2)`, [
      ART,
      album.id,
    ]);
    // A derived child, deliberately never captured — asserted absent below.
    await sql.unsafe(`INSERT INTO "${SCHEMA}".album_metadata (album_id) VALUES ($1)`, [album.id]);

    await auth.delete(`/library/${album.id}`).expect(200);

    const rows = await sql.unsafe(
      `SELECT entity_kind, entity_id, captured, actor_user_id
         FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1`,
      [album.id]
    );
    expect(rows).toHaveLength(1);
    const { captured } = rows[0];
    expect(rows[0].entity_kind).toBe('library');
    expect(typeof rows[0].actor_user_id).toBe('string');

    // The deleted PARENT row, namespaced away from the children so no child
    // table name can shadow it. This is the half the ETL restore path cannot
    // reproduce: `LEGACY_SOURCED_LIBRARY_COLUMNS` excludes `label` and
    // `discogs_unavailable*`, and a Backend-minted release has no upstream row
    // to re-import at all.
    expect(captured.entity.table).toBe('library');
    expect(captured.entity.row.id).toBe(album.id);
    expect(captured.entity.row.album_title).toBe(`BS#2560 Snapshot ${uniq}`);
    expect(captured.entity.row.label).toBe('Snapshot Probe Label');
    expect(captured.entity.row.discogs_unavailable).toBe(true);
    expect(captured.entity.row.discogs_unavailable_note).toBe('snapshot probe note');
    expect(captured.entity.row.legacy_release_id).not.toBeNull();
    // Generated columns are recomputed on re-insert, so storing one would be
    // permanent waste.
    expect(captured.entity.row.search_doc).toBeUndefined();

    const children = captured.children;
    expect(children.bins).toHaveLength(1);
    expect(children.rotation).toHaveLength(1);
    expect(children.rotation_urls).toHaveLength(1);
    expect(children.rotation_urls[0].url).toBe('https://example.com/snapshot-probe-rotation-url');
    expect(children.rotation_urls[0].rotation_id).toBe(rotationRow.id);
    expect(children.reviews).toHaveLength(1);
    expect(children.reviews[0].review).toBe('snapshot probe review');
    expect(children.album_critic_reviews).toHaveLength(1);
    expect(children.compilation_track_artist).toHaveLength(1);
    expect(children.library_urls).toHaveLength(1);
    expect(children.artist_library_crossreference).toHaveLength(1);
    // Round-trip proof for the depth-2 child (finding 1): the rows are gone
    // from `rotation_urls` (cascade-destroyed) but recoverable from the
    // snapshot alone.
    const rotationUrlsLive = await sql.unsafe(`SELECT 1 FROM "${SCHEMA}".rotation_urls WHERE rotation_id = $1`, [
      rotationRow.id,
    ]);
    expect(rotationUrlsLive).toHaveLength(0);
    // `album_review_submissions` is the reverse case, and the reason it is
    // NOT captured (BS#2560 review, SECURITY): the row is still in the live
    // table, merely unlinked, so there is nothing to restore — and capturing
    // it would copy `reviewer_raw`/`social_consent_raw` into this
    // permanently-retained column, the ADR-0011 second reader.
    const submissionLive = await sql.unsafe(
      `SELECT album_id FROM "${SCHEMA}".album_review_submissions WHERE source_key = $1`,
      [submissionSourceKey]
    );
    expect(submissionLive).toHaveLength(1);
    expect(submissionLive[0].album_id).toBeNull();
    expect(children.album_review_submissions).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain('reviewer_raw');
    expect(JSON.stringify(captured)).not.toContain('BS2560-PII-PROBE-REVIEWER');
    // The four derived children never appear in the captured JSON at all.
    expect(children.album_metadata).toBeUndefined();
    expect(children.library_identity).toBeUndefined();
    expect(children.library_identity_source).toBeUndefined();
    expect(children.uncovered_release_search_markers).toBeUndefined();
  });

  /**
   * BS#2560 (F1) acceptance criterion: a failed snapshot rolls the delete
   * back, unlike tubafrenzy's `AuditLibraryReleaseListener`, which fired
   * after the fact behind a catch that logged and swallowed. Forces the
   * failure with a trigger on `catalog_delete_snapshot` rather than mocking
   * anything, since the whole point under test is real transactional
   * atomicity.
   */
  test('rolls back the delete when the snapshot write fails', async () => {
    const album = await createAlbum(`BS#2560 Snapshot Failure ${uniq}`);

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION "${SCHEMA}".bs2560_fail_snapshot() RETURNS trigger AS $trigger$
      BEGIN
        IF NEW.entity_id = ${album.id} THEN
          RAISE EXCEPTION 'BS#2560 probe: forced snapshot failure';
        END IF;
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql;
    `);
    // `CREATE TRIGGER` has no `OR REPLACE` form in PG 14 (unlike the
    // function above), so a run that dies before reaching the `finally`
    // below — a killed worker, a Jest timeout abort, `--bail` — would
    // otherwise leave this trigger installed on the shared integration
    // database and fail every later run's `CREATE TRIGGER` at setup, not at
    // the assertion. Drop first so setup is idempotent regardless.
    await sql.unsafe(`DROP TRIGGER IF EXISTS bs2560_fail_snapshot_trigger ON "${SCHEMA}".catalog_delete_snapshot`);
    await sql.unsafe(`
      CREATE TRIGGER bs2560_fail_snapshot_trigger
      BEFORE INSERT ON "${SCHEMA}".catalog_delete_snapshot
      FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".bs2560_fail_snapshot();
    `);

    try {
      await auth.delete(`/library/${album.id}`).expect(500);

      // Rolled back, not partially applied: the release survives, no
      // snapshot row exists, and the denylist tombstone that would normally
      // accompany the delete never landed either.
      const stillThere = await sql.unsafe(`SELECT id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
      expect(stillThere).toHaveLength(1);
      const snapshot = await sql.unsafe(
        `SELECT 1 FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1`,
        [album.id]
      );
      expect(snapshot).toHaveLength(0);
      const denylisted = await sql.unsafe(`SELECT 1 FROM "${SCHEMA}".library_delete_denylist WHERE library_id = $1`, [
        album.id,
      ]);
      expect(denylisted).toHaveLength(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS bs2560_fail_snapshot_trigger ON "${SCHEMA}".catalog_delete_snapshot`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS "${SCHEMA}".bs2560_fail_snapshot()`);
    }
  });

  /**
   * BS#2560 finding 2a. `digital_asset.library_id` is NOT NULL with no
   * `onDelete` at all (no cascade, no set-null) — verified against
   * migration 0158's DDL, not just the Drizzle model — so an unguarded
   * `DELETE FROM library` would raise a raw FK-violation 500 for any release
   * `jobs/digital-archive-bind` has written an asset for. That is the wrong
   * outcome regardless: this endpoint's contract is a four-outcome taxonomy
   * (204 / 409 refused on the merits / 503 retryable / 404), never a raw
   * 500 and never a silent cascade through irreplaceable rip evidence. The
   * refusal names the bound asset(s) rather than just counting them, since
   * — unlike the flowsheet play-count refusal — there is no snapshot to fall
   * back on here; the librarian needs enough to go find the asset.
   */
  test('refuses with 409, not 500, when the release has a live digital asset', async () => {
    const album = await createAlbum(`BS#2560 Digital Asset ${uniq}`);

    const [assetRow] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset (library_id, provenance, disc_number, status)
       VALUES ($1, 'rotation_upload', 1, 'needs_review') RETURNING id`,
      [album.id]
    );

    try {
      const res = await auth.delete(`/library/${album.id}`).expect(409);
      expect(res.body.reason).toBe('digital_asset_references');
      expect(res.body.asset_count).toBe(1);
      expect(res.body.assets).toEqual([
        { id: assetRow.id, provenance: 'rotation_upload', disc_number: 1, status: 'needs_review' },
      ]);

      // Refused on the merits, not destroyed: the release and the asset both
      // survive the refused request, and no snapshot was written for a
      // delete that never happened.
      const stillThere = await sql.unsafe(`SELECT id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
      expect(stillThere).toHaveLength(1);
      const assetStillThere = await sql.unsafe(`SELECT id FROM "${SCHEMA}".digital_asset WHERE library_id = $1`, [
        album.id,
      ]);
      expect(assetStillThere).toHaveLength(1);
      const snapshot = await sql.unsafe(
        `SELECT 1 FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1`,
        [album.id]
      );
      expect(snapshot).toHaveLength(0);
    } finally {
      // `digital_asset` has no `onDelete`, so the shared `afterAll`
      // teardown's unconditional `DELETE FROM library` would hit the same
      // FK violation this test exists to catch — for every album in that
      // batched delete, not just this one. Clear it here rather than let
      // the suite's teardown be the one that discovers that.
      await sql.unsafe(`DELETE FROM "${SCHEMA}".digital_asset WHERE library_id = $1`, [album.id]);
    }
  });

  /**
   * BS#2560 review finding 2. Refusing on EVERY `digital_asset` status made a
   * release permanently undeletable through the API: nothing in this service
   * can clear or delete a `digital_asset` row, so a reviewer rejecting a
   * mis-bound asset stranded the release forever — recoverable only by
   * hand-written SQL against prod, over evidence the station had already
   * decided was wrong. `merge.ts` already deletes through this table on a
   * merge, on the reasoning that BS#2319's bind job rediscovers assets by
   * scanning the store. A rejected asset is therefore deleted through, not
   * refused over — but snapshotted first, with its `digital_asset_file` rows,
   * so the `object_key`s of the objects the cascade orphans stay on record.
   */
  test('deletes a release whose only digital asset was rejected, snapshotting the asset and its files', async () => {
    const album = await createAlbum(`BS#2560 Rejected Asset ${uniq}`);

    const [assetRow] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset (library_id, provenance, disc_number, status, bind_note)
       VALUES ($1, 'rotation_upload', 1, 'rejected', 'wrong album') RETURNING id`,
      [album.id]
    );
    const [storeRow] = await sql.unsafe(`INSERT INTO "${SCHEMA}".digital_asset_store (name) VALUES ($1) RETURNING id`, [
      `bs2560-probe-store-${album.id}`,
    ]);
    const objectKey = `bs2560-probe/${album.id}/track01.mp3`;
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset_file (asset_id, store_id, object_key, codec, title, bytes)
       VALUES ($1, $2, $3, 'mp3', 'snapshot probe track', 1024)`,
      [assetRow.id, storeRow.id, objectKey]
    );

    try {
      // Not a 409: a rejected asset is not a reason to make a release immortal.
      await auth.delete(`/library/${album.id}`).expect(200);

      const assetGone = await sql.unsafe(`SELECT id FROM "${SCHEMA}".digital_asset WHERE id = $1`, [assetRow.id]);
      expect(assetGone).toHaveLength(0);
      // `digital_asset_file.asset_id` is ON DELETE cascade, so the file rows
      // went with it — which is exactly why they had to be captured.
      const fileGone = await sql.unsafe(`SELECT id FROM "${SCHEMA}".digital_asset_file WHERE asset_id = $1`, [
        assetRow.id,
      ]);
      expect(fileGone).toHaveLength(0);

      const [snapshot] = await sql.unsafe(
        `SELECT captured FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = $1`,
        [album.id]
      );
      const children = snapshot.captured.children;
      expect(children.digital_asset).toHaveLength(1);
      expect(children.digital_asset[0].id).toBe(assetRow.id);
      expect(children.digital_asset[0].status).toBe('rejected');
      // The depth-2 file child, reached through `digital_asset.id` rather than
      // `library.id` — the second `via` child in the capture list, and the one
      // carrying the store keys a re-bind needs.
      expect(children.digital_asset_file).toHaveLength(1);
      expect(children.digital_asset_file[0].object_key).toBe(objectKey);
    } finally {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".digital_asset WHERE library_id = $1`, [album.id]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".digital_asset_store WHERE id = $1`, [storeRow.id]);
    }
  });
});
