/**
 * Integration test for the `album_critic_reviews` serve contract
 * (album-critic-reviews slice, ADR 0012).
 *
 * `lookupCriticReviewsByAlbumKey` (apps/backend/services/album-metadata-lookup.service.ts)
 * resolves an album_id off the flowsheet lookup key, then issues:
 *
 *   SELECT source, source_url, snippet, author, published_at, rating
 *     FROM album_critic_reviews
 *    WHERE album_id = $1
 *    ORDER BY published_at DESC NULLS LAST, id DESC
 *    LIMIT 5
 *
 * The unit tests cover the Drizzle builder shape + the wire projection
 * (url<-source_url, publishedDate<-published_at, optional-field omission)
 * against a mocked DB. This spec validates the parts only real PostgreSQL
 * can settle:
 *
 *   1. Ordering: `published_at DESC NULLS LAST, id DESC` — dated rows newest
 *      first, NULL-dated rows last, id-descending tiebreak within a published
 *      date. (NULLS LAST is NOT PG's default for DESC — default is NULLS
 *      FIRST — so an unqualified ORDER BY would surface undated rows on top.)
 *   2. The `LIMIT 5` cap (CRITIC_REVIEWS_LIMIT) drops the oldest overflow.
 *   3. FK keying: reviews are partitioned by album_id; a query for album A
 *      never surfaces album B's rows.
 *   4. `(album_id, source_url)` UNIQUE index is a working UPSERT conflict
 *      target — re-ingesting the same (album, url) overwrites in place rather
 *      than duplicating; a different url under the same album coexists.
 *   5. ON DELETE CASCADE: dropping the `library` album evaporates its reviews
 *      (the seed/ETL never has to clean the child table by hand).
 *
 * Pure SQL — does NOT import the TS service. The integration runner is
 * babel-jest with no TS support (see `album-metadata-upsert.spec.js` and
 * `library-identity-backfill.spec.js` headers for the drizzle-orm + ts-jest
 * incompatibility). The SELECT below is hand-mirrored from the service; when
 * that query is edited the SQL here must follow. Ordering is asserted on
 * `source_url` (a plain varchar identity marker) rather than `published_at`
 * so the assertion is independent of how postgres-js parses the `date` type.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * The exact serve query issued by `lookupCriticReviewsByAlbumKey` after it
 * resolves an album_id. Returns rows newest-first, capped at 5.
 */
async function serveReviews(sql, albumId) {
  return sql`
    SELECT source, source_url, snippet, author, published_at, rating
      FROM ${sql(SCHEMA)}.album_critic_reviews
     WHERE album_id = ${albumId}
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT 5
  `;
}

/**
 * Insert one review row. `publishedAt` may be an ISO date string or null.
 * Returns the new id so callers can reason about the id-descending tiebreak.
 */
async function insertReview(
  sql,
  albumId,
  { source, sourceUrl, snippet, author = null, publishedAt = null, rating = null }
) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.album_critic_reviews
      (album_id, source, source_url, snippet, author, published_at, rating)
    VALUES
      (${albumId}, ${source}, ${sourceUrl}, ${snippet}, ${author}, ${publishedAt}, ${rating})
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * UPSERT a review keyed on the `(album_id, source_url)` unique index — the
 * conflict target the seed script + any re-ingest use. Overwrites the mutable
 * columns on conflict, mirroring an idempotent nightly seed.
 */
async function upsertReview(
  sql,
  albumId,
  { source, sourceUrl, snippet, author = null, publishedAt = null, rating = null }
) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_critic_reviews
      (album_id, source, source_url, snippet, author, published_at, rating)
    VALUES
      (${albumId}, ${source}, ${sourceUrl}, ${snippet}, ${author}, ${publishedAt}, ${rating})
    ON CONFLICT (album_id, source_url) DO UPDATE
       SET source        = EXCLUDED.source,
           snippet       = EXCLUDED.snippet,
           author        = EXCLUDED.author,
           published_at  = EXCLUDED.published_at,
           rating        = EXCLUDED.rating,
           last_modified = now()
  `;
}

/**
 * Insert a fresh library album to act as the FK target. Returns the new id.
 * Mirrors `insertLibraryAlbum` in album-metadata-upsert.spec.js: artist_id,
 * genre_id, format_id are NOT NULL on `library` and the seeded fixture in
 * dev_env/seed_db.sql guarantees ids 1 (artists), 11 (genres), 1 (format).
 */
async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'critic-reviews-test-album-' + suffix}, 9999, 'Built to Spill')
    RETURNING id
  `;
  return rows[0].id;
}

