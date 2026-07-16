import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { album_review_submissions, db, normalizeArtistName } from '@wxyc/database';

/**
 * Album-review archive read service — backs `GET /album-reviews`
 * (album-reviews-sheet-sync plan / ADR 0011). Pure DB reads over the
 * `album_review_submissions` table that `jobs/album-reviews-etl/`
 * populates nightly from the "Album Review Responses" Google Form; no
 * LML calls, no writes.
 *
 * PII rule: `reviewer_raw` holds real names (the form promised "your
 * name will not be shared") and `social_consent_raw` carries
 * name-adjacent asides. Both are stored for internal curation and are
 * NEVER emitted here — see the projection note below.
 */

/**
 * Wire shape mirroring `AlbumReview` in `wxyc-shared/api.yaml` (the
 * cross-repo SSOT; contract added by wxyc-shared#230). Local alias pending
 * a published `@wxyc/shared` that carries it — once the dependency pin in
 * `apps/backend/package.json` reaches that version, this should be
 * replaced with `import type { AlbumReview } from '@wxyc/shared/dtos'`.
 * Same sequencing as the concerts `ConcertDTO` alias.
 */
export type AlbumReviewDTO = {
  id: number;
  album_id: number | null;
  artist_name: string | null;
  album_title: string | null;
  record_label: string | null;
  artist_blurb: string | null;
  review: string | null;
  recommended_tracks: string | null;
  buzzwords: string | null;
  fcc_violations: string | null;
  review_purpose: string | null;
  rotated: boolean | null;
  released_within_six_months: boolean | null;
  social_consent: boolean | null;
  // ISO-8601 date-time string (or null), matching the SSOT `AlbumReview`
  // type (format: date-time). The Drizzle row surfaces the column as
  // `Date`; `toAlbumReviewDTO` serializes it so the local alias aligns
  // with the generated `@wxyc/shared` shape (see the alias note above).
  submitted_at: string | null;
};

export type AlbumReviewsQueryFilters = {
  /** Exact match on the best-effort library link. */
  album_id?: number;
  /** Raw artist-name filter; matched as `norm_artist = normalizeArtistName(artist)`. */
  artist?: string;
};

/**
 * Flat row produced by the explicit select below. Exported for the
 * `toAlbumReviewDTO` unit tests.
 */
export type AlbumReviewRow = {
  id: number;
  album_id: number | null;
  artist_name: string | null;
  album_title: string | null;
  record_label: string | null;
  artist_blurb: string | null;
  review: string | null;
  recommended_tracks: string | null;
  buzzwords: string | null;
  fcc_violations: string | null;
  review_purpose: string | null;
  rotated: boolean | null;
  released_within_six_months: boolean | null;
  social_consent: boolean | null;
  submitted_at: Date | null;
};

// Explicit select list — THE PROJECTION IS THE PII LEAK BARRIER (the
// concerts.service precedent): `reviewer_raw` and `social_consent_raw`
// are never selected, so reviewer identity cannot reach the response no
// matter what the DTO mapper does. The internal ETL bookkeeping columns
// (source, source_key, norm_artist, norm_album, add_date, last_modified)
// are excluded for the same reason. Do NOT replace this with a bare
// `select()` — a full-row select would silently re-open the leak.
const albumReviewFields = {
  id: album_review_submissions.id,
  album_id: album_review_submissions.album_id,
  artist_name: album_review_submissions.artist_name,
  album_title: album_review_submissions.album_title,
  record_label: album_review_submissions.record_label,
  artist_blurb: album_review_submissions.artist_blurb,
  review: album_review_submissions.review,
  recommended_tracks: album_review_submissions.recommended_tracks,
  buzzwords: album_review_submissions.buzzwords,
  fcc_violations: album_review_submissions.fcc_violations,
  review_purpose: album_review_submissions.review_purpose,
  rotated: album_review_submissions.rotated,
  released_within_six_months: album_review_submissions.released_within_six_months,
  social_consent: album_review_submissions.social_consent,
  submitted_at: album_review_submissions.submitted_at,
};

/** Maps a projected row to the `AlbumReview` wire shape. Explicit field
 *  list (never a spread) so a wider row cannot smuggle extra keys onto
 *  the wire — the second layer behind the projection barrier above. */
export const toAlbumReviewDTO = (row: AlbumReviewRow): AlbumReviewDTO => ({
  id: row.id,
  album_id: row.album_id,
  artist_name: row.artist_name,
  album_title: row.album_title,
  record_label: row.record_label,
  artist_blurb: row.artist_blurb,
  review: row.review,
  recommended_tracks: row.recommended_tracks,
  buzzwords: row.buzzwords,
  fcc_violations: row.fcc_violations,
  review_purpose: row.review_purpose,
  rotated: row.rotated,
  released_within_six_months: row.released_within_six_months,
  social_consent: row.social_consent,
  // Drizzle surfaces the `timestamptz` column as `Date`; the SSOT wire
  // type is an ISO-8601 date-time string (see the DTO note above).
  submitted_at: row.submitted_at === null ? null : row.submitted_at.toISOString(),
});

/**
 * Shared WHERE builder so the page and count queries can never drift.
 *
 * `album_id` is an exact match on the link column; `artist` normalizes
 * TS-side via `normalizeArtistName` (lowercase, leading-"The"-strip — the
 * migration-0092 SSOT) and compares against the persisted `norm_artist`,
 * so the filter is an equality that reads
 * `album_review_submissions_norm_artist_idx`. Returns `undefined` (no
 * WHERE clause) when no filters are set.
 */
const buildWhere = ({ album_id, artist }: AlbumReviewsQueryFilters): SQL | undefined => {
  const conditions: SQL[] = [];
  if (album_id !== undefined) {
    conditions.push(eq(album_review_submissions.album_id, album_id));
  }
  if (artist !== undefined) {
    conditions.push(eq(album_review_submissions.norm_artist, normalizeArtistName(artist)));
  }
  return conditions.length === 0 ? undefined : and(...conditions);
};

/**
 * One page of submissions, newest first: `submitted_at DESC NULLS LAST`
 * (the rare timestamp-less row sorts to the end, not the top — plain
 * DESC would put NULLs first in Postgres) with `id DESC` as a stable
 * tiebreak.
 */
export const getAlbumReviewsPage = async (
  filters: AlbumReviewsQueryFilters,
  limit: number,
  offset: number
): Promise<AlbumReviewDTO[]> => {
  const rows = await db
    .select(albumReviewFields)
    .from(album_review_submissions)
    .where(buildWhere(filters))
    .orderBy(sql`${album_review_submissions.submitted_at} DESC NULLS LAST`, desc(album_review_submissions.id))
    .limit(limit)
    .offset(offset);

  return (rows as AlbumReviewRow[]).map(toAlbumReviewDTO);
};

/** Total row count for the same filters, for `PaginationInfo`. */
export const getAlbumReviewsCount = async (filters: AlbumReviewsQueryFilters): Promise<number> => {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(album_review_submissions)
    .where(buildWhere(filters));

  return Number(result[0]?.count ?? 0);
};
