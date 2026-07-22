/**
 * Candidate query for the DISCOGS lane of
 * jobs/concerts-similar-artists-enrichment (BS#1701).
 *
 * Selects the distinct DISCOGS-ONLY resolved headliners of upcoming curated
 * concerts — one per `headlining_discogs_artist_id`. This is the complement of
 * the library lane's cohort (`query.ts`, `headlining_artist_id IS NOT NULL`):
 * here the headliner resolved ONLY to a Discogs id (BS#1614's LML-minted
 * touring artists, absent from the WXYC library, so no `artists.id`). The two
 * cohorts PARTITION the resolved-headliner space (`headlining_artist_id IS NOT
 * NULL` vs `IS NULL AND headlining_discogs_artist_id IS NOT NULL`), so no
 * headliner is ever written to both `artist_similar_artists` and
 * `discogs_artist_similar_artists`.
 *
 * Bare `headlining_discogs_artist_id`, NOT the read path's
 * `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)`: the
 * `headlining_artist_id IS NULL` filter guarantees there is no `artists` row to
 * reach `artists.discogs_artist_id` through, so the COALESCE second arm is
 * always NULL for this cohort — the bare column IS the effective id here.
 *
 * NO presence anti-join (same as the library lane): the refresh policy is a
 * full-window nightly re-fetch + OVERWRITE, because affinity neighbors are
 * recomputed on every semantic-index graph rebuild.
 *
 * Window: upcoming-only (`starts_on >= today` in the venue-local Eastern date
 * the read path windows on — never server-clock `CURRENT_DATE`). `--backfill`
 * drops the window to front-fill every existing Discogs-only headliner.
 *
 * Schema-qualified refs honour `WXYC_SCHEMA_NAME`. Mirrors `query.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);

/** One Discogs-only headliner still in the upcoming curated window. */
export type DiscogsEnrichmentCandidate = { discogs_artist_id: number };

/**
 * Normalize `db.execute(sql\`...\`)` results across drizzle-orm driver shapes.
 * postgres-js returns an array; node-postgres returns `{ rows }`. Anything else
 * means the driver contract changed under us — fail LOUD. Mirrors `query.ts`.
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
    `concerts-similar-artists-enrichment (discogs lane): unrecognized db.execute() result shape: ${describeShape(result)}`
  );
};

/**
 * Load the discogs-lane candidate set: distinct `headlining_discogs_artist_id`
 * of Discogs-only headliners of non-removed upcoming curated concerts.
 *
 * @param backfill - when true, drop the upcoming-only `starts_on` window so the
 *   one-time deploy backfill covers every existing Discogs-only headliner.
 */
export const loadDiscogsEnrichmentCandidates = async (backfill = false): Promise<DiscogsEnrichmentCandidate[]> => {
  // Interpolated as a whole `sql` fragment, not a bind param — it's DDL-shaped
  // (a WHERE conjunct), and both branches are compile-time constants we control.
  const windowClause = backfill ? sql`` : sql`AND "c"."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`;

  const result: unknown = await db.execute(sql`
    SELECT DISTINCT "c"."headlining_discogs_artist_id" AS discogs_artist_id
    FROM ${CONCERTS_TABLE} "c"
    WHERE "c"."removed_at" IS NULL
      AND "c"."headlining_artist_id" IS NULL
      AND "c"."headlining_discogs_artist_id" IS NOT NULL
      ${windowClause}
    ORDER BY "c"."headlining_discogs_artist_id" ASC
  `);
  return unwrapRows<DiscogsEnrichmentCandidate>(result);
};
