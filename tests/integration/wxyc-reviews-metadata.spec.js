/**
 * Integration test for the `album_review_submissions` serve contract —
 * consented WXYC DJ reviews (DJ Google-Form review archive, ADR 0011).
 *
 * The serve path resolves an album_id off the flowsheet lookup key once
 * (`resolveLinkedAlbumId`), then `lookupWxycReviewsByAlbumId`
 * (apps/backend/services/album-metadata-lookup.service.ts) issues:
 *
 *   SELECT review, artist_blurb, recommended_tracks, buzzwords,
 *          to_char(submitted_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')
 *     FROM album_review_submissions
 *    WHERE album_id = $1 AND social_consent = true AND review IS NOT NULL
 *    ORDER BY submitted_at DESC NULLS LAST, id DESC
 *    LIMIT 5
 *
 * The unit tests pin the Drizzle builder shape and the wire projection
 * against a mocked DB. This spec validates the parts only real PostgreSQL
 * can settle — and the first of them is a privacy property, not a shape one:
 *
 *   1. THE CONSENT GATE. `social_consent` is a nullable boolean: `true` only
 *      for an affirmative parsed answer, `false` for exactly "no", and NULL
 *      for blank or unrecognized text. Three-valued logic is exactly where a
 *      predicate like `IS NOT FALSE` would quietly publish the NULL cohort,
 *      and no mocked-DB test can prove it doesn't — SQL NULL semantics only
 *      exist in a real engine. This spec seeds all three consent states plus
 *      a bodyless row and asserts that exactly one row survives.
 *   2. THE PII BARRIER, end to end: `reviewer_raw` / `social_consent_raw` are
 *      populated on every seeded row, and must appear nowhere in the served
 *      projection.
 *   3. The ET date rendering, including the evening-submission case where the
 *      UTC instant has already rolled past midnight and a naive `::date` or
 *      `toISOString().slice(0,10)` would report the wrong day.
 *   4. Ordering (`submitted_at DESC NULLS LAST, id DESC`) and the LIMIT 5 cap.
 *      NULLS LAST is NOT PG's default for DESC.
 *   5. Album partitioning, and the `ON DELETE SET NULL` FK behavior that makes
 *      this table's teardown different from `album_critic_reviews`.
 *
 * Pure SQL — does NOT import the TS service. The integration runner is
 * babel-jest with no TS support (see `critic-reviews-metadata.spec.js` and
 * `album-metadata-upsert.spec.js` headers for the drizzle-orm + ts-jest
 * incompatibility). The SELECT below is hand-mirrored from the service; when
 * that query is edited the SQL here must follow.
 *
 * TEARDOWN NOTE — deliberately NOT the critic-reviews pattern.
 * `album_critic_reviews.album_id` is `ON DELETE CASCADE`, so that spec can
 * clean up by dropping the parent `library` row. `album_review_submissions
 * .album_id` is `ON DELETE SET NULL` (schema.ts): deleting the parent would
 * leave the seeded submissions behind as orphans with a nulled `album_id`,
 * still holding their `source_key` values and primed to collide with
 * `album_review_submissions_source_key_uq` on the next run. Every seeded row
 * is therefore deleted EXPLICITLY by `source_key`, before and independently
 * of any parent delete.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** Shared prefix for every `source_key` this spec writes, so teardown can
 * sweep them by pattern even if a test aborts midway. */
const SOURCE_KEY_PREFIX = 'wxyc-reviews-spec:';

/**
 * The exact serve query issued by `lookupWxycReviewsByAlbumId` for a
 * resolved album_id. Returns consented, non-empty reviews newest-first,
 * capped at 5.
 */
async function serveWxycReviews(sql, albumId) {
  return sql`
    SELECT review,
           artist_blurb,
           recommended_tracks,
           buzzwords,
           to_char(submitted_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS submitted_date
      FROM ${sql(SCHEMA)}.album_review_submissions
     WHERE album_id = ${albumId}
       AND social_consent = true
       AND review IS NOT NULL
     ORDER BY submitted_at DESC NULLS LAST, id DESC
     LIMIT 5
  `;
}

