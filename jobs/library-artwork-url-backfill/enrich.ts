/**
 * Per-row enrichment: turn an LML response into a single-column UPDATE on
 * `library.artwork_url` for #637 (warm the search-path enrichment cache).
 *
 * Result shape:
 *   - On success-with-match (artwork URL present, not a spacer.gif): write
 *     `artwork_url`. Returns `enriched_match` (or `enriched_match_raced` if
 *     the search-path runtime stamped the row between this job's SELECT and
 *     UPDATE — the WHERE narrows by `artwork_url IS NULL` so the second
 *     write is a no-op).
 *   - On success-no-match (LML returned no results, or artwork was null /
 *     filtered out): no UPDATE issued; the row stays NULL so the next sweep
 *     retries it. Returns `enriched_no_match`. The issue (#637) accepts the
 *     re-lookup cost on subsequent runs because no-match rows are bounded
 *     by the resolvable set (~18.5K total) and the run is one-shot.
 *   - On LML throw: caller catches and DOES NOT call this. Row stays NULL.
 *
 * Race contract: the search-path `enrichWithArtwork` service writes
 * `artwork_url` on first lookup of un-cached albums. If the runtime path
 * stamps a row between the orchestrator's SELECT and this UPDATE, the
 * `artwork_url IS NULL` predicate in the WHERE no longer matches and
 * Postgres updates 0 rows. The `enriched_match_raced` outcome separates
 * "I personally enriched this row" from "this row was enriched by *someone*
 * during the run." Data outcome is identical either way.
 *
 * Spacer.gif filter: applied inline. Discogs occasionally returns
 * `spacer.gif` placeholder images; persisting them would defeat the
 * search-path short-circuit (a non-null spacer URL is still rendered as
 * broken artwork). Mirrors the inline filter in
 * `flowsheet-metadata-backfill/enrich.ts` until #649's shared helper lands.
 */

import { sql } from 'drizzle-orm';
import { db, library } from '@wxyc/database';
import type { LmlArtwork, LmlLookupResponse } from './lml-types.js';

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string;
};

export type EnrichOutcome = 'enriched_match' | 'enriched_match_raced' | 'enriched_no_match';

/**
 * Drop Discogs spacer.gif placeholder URLs. Inline guard mirroring the one in
 * `flowsheet-metadata-backfill/enrich.ts`.
 */
const filterSpacerGif = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.includes('spacer.gif')) return null;
  return url;
};

/**
 * Pick the first artwork from an LML response, or null on no-match.
 *
 * "No artwork" covers three response shapes that all mean the same thing
 * operationally: empty `results`, a `results[0]` with no `artwork` field, or
 * `artwork: null`. All three end up writing nothing and leaving the row
 * NULL.
 */
export const extractArtwork = (response: LmlLookupResponse): LmlArtwork | null => {
  const first = response.results?.[0];
  if (!first) return null;
  if (!first.artwork) return null;
  return first.artwork;
};

/**
 * Apply a single LML response to a library row.
 *
 * Returns the outcome so the orchestrator can count it. Errors propagate up —
 * this function does not swallow.
 */
export const applyEnrichment = async (row: EnrichRow, response: LmlLookupResponse): Promise<EnrichOutcome> => {
  const artwork = extractArtwork(response);
  const url = artwork ? filterSpacerGif(artwork.artwork_url) : null;

  if (!url) {
    // No usable artwork — leave the row NULL so a future sweep can retry.
    // The issue (#637) accepts the re-lookup cost: no-match rows are bounded
    // by the resolvable set, and the search-path enrichment will retry
    // naturally as well.
    return 'enriched_no_match';
  }

  const updated = await db
    .update(library)
    .set({ artwork_url: url })
    // Idempotency + race guard: WHERE narrows by `artwork_url IS NULL`. A row
    // the search-path runtime stamped between the orchestrator's SELECT and
    // this UPDATE matches 0 rows.
    .where(sql`"id" = ${row.id} AND "artwork_url" IS NULL`)
    .returning({ id: library.id });

  return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
};
