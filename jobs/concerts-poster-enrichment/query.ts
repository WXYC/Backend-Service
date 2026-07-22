/**
 * Candidate query for jobs/concerts-poster-enrichment (BS#1743).
 *
 * Selects upcoming, non-removed concert rows that have NO poster image yet
 * (`image_url IS NULL`) but DO have a resolvable headliner Discogs id — the
 * same effective-id expression the genre sibling
 * (`jobs/concerts-genre-enrichment/query.ts`) and `GET /concerts` both key
 * on: `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)`.
 *
 * Unlike the genre sibling, this candidate set is CONCERT rows, not
 * deduped artists — `concert_id` is carried through so the writer can target
 * every concert row a shared headliner is billed on, even though the
 * orchestrator dedupes the Discogs id before calling LML (one artist-details
 * lookup serves every concert that artist headlines).
 *
 * Idempotency + data-safety: `image_url IS NULL` is both the candidate
 * filter AND (mirrored in the writer's UPDATE ... WHERE) the write guard, so
 * a re-run never re-selects an already-enriched or already-scraped-with-a-
 * poster row, and can never clobber one.
 *
 * Window: the nightly run is upcoming-only (`starts_on >= today` in the
 * venue-local Eastern date the read path windows on — never server-clock
 * `CURRENT_DATE`; mirrors the resolver + genre-enrichment windows). The
 * `--backfill` mode drops the window to front-fill every existing resolved,
 * unenriched headliner regardless of date.
 *
 * Schema-qualified refs honour `WXYC_SCHEMA_NAME` (parallel Jest workers
 * override it so each worker targets its own schema). Mirrors
 * `jobs/concerts-genre-enrichment/query.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/** One concert row still missing a poster image, with its resolvable headliner Discogs id. */
export type EnrichmentCandidate = { concert_id: number; discogs_artist_id: number };

/**
 * Normalize `db.execute(sql\`...\`)` results across drizzle-orm driver shapes.
 * postgres-js returns an array; node-postgres returns `{ rows }`. Anything else
 * means the driver contract changed under us — fail LOUD rather than degrade
 * into a healthy-looking zero-work no-op. Mirrors
 * `jobs/concerts-genre-enrichment/query.ts`.
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
  throw new Error(`concerts-poster-enrichment: unrecognized db.execute() result shape: ${describeShape(result)}`);
};

/**
 * Load the enrichment candidate set.
 *
 * @param backfill - when true, drop the upcoming-only `starts_on` window so the
 *   one-time deploy backfill covers every existing resolved, unenriched headliner.
 */
export const loadEnrichmentCandidates = async (backfill = false): Promise<EnrichmentCandidate[]> => {
  // Interpolated as a whole `sql` fragment, not a bind param — it's DDL-shaped
  // (a WHERE conjunct), and both branches are compile-time constants we control.
  const windowClause = backfill ? sql`` : sql`AND "c"."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;

  const result: unknown = await db.execute(sql`
    SELECT
      "c"."id" AS concert_id,
      COALESCE("c"."headlining_discogs_artist_id", "a"."discogs_artist_id") AS discogs_artist_id
    FROM ${CONCERTS_TABLE} "c"
    LEFT JOIN ${ARTISTS_TABLE} "a" ON "a"."id" = "c"."headlining_artist_id"
    WHERE "c"."removed_at" IS NULL
      AND "c"."image_url" IS NULL
      ${windowClause}
      AND COALESCE("c"."headlining_discogs_artist_id", "a"."discogs_artist_id") IS NOT NULL
    ORDER BY "c"."id" ASC
  `);
  return unwrapRows<EnrichmentCandidate>(result);
};