describe('album_critic_reviews serve contract (real PG)', () => {
  let sql;
  /** album_ids inserted; deleted in afterAll regardless of pass/fail. */
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      // The FK cascades on delete, so dropping the library rows is sufficient.
      // Belt + suspenders: target the child table explicitly first in case the
      // FK is ever loosened.
      await sql`DELETE FROM ${sql(SCHEMA)}.album_critic_reviews WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  test('orders published_at DESC with NULLS LAST and an id-descending tiebreak', async () => {
    const albumId = await insertLibraryAlbum(sql, 'ordering');
    insertedAlbumIds.push(albumId);

    // Insertion order a,b,c,d fixes the id sequence (id_a < id_b < id_c < id_d).
    // 'a' and 'd' share published_at '2024-05-01' to force the id-DESC tiebreak;
    // 'c' is undated to exercise NULLS LAST.
    await insertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-order/a',
      snippet: 'first-dated',
      publishedAt: '2024-05-01',
    });
    await insertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-order/b',
      snippet: 'older',
      publishedAt: '2023-01-01',
    });
    await insertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-order/c',
      snippet: 'undated',
      publishedAt: null,
    });
    await insertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-order/d',
      snippet: 'tie-newer-id',
      publishedAt: '2024-05-01',
    });

    const rows = await serveReviews(sql, albumId);

    // d and a tie on 2024-05-01 -> id DESC -> d (later insert) first, then a;
    // then b (2023); then c (NULL) last.
    expect(rows.map((r) => r.source_url)).toEqual([
      'https://example.com/critic-order/d',
      'https://example.com/critic-order/a',
      'https://example.com/critic-order/b',
      'https://example.com/critic-order/c',
    ]);
  });

  test('caps the result set at CRITIC_REVIEWS_LIMIT (5), dropping the oldest overflow', async () => {
    const albumId = await insertLibraryAlbum(sql, 'limit');
    insertedAlbumIds.push(albumId);

    // Six dated rows, ascending dates 2020..2025. Newest 5 (2021..2025) survive
    // the LIMIT; the 2020 row is the drop.
    const years = [2020, 2021, 2022, 2023, 2024, 2025];
    for (const year of years) {
      await insertReview(sql, albumId, {
        source: 'The Wire',
        sourceUrl: `https://example.com/critic-limit/${year}`,
        snippet: `review-${year}`,
        publishedAt: `${year}-06-01`,
      });
    }

    const rows = await serveReviews(sql, albumId);

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.source_url)).toEqual([
      'https://example.com/critic-limit/2025',
      'https://example.com/critic-limit/2024',
      'https://example.com/critic-limit/2023',
      'https://example.com/critic-limit/2022',
      'https://example.com/critic-limit/2021',
    ]);
  });

  test('partitions by album_id: a query never surfaces another album’s reviews', async () => {
    const albumA = await insertLibraryAlbum(sql, 'fk-a');
    const albumB = await insertLibraryAlbum(sql, 'fk-b');
    insertedAlbumIds.push(albumA, albumB);

    await insertReview(sql, albumA, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-fk/a-only',
      snippet: 'belongs to A',
      publishedAt: '2024-02-02',
    });
    await insertReview(sql, albumB, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-fk/b-only',
      snippet: 'belongs to B',
      publishedAt: '2024-03-03',
    });

    const rowsA = await serveReviews(sql, albumA);
    const rowsB = await serveReviews(sql, albumB);

    expect(rowsA.map((r) => r.source_url)).toEqual(['https://example.com/critic-fk/a-only']);
    expect(rowsB.map((r) => r.source_url)).toEqual(['https://example.com/critic-fk/b-only']);
  });

  test('(album_id, source_url) UNIQUE index is an idempotent UPSERT conflict target', async () => {
    const albumId = await insertLibraryAlbum(sql, 'upsert');
    insertedAlbumIds.push(albumId);

    const url = 'https://example.com/critic-upsert/same';

    // First ingest.
    await upsertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: url,
      snippet: 'original snippet',
      publishedAt: '2024-01-01',
      rating: '7.8',
    });
    // Re-ingest the same (album, url) with revised content.
    await upsertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: url,
      snippet: 'revised snippet',
      publishedAt: '2024-01-01',
      rating: '8.1',
    });
    // A different url under the same album is a distinct row, not a conflict.
    await upsertReview(sql, albumId, {
      source: 'The Wire',
      sourceUrl: 'https://example.com/critic-upsert/other',
      snippet: 'second source',
      publishedAt: '2024-04-04',
    });

    const all = await sql`
      SELECT source_url, snippet, rating
        FROM ${sql(SCHEMA)}.album_critic_reviews
       WHERE album_id = ${albumId}
       ORDER BY source_url
    `;

    expect(all).toHaveLength(2);
    const same = all.find((r) => r.source_url === url);
    expect(same.snippet).toBe('revised snippet');
    expect(same.rating).toBe('8.1');
    expect(all.find((r) => r.source_url === 'https://example.com/critic-upsert/other').snippet).toBe('second source');
  });

  test('ON DELETE CASCADE: dropping the library album evaporates its reviews', async () => {
    const albumId = await insertLibraryAlbum(sql, 'cascade');

    await insertReview(sql, albumId, {
      source: 'Pitchfork',
      sourceUrl: 'https://example.com/critic-cascade/1',
      snippet: 'will be cascaded away',
      publishedAt: '2024-05-05',
    });
    await insertReview(sql, albumId, {
      source: 'The Wire',
      sourceUrl: 'https://example.com/critic-cascade/2',
      snippet: 'also cascaded',
      publishedAt: null,
    });

    const before = await sql`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.album_critic_reviews WHERE album_id = ${albumId}
    `;
    expect(before[0].n).toBe(2);

    // Deleting the parent library row must cascade to album_critic_reviews.
    // (This album_id is intentionally NOT pushed to insertedAlbumIds — it is
    // consumed here — so afterAll won't double-delete a vanished row.)
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ${albumId}`;

    const after = await sql`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.album_critic_reviews WHERE album_id = ${albumId}
    `;
    expect(after[0].n).toBe(0);
  });
});
