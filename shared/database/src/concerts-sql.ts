/**
 * Shared SQL fragments for the concert writers (jobs/venue-events-scraper
 * and jobs/triangle-shows-etl). Both writers UPSERT `concerts` by
 * (source, source_id) and refresh `headlining_artist_raw` on conflict —
 * so both carry the same table invariant, kept in ONE place here:
 *
 *   `headlining_artist_id` is only valid for the raw headliner it was
 *   resolved from.
 *
 * The concerts-artist-resolver is deliberately write-once (it claims
 * rows WHERE headlining_artist_id IS NULL and never revisits a stamped
 * row — see jobs/concerts-artist-resolver). Both writers' source_ids are
 * rename-stable (RHP: page pathnames survive a billed-artist swap;
 * triangle-shows: ext:/url: source_key tiers survive renames by
 * contract), so a headliner change arrives as an ON CONFLICT UPDATE on
 * the same row. Without this fragment the stale FK would serve the old
 * artist forever; with it, the resolver re-claims the row the same night.
 */

import { sql, type SQL } from 'drizzle-orm';
import { concerts } from './schema.js';

/**
 * ON CONFLICT `set` entry for `headlining_artist_id`: clear the resolved
 * FK ONLY when the incoming raw headliner actually differs from the
 * stored one (`IS DISTINCT FROM excluded...`); untouched rows keep their
 * resolved id, so nightly re-upserts of unchanged events never churn the
 * resolver. In a DO UPDATE SET, table-qualified refs read the EXISTING
 * row and `excluded` reads the proposed insert — the same idiom the RHP
 * venue upsert's `setWhere` already uses in production.
 */
export const headliningArtistIdConflictClear = (): SQL =>
  sql`CASE WHEN ${concerts.headlining_artist_raw} IS DISTINCT FROM excluded."headlining_artist_raw" THEN NULL ELSE ${concerts.headlining_artist_id} END`;