/**
 * Insert one submission row. Every row carries PII-internal values in
 * `reviewer_raw` / `social_consent_raw` so the barrier assertions are real
 * rather than vacuous. `socialConsent` may be true, false, or null —
 * the three states the ETL's closed vocabulary produces.
 */
async function insertSubmission(
  sql,
  albumId,
  {
    key,
    review = null,
    socialConsent = null,
    submittedAt = null,
    artistBlurb = null,
    recommendedTracks = null,
    buzzwords = null,
  }
) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.album_review_submissions
      (album_id, review, artist_blurb, recommended_tracks, buzzwords,
       social_consent, social_consent_raw, reviewer_raw, submitted_at, source, source_key)
    VALUES
      (${albumId}, ${review}, ${artistBlurb}, ${recommendedTracks}, ${buzzwords},
       ${socialConsent}, ${'consent answer verbatim, mentions Dana Ruiz'},
       ${'Dana Ruiz'}, ${submittedAt}, 'google_form', ${SOURCE_KEY_PREFIX + key})
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Insert a fresh library album to act as the FK target. Mirrors
 * `insertLibraryAlbum` in critic-reviews-metadata.spec.js: artist_id,
 * genre_id, format_id are NOT NULL on `library` and the seeded fixture in
 * dev_env/seed_db.sql guarantees ids 1 (artists), 11 (genres), 1 (format).
 */
