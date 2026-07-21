/**
 * Candidate query for jobs/concerts-genre-enrichment (BS#1624).
 *
 * Selects RESOLVED concert headliners that lack a persisted genre row — one
 * per distinct Discogs artist id. "Resolved" spans both concert resolution
 * lanes:
 *   - the offline LML pass (BS#1614) writes `concerts.headlining_discogs_artist_id`
 *     directly;
 *   - the strict/alias resolver (BS#1372) writes `concerts.headlining_artist_id`
 *     (a library FK), which reaches a Discogs id through `artists.discogs_artist_id`.
 * The effective id is `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)`
 * — the exact expression the `GET /concerts` projection keys `artist_metadata`
 * on (`apps/backend/services/concerts.service.ts`), so enrichment and read
 * resolve genres through the same key.
 *
 * Idempotency + data-safety: the anti-join `artist_metadata am ... WHERE
 * am.discogs_artist_id IS NULL` selects ONLY artists with no row yet, so a
 * re-run (or the one-time backfill re-run) picks up nothing already enriched
 * and never rewrites a collected row. `DISTINCT ON (discogs_artist_id)`
 * collapses an artist playing multiple venues to one LML call.
 *
 * Window: the nightly run is upcoming-only (`starts_on >= today` in the
 * venue-local Eastern date the read path windows on — never server-clock
 * `CURRENT_DATE`; mirrors the resolver's candidate window), so genre budget is
 * never spent on past shows the feed won't serve. The one-time deploy backfill
 * (`--backfill`) drops the window to front-fill every existing resolved
 * headliner regardless of date.
 *
 * Schema-qualified refs honour `WXYC_SCHEMA_NAME` (parallel Jest workers
 * override it so each worker targets its own schema). Mirrors
 * `jobs/concerts-artist-lml-resolver/targets.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const ARTIST_METADATA_TABLE = sql.raw(`"${SCHEMA}"."artist_metadata"`);

/** One artist still needing genre enrichment. */
export type EnrichmentCandidate = { discogs_artist_id: number; artist_name: string };

/**
 * Normalize `db.execute(sql\`...\`)` results across drizzle-orm driver shapes.
 * postgres-js returns an array; node-postgres returns `{ rows }`. Anything else
 * means the driver contract changed under us — fail LOUD rather than degrade
 * into a healthy-looking zero-work no-op. Mirrors
 * `jobs/concerts-artist-lml-resolver/targets.ts`.
 */
const describeShape = (result: unknown): string => {
  if (result === null) return 'null';
  if (result === undefined) return 'undefined';
  if (typeof result !== 'object') return typeof result;
  return `object{${Object.keys(result).join(',')}}`;
};

const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`concerts-genre-enrichment: unrecognized db.execute() result shape: ${describeShape(result)}`);
};

/**
 * Load the enrichment candidate set.
 *
 * @param backfill - when true, drop the upcoming-only `starts_on` window so the
 *   one-time deploy backfill covers every existing resolved headliner.
 */
export const loadEnrichmentCandidates = async (backfill = false): Promise<EnrichmentCandidate[]> => {
  // Interpolated as a whole `sql` fragment, not a bind param — it's DDL-shaped
  // (a WHERE conjunct), and both branches are compile-time constants we control.
  const windowClause = backfill ? sql`` : sql`AND "c"."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;

  const result: unknown = await db.execute(sql`
    SELECT DISTINCT ON (eff."discogs_artist_id")
      eff."discogs_artist_id" AS discogs_artist_id,
      eff."artist_name" AS artist_name
    FROM (
      SELECT
        COALESCE("c"."headlining_discogs_artist_id", "a"."discogs_artist_id") AS discogs_artist_id,
        COALESCE("a"."artist_name", "c"."headlining_artist_raw") AS artist_name
      FROM ${CONCERTS_TABLE} "c"
      LEFT JOIN ${ARTISTS_TABLE} "a" ON "a"."id" = "c"."headlining_artist_id"
      WHERE "c"."removed_at" IS NULL
        ${windowClause}
        AND COALESCE("c"."headlining_discogs_artist_id", "a"."discogs_artist_id") IS NOT NULL
    ) eff
    LEFT JOIN ${ARTIST_METADATA_TABLE} "am" ON "am"."discogs_artist_id" = eff."discogs_artist_id"
    WHERE "am"."discogs_artist_id" IS NULL
    ORDER BY eff."discogs_artist_id" ASC
  `);
  return unwrapRows<EnrichmentCandidate>(result);
};

/**
 * Bio-backfill candidates (BS#1734): existing `artist_metadata` rows the
 * nightly genres enrichment (BS#1624) created BEFORE the `artist_bio` column
 * shipped, so `artist_bio IS NULL` on a row that already has genres/styles.
 * The anti-join in `loadEnrichmentCandidates` above never revisits these rows
 * — it only selects artists with NO row at all — so this is the one-time
 * pass that fills them (`jobs/concerts-genre-enrichment/bio-backfill.ts`).
 *
 * Name resolution mirrors the candidate query's `eff` subquery: a library
 * artist's canonical `artists.artist_name`, or the raw headliner billing off
 * any concert row that resolved to this Discogs id (the `artist_metadata` row
 * only exists because some concert resolved to it, at either lane).
 */
export const loadBioBackfillCandidates = async (): Promise<EnrichmentCandidate[]> => {
  const result: unknown = await db.execute(sql`
    SELECT DISTINCT ON (am."discogs_artist_id")
      am."discogs_artist_id" AS discogs_artist_id,
      COALESCE("a"."artist_name", "c"."headlining_artist_raw") AS artist_name
    FROM ${ARTIST_METADATA_TABLE} am
    LEFT JOIN ${ARTISTS_TABLE} "a" ON "a"."discogs_artist_id" = am."discogs_artist_id"
    LEFT JOIN ${CONCERTS_TABLE} "c" ON "c"."headlining_discogs_artist_id" = am."discogs_artist_id"
      OR "c"."headlining_artist_id" = "a"."id"
    WHERE am."artist_bio" IS NULL
      AND COALESCE("a"."artist_name", "c"."headlining_artist_raw") IS NOT NULL
    ORDER BY am."discogs_artist_id" ASC
  `);
  return unwrapRows<EnrichmentCandidate>(result);
};
