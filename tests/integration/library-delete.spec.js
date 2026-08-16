/**
 * Integration tests for DELETE /library/:id (BS#2112).
 *
 * Covers the D10 dependent-row policy end to end against the real DB:
 *   - happy-path hard delete (204), and the row is really gone (a second
 *     delete 404s) rather than soft-tombstoned.
 *   - the library_watermark advance so a client holding a pre-delete
 *     Last-Modified re-pulls the catalog instead of 304-ing stale.
 *   - the flowsheet-referenced 409 refusal: never silently blank play
 *     history via the `flowsheet.album_id` set-null FK — the release and
 *     its plays both survive the refused request.
 *   - the four blocking FKs (`bins`, `library_identity`,
 *     `library_identity_source`, `artist_library_crossreference`) resolved
 *     inside the same transaction as the delete, rather than the DELETE
 *     raising a raw FK-violation 500. `artist_library_crossreference` is
 *     the surprise fourth: schema.ts declares its FK `onDelete: 'cascade'`,
 *     but the live constraint (migration 0022) was created `ON DELETE no
 *     action` and never migrated to match — verified against
 *     `pg_constraint.confdeltype`, not just the Drizzle model.
 *   - the real cascading dependents (`rotation`, `album_metadata`,
 *     `album_critic_reviews`, `reviews`, `compilation_track_artist`) left
 *     to their own `onDelete: 'cascade'` FK, plus
 *     `album_review_submissions`'s `onDelete: 'set null'` divergence (the
 *     row survives, unlinked).
 *   - the TRANSITIVE refusal: plays reachable only via `flowsheet.rotation_id`
 *     -> `rotation.album_id` (`set null` behind a `cascade`), the routine
 *     shape the tubafrenzy webhook produces when it resolves the two columns
 *     independently. A direct-FK-only guard blanks these silently.
 *   - the delete-denylist row, without which `jobs/library-etl` re-imports
 *     the still-present upstream release under a new `library.id` the next
 *     time anything re-selects it upstream (an edit in /wxycdb, or a full
 *     re-sync — NOT on a 30-minute timer; the ETL's delta filter is
 *     `TIME_LAST_MODIFIED >` and this delete never touches tubafrenzy).
 *   - the actor recorded on that denylist row: `catalog:write` is held by two
 *     roles, so what-and-when without who leaves incident response unable to
 *     tell a legitimate deletion from an abusive one.
 *   - the LEGACY-ID refusal: plays that name the release only via
 *     `flowsheet.legacy_release_id`, which `jobs/legacy-linkage-resolve` has
 *     not yet resolved to an `album_id`. Deleting in that window is worse
 *     than blanking — the denylist guarantees no future library row carries
 *     that legacy id, so the resolver can never link them.
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
   * The 409 cases are the reason this teardown exists. They create a release,
   * attach flowsheet plays, and then assert the endpoint REFUSES to delete it
   * — so the endpoint under test cannot clean up after itself by design, and
   * each run would otherwise leak a library row plus its plays into the
   * shared integration database indefinitely.
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

  test('hard-deletes an unreferenced release, returns 204, and advances the catalog watermark', async () => {
    const album = await createAlbum(`BS#2112 Happy Path ${uniq}`);

    const before = await auth.get('/library/catalog').expect(200);
    const lastModified = before.headers['last-modified'];
    // Ensure the next watermark lands in a strictly later whole second than
    // the captured Last-Modified (HTTP Date precision is whole seconds) —
    // same guard `library-catalog-export.spec.js` uses.
    await sleep(1100);

    await auth.delete(`/library/${album.id}`).expect(204);

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

  test('refuses with 409 naming the play count when the release carries flowsheet plays (D10)', async () => {
    const album = await createAlbum(`BS#2112 Flowsheet Refusal ${uniq}`);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9500, 'Built to Spill', $2, 'probe track one'),
              ($1, 'track', 9501, 'Built to Spill', $2, 'probe track two')`,
      [album.id, `BS#2112 Flowsheet Refusal ${uniq}`]
    );

    const res = await auth.delete(`/library/${album.id}`).expect(409);
    expect(res.body.reason).toBe('flowsheet_references');
    expect(res.body.play_count).toBe(2);
    expect(res.body.direct_play_count).toBe(2);
    expect(res.body.rotation_linked_play_count).toBe(0);
    expect(res.body.message).toContain('2');

    // Refused, not partially applied: the release and its plays both survive.
    const info = await auth.get('/library/info').query({ album_id: album.id }).expect(200);
    expect(info.body.id).toBe(album.id);
    const plays = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".flowsheet WHERE album_id = $1`, [
      album.id,
    ]);
    expect(plays[0].n).toBe(2);
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

    await auth.delete(`/library/${album.id}`).expect(204);

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

    await auth.delete(`/library/${album.id}`).expect(204);

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
   * The transitive refusal. `rotation.album_id` is `cascade` and
   * `flowsheet.rotation_id` is `set null`, so deleting a release blanks
   * `rotation_id` on plays that reached it only through the rotation entry.
   * That is the routine shape, not an edge case: the tubafrenzy webhook
   * resolves `album_id` and `rotation_id` independently, so a play regularly
   * carries a `rotation_id` with a NULL `album_id`. A guard that counted only
   * `flowsheet.album_id` would return 204 here and silently destroy the
   * provenance of every one of those plays.
   */
  test('refuses with 409 when plays reach the release only through its rotation entry', async () => {
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

    const res = await auth.delete(`/library/${album.id}`).expect(409);
    expect(res.body.reason).toBe('flowsheet_references');
    expect(res.body.play_count).toBe(1);
    expect(res.body.direct_play_count).toBe(0);
    expect(res.body.rotation_linked_play_count).toBe(1);
    expect(res.body.message).toContain('rotation entry');

    // Refused, not partially applied: the rotation row and the play's link
    // to it both survive.
    const surviving = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".flowsheet WHERE rotation_id = $1`, [
      rotationId,
    ]);
    expect(surviving[0].n).toBe(1);
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

    const res = await auth.delete(`/library/${album.id}`).expect(409);
    expect(res.body.play_count).toBe(1);
    expect(res.body.direct_play_count).toBe(1);
    expect(res.body.rotation_linked_play_count).toBe(0);
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

    await auth.delete(`/library/${album.id}`).expect(204);

    const denylisted = await sql.unsafe(
      `SELECT library_id, deleted_at FROM "${SCHEMA}".library_delete_denylist WHERE legacy_release_id = $1`,
      [legacyReleaseId]
    );
    expect(denylisted).toHaveLength(1);
    expect(denylisted[0].library_id).toBe(album.id);
    expect(denylisted[0].deleted_at).not.toBeNull();
  });

  test('writes no denylist row when the delete is refused', async () => {
    const album = await createAlbum(`BS#2112 Denylist Refusal ${uniq}`);
    const before = await sql.unsafe(`SELECT legacy_release_id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    const legacyReleaseId = before[0].legacy_release_id;

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
       VALUES ($1, 'track', 9800, 'Built to Spill', $2, 'refusal probe')`,
      [album.id, `BS#2112 Denylist Refusal ${uniq}`]
    );

    await auth.delete(`/library/${album.id}`).expect(409);

    const denylisted = await sql.unsafe(
      `SELECT 1 FROM "${SCHEMA}".library_delete_denylist WHERE legacy_release_id = $1`,
      [legacyReleaseId]
    );
    expect(denylisted).toHaveLength(0);
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

    await auth.delete(`/library/${album.id}`).expect(204);

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
   * BS#2112 review finding 8. The tubafrenzy webhook writes
   * `flowsheet.legacy_release_id` on every entry and resolves `album_id`
   * separately; `jobs/legacy-linkage-resolve` closes the gap on a half-hourly
   * cron. A play sitting in that window has a NULL `album_id` and no
   * `rotation_id`, so a guard counting only the two FK paths reads zero.
   * Deleting then is worse than blanking: the denylist means no future
   * `library` row ever carries that `legacy_release_id`, so the resolver can
   * never link the play and its provenance is stranded permanently.
   */
  test('refuses with 409 when plays name the release only by its legacy release id', async () => {
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

    const res = await auth.delete(`/library/${album.id}`).expect(409);
    expect(res.body.reason).toBe('flowsheet_references');
    expect(res.body.play_count).toBe(1);
    expect(res.body.direct_play_count).toBe(0);
    expect(res.body.rotation_linked_play_count).toBe(0);
    expect(res.body.legacy_linked_play_count).toBe(1);

    // Refused means untouched: the release and the play both survive.
    const stillThere = await sql.unsafe(`SELECT id FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    expect(stillThere).toHaveLength(1);

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

    await auth.delete(`/library/${album.id}`).expect(204);

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

    await auth.delete(`/library/${album.id}`).expect(204);

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
});