async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'wxyc-reviews-test-album-' + suffix}, 9998, 'Built to Spill')
    RETURNING id
  `;
  return rows[0].id;
}

describe('album_review_submissions serve contract (real PG)', () => {
  let sql;
  /** library ids inserted; deleted in afterAll regardless of pass/fail. */
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    // Order matters: the submissions FK is ON DELETE SET NULL, so the child
    // rows must go FIRST and by source_key. Sweeping by prefix (rather than
    // by album_id) also collects any row whose album_id a prior failed run
    // already nulled.
    await sql`
      DELETE FROM ${sql(SCHEMA)}.album_review_submissions
       WHERE source_key LIKE ${SOURCE_KEY_PREFIX + '%'}
    `;
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  test('consent gate: only social_consent = true with a non-null body is served', async () => {
    const albumId = await insertLibraryAlbum(sql, 'consent');
    insertedAlbumIds.push(albumId);

    // (a) consented, with a body — the ONLY row that may be served.
    await insertSubmission(sql, albumId, {
      key: 'consent-a-yes',
      review: 'A consented review that may be published.',
      socialConsent: true,
      submittedAt: '2024-03-15T14:00:00-04:00',
    });
    // (b) explicitly declined.
    await insertSubmission(sql, albumId, {
      key: 'consent-b-no',
      review: 'The reviewer said no. This must never be served.',
      socialConsent: false,
      submittedAt: '2024-04-15T14:00:00-04:00',
    });
    // (c) blank / unrecognized consent answer -> NULL. The whole reason the
    // predicate is `= true` and not `IS NOT FALSE`: an ambiguous answer is
    // not consent.
    await insertSubmission(sql, albumId, {
      key: 'consent-c-null',
      review: 'Consent could not be parsed. This must never be served.',
      socialConsent: null,
      submittedAt: '2024-05-15T14:00:00-04:00',
    });
    // (d) consented but bodyless — nothing to render, and `review` is a
    // required field on the wire schema.
    await insertSubmission(sql, albumId, {
      key: 'consent-d-nobody',
      review: null,
      socialConsent: true,
      submittedAt: '2024-06-15T14:00:00-04:00',
    });

    const rows = await serveWxycReviews(sql, albumId);

    expect(rows).toHaveLength(1);
    expect(rows[0].review).toBe('A consented review that may be published.');

    // Belt and suspenders: none of the withheld bodies appear anywhere in the
    // served payload, whatever the row count.
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain('must never be served');
  });

  test('IS NOT FALSE would have leaked the NULL-consent row (the predicate is load-bearing)', async () => {
    // Pins WHY the predicate is `= true`. This is the query a well-meaning
    // refactor might write; against real three-valued logic it serves the
    // unparsed-consent row. If PG semantics ever changed such that these two
    // predicates agreed, this test would fail and the guard could be relaxed
    // deliberately rather than by accident.
    const albumId = await insertLibraryAlbum(sql, 'threevalued');
    insertedAlbumIds.push(albumId);

    await insertSubmission(sql, albumId, {
      key: 'tv-yes',
      review: 'consented',
      socialConsent: true,
      submittedAt: '2024-03-15T14:00:00-04:00',
    });
    await insertSubmission(sql, albumId, {
      key: 'tv-null',
      review: 'unparsed consent',
      socialConsent: null,
      submittedAt: '2024-03-16T14:00:00-04:00',
    });

    const strict = await serveWxycReviews(sql, albumId);
    const loose = await sql`
      SELECT review FROM ${sql(SCHEMA)}.album_review_submissions
       WHERE album_id = ${albumId} AND social_consent IS NOT FALSE AND review IS NOT NULL
    `;

    expect(strict.map((r) => r.review)).toEqual(['consented']);
    expect(loose).toHaveLength(2);
    expect(loose.map((r) => r.review).sort()).toEqual(['consented', 'unparsed consent']);
  });

  test('PII barrier: reviewer_raw / social_consent_raw never reach the served projection', async () => {
    const albumId = await insertLibraryAlbum(sql, 'pii');
    insertedAlbumIds.push(albumId);

    // The optional columns are populated here (the only row in this spec that
    // does): the key-set assertion below then proves the projection selects
    // exactly the five publish-safe columns while carrying REAL values, rather
    // than only ever being exercised against an all-null row.
    await insertSubmission(sql, albumId, {
      key: 'pii-1',
      review: 'A review whose author asked not to be named.',
      artistBlurb: 'Chapel Hill trio, three records deep.',
      recommendedTracks: 'Side A, track 2!!',
      buzzwords: 'jangly, wry, unhurried',
      socialConsent: true,
      submittedAt: '2024-03-15T14:00:00-04:00',
    });

    // The PII really is on the row...
    const raw = await sql`
      SELECT reviewer_raw, social_consent_raw
        FROM ${sql(SCHEMA)}.album_review_submissions
       WHERE source_key = ${SOURCE_KEY_PREFIX + 'pii-1'}
    `;
    expect(raw[0].reviewer_raw).toBe('Dana Ruiz');

    // ...and absent from what the serve path returns.
    const rows = await serveWxycReviews(sql, albumId);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'artist_blurb',
      'buzzwords',
      'recommended_tracks',
      'review',
      'submitted_date',
    ]);
    // The publish-safe columns really did round-trip...
    expect(rows[0].artist_blurb).toBe('Chapel Hill trio, three records deep.');
    expect(rows[0].recommended_tracks).toBe('Side A, track 2!!');
    expect(rows[0].buzzwords).toBe('jangly, wry, unhurried');
    // ...while the PII-internal values appear nowhere in the payload.
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain('Dana Ruiz');
    expect(payload).not.toContain('consent answer verbatim');
  });

  test('submittedDate renders the ET calendar date as YYYY-MM-DD, not a UTC timestamp', async () => {
    const albumId = await insertLibraryAlbum(sql, 'etdate');
    insertedAlbumIds.push(albumId);

    // 21:30 ET on 2024-03-15 is 01:30 UTC on 2024-03-16. A naive UTC render
    // would report the 16th — a day the reviewer never submitted on.
    await insertSubmission(sql, albumId, {
      key: 'etdate-evening',
      review: 'Submitted late in the evening, Eastern time.',
      socialConsent: true,
      submittedAt: '2024-03-15T21:30:00-04:00',
    });

    const rows = await serveWxycReviews(sql, albumId);

    expect(rows).toHaveLength(1);
    expect(rows[0].submitted_date).toBe('2024-03-15');
    // A date string, not a timestamp — no time component, no zone suffix.
    expect(rows[0].submitted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof rows[0].submitted_date).toBe('string');
  });

  test('orders submitted_at DESC with NULLS LAST and an id-descending tiebreak', async () => {
    const albumId = await insertLibraryAlbum(sql, 'ordering');
    insertedAlbumIds.push(albumId);

    // Insert order a,b,c,d fixes the id sequence. 'a' and 'd' share an instant
    // to force the id-DESC tiebreak; 'c' is undated to exercise NULLS LAST.
    await insertSubmission(sql, albumId, {
      key: 'order-a',
      review: 'a',
      socialConsent: true,
      submittedAt: '2024-05-01T12:00:00-04:00',
    });
    await insertSubmission(sql, albumId, {
      key: 'order-b',
      review: 'b',
      socialConsent: true,
      submittedAt: '2023-01-01T12:00:00-05:00',
    });
    await insertSubmission(sql, albumId, {
      key: 'order-c',
      review: 'c',
      socialConsent: true,
      submittedAt: null,
    });
    await insertSubmission(sql, albumId, {
      key: 'order-d',
      review: 'd',
      socialConsent: true,
      submittedAt: '2024-05-01T12:00:00-04:00',
    });

    const rows = await serveWxycReviews(sql, albumId);

    expect(rows.map((r) => r.review)).toEqual(['d', 'a', 'b', 'c']);
  });

  test('caps the result set at WXYC_REVIEWS_LIMIT (5), dropping the oldest overflow', async () => {
    const albumId = await insertLibraryAlbum(sql, 'limit');
    insertedAlbumIds.push(albumId);

    const years = [2020, 2021, 2022, 2023, 2024, 2025];
    for (const year of years) {
      await insertSubmission(sql, albumId, {
        key: `limit-${year}`,
        review: `review-${year}`,
        socialConsent: true,
        submittedAt: `${year}-06-01T12:00:00-04:00`,
      });
    }

    const rows = await serveWxycReviews(sql, albumId);

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.review)).toEqual([
      'review-2025',
      'review-2024',
      'review-2023',
      'review-2022',
      'review-2021',
    ]);
  });

  test('partitions by album_id: a query never surfaces another album’s reviews', async () => {
    const albumA = await insertLibraryAlbum(sql, 'fk-a');
    const albumB = await insertLibraryAlbum(sql, 'fk-b');
    insertedAlbumIds.push(albumA, albumB);

    await insertSubmission(sql, albumA, {
      key: 'fk-a-only',
      review: 'belongs to A',
      socialConsent: true,
      submittedAt: '2024-02-02T12:00:00-05:00',
    });
    await insertSubmission(sql, albumB, {
      key: 'fk-b-only',
      review: 'belongs to B',
      socialConsent: true,
      submittedAt: '2024-03-03T12:00:00-05:00',
    });

    expect((await serveWxycReviews(sql, albumA)).map((r) => r.review)).toEqual(['belongs to A']);
    expect((await serveWxycReviews(sql, albumB)).map((r) => r.review)).toEqual(['belongs to B']);
  });

  test('optional columns come back null so the projector can omit them', async () => {
    const albumId = await insertLibraryAlbum(sql, 'optionals');
    insertedAlbumIds.push(albumId);

    await insertSubmission(sql, albumId, {
      key: 'optionals-sparse',
      review: 'Body only.',
      socialConsent: true,
      submittedAt: null,
    });

    const rows = await serveWxycReviews(sql, albumId);

    expect(rows).toHaveLength(1);
    expect(rows[0].review).toBe('Body only.');
    expect(rows[0].artist_blurb).toBeNull();
    expect(rows[0].recommended_tracks).toBeNull();
    expect(rows[0].buzzwords).toBeNull();
    expect(rows[0].submitted_date).toBeNull();
  });

  test('ON DELETE SET NULL: dropping the library album orphans rather than removes the submission', async () => {
    // This is the behavior that makes the teardown above necessary, and it is
    // asserted rather than assumed: if the FK were ever tightened to CASCADE,
    // this test fails and the teardown comment can be revisited.
    const albumId = await insertLibraryAlbum(sql, 'setnull');

    await insertSubmission(sql, albumId, {
      key: 'setnull-1',
      review: 'survives its parent',
      socialConsent: true,
      submittedAt: '2024-05-05T12:00:00-04:00',
    });

    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ${albumId}`;

    // The submission row still exists, with a nulled album_id.
    const after = await sql`
      SELECT album_id, review
        FROM ${sql(SCHEMA)}.album_review_submissions
       WHERE source_key = ${SOURCE_KEY_PREFIX + 'setnull-1'}
    `;
    expect(after).toHaveLength(1);
    expect(after[0].album_id).toBeNull();

    // And it is unreachable from the serve path, which requires a linked album.
    expect(await serveWxycReviews(sql, albumId)).toHaveLength(0);
  });
});
