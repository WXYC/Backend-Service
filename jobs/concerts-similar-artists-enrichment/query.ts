/**
 * Candidate query for jobs/concerts-similar-artists-enrichment (BS#1626).
 *
 * Selects the distinct IN-LIBRARY resolved headliners of upcoming curated
 * concerts — one per `artists.id`. The cohort is deliberately NARROWER than the
 * genre sibling's (BS#1624): genres key on
 * `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)`, which
 * also covers BS#1614's LML-minted headliners that carry a Discogs id but have
 * no `artists` row (touring artists absent from the WXYC library). Similar
 * artists CANNOT cover those — the affinity graph is built from the WXYC
 * library, so a headliner with no `artists.id` has no `library_artist_id` to
 * send at all. Hence the filter is `headlining_artist_id IS NOT NULL`.
 *
 * NO presence anti-join (unlike genres). The refresh policy is a full-window
 * nightly re-fetch + OVERWRITE: affinity neighbors are recomputed on every
 * semantic-index graph rebuild, so freezing each headliner's list to whatever
 * the graph looked like the night it was first enriched (the anti-join's
 * behavior) would defeat the point. The window is tiny (~50 concerts), so the
 * whole upcoming curated in-library cohort is re-fetched every run.
 *
 * Window: the nightly run is upcoming-only (`starts_on >= today` in the
 * venue-local Eastern date the read path windows on — never server-clock
 * `CURRENT_DATE`; mirrors the resolver + genre-enrichment windows). The
 * `--backfill` mode drops the window to front-fill every existing resolved
 * in-library headliner regardless of date.
 *
 * Schema-qualified refs honour `WXYC_SCHEMA_NAME` (parallel Jest workers
 * override it so each worker targets its own schema). Mirrors
 * `jobs/concerts-genre-enrichment/query.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);

/** One in-library headliner still in the upcoming curated window. */
export type EnrichmentCandidate = { artist_id: number };

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
  throw new Error(
    `concerts-similar-artists-enrichment: unrecognized db.execute() result shape: ${describeShape(result)}`
  );
};

/**
 * Load the enrichment candidate set: distinct `artists.id` of in-library
 * headliners of non-removed upcoming curated concerts.
 *
 * @param backfill - when true, drop the upcoming-only `starts_on` window so the
 *   one-time deploy backfill covers every existing resolved in-library headliner.
 */
export const loadEnrichmentCandidates = async (backfill = false): Promise<EnrichmentCandidate[]> => {
  // Interpolated as a whole `sql` fragment, not a bind param — it's DDL-shaped
  // (a WHERE conjunct), and both branches are compile-time constants we control.
  const windowClause = backfill ? sql`` : sql`AND "c"."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;

  const result: unknown = await db.execute(sql`
    SELECT DISTINCT "c"."headlining_artist_id" AS artist_id
    FROM ${CONCERTS_TABLE} "c"
    WHERE "c"."removed_at" IS NULL
      AND "c"."headlining_artist_id" IS NOT NULL
      ${windowClause}
    ORDER BY "c"."headlining_artist_id" ASC
  `);
  return unwrapRows<EnrichmentCandidate>(result);
};
