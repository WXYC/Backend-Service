/**
 * Per-row writer for the artwork-provenance-remediation drain (BS#2258).
 *
 * The complement of `jobs/flowsheet-artwork-repair` (BS#1209): that drain
 * healed the rows LML's `_resolve_fallback_artwork` bug left **null**; this
 * one heals the rows the same bug left **wrong and non-null** — Discogs
 * artist images and label logos persisted as album covers. #1209's
 * `artwork_url IS NULL` predicate could not reach them by construction.
 *
 * Four rules bound the blast radius, in descending order of how much damage
 * they prevent:
 *
 * **1. Never null out.** A lookup that returns no artwork leaves the row
 * untouched (`no_match`). A wrong image is bad; a blank tile in dj-site's
 * card catalog is a visible regression on a row that at least rendered
 * something. This is BS#2258's explicitly-deferred policy question, decided
 * here in the direction the ticket recommends.
 *
 * **2. Only strictly-better answers land.** If the fresh lookup's artwork is
 * itself an artist image or a label logo, that is `still_wrong` and nothing
 * is written. Swapping a Warp logo for a photo of Autechre is lateral — it
 * fixes nothing and spends the row's `updated_at`, which BS#2258 relies on
 * as the only available proxy for artwork-write time.
 *
 * **3. Narrow write.** `artwork_url` and `updated_at`, nothing else. The
 * sibling drain rewrites all ten metadata columns because its rows were
 * wholly unenriched; these rows are fully enriched and wrong in exactly one
 * column. The other nine came from the canonical writer under conditions this
 * drain has not re-measured, and a 9x wider write for no stated benefit is
 * the opposite of the surgical change the data-safety rule asks for.
 * `discogs_url` in particular is *correct* on these rows — LML bound the
 * right release and then failed to find that release's cover.
 *
 * **4. Exact-value race guard.** The UPDATE's WHERE pins `artwork_url` to the
 * value the selector classified, not just `album_id`. Between the
 * orchestrator's SELECT and this write, a live enrichment may have healed the
 * row on its own; pinning the old value means such a row falls out of the
 * WHERE (`raced`) instead of being overwritten with this drain's staler
 * answer. This is the same idea as the sibling's `artwork_url IS NULL` guard,
 * strengthened from "still in the eligible state" to "still byte-identical".
 * Written as a raw `sql` template rather than `and(eq(...), eq(...))` for the
 * same reason the sibling's free-form writer is: the guard is the safety-
 * critical half of this job, and a literal template is what a test can pin
 * and a reviewer can read without resolving column objects.
 *
 * Idempotent: a re-run re-selects only rows that are still wrong, and every
 * write re-checks the value it read.
 */

import { sql } from 'drizzle-orm';
import { album_metadata, db } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import { filterSpacerGif, isWrongArtworkProvenance } from '@wxyc/metadata';

/**
 * One `album_metadata` row whose stored artwork provably depicts something
 * other than the release. `artwork_url` is carried through from the
 * enumeration because it is the race guard's pinned value, not merely
 * diagnostic.
 */
export type WrongArtworkRow = {
  album_id: number;
  artist_name: string;
  album_title: string;
  artwork_url: string;
};

/**
 * - `healed` — a real cover was resolved and written.
 * - `still_wrong` — LML resolved another artist image or label logo; no write.
 * - `no_match` — LML resolved no usable artwork at all; no write.
 * - `raced` — the guarded UPDATE matched zero rows; something else moved the
 *   value first. Not an error: the row is fresher than what we held.
 */
export type RemediationOutcome = 'healed' | 'still_wrong' | 'no_match' | 'raced';

/**
 * The artwork URL from a fresh lookup, with Discogs' 1x1 spacer placeholder
 * filtered out — persisting that trips the "has artwork" partial indexes and
 * renders as a broken image (BS#890).
 */
const freshArtworkUrl = (response: LookupResponse): string | null =>
  filterSpacerGif(response.results?.[0]?.artwork?.artwork_url);

/**
 * Re-adjudicate one album's artwork against a fresh LML lookup. See the
 * module docstring for the four rules; each outcome maps to one of them.
 */
export const remediateAlbum = async (row: WrongArtworkRow, response: LookupResponse): Promise<RemediationOutcome> => {
  const fresh = freshArtworkUrl(response);
  if (!fresh) return 'no_match';
  if (isWrongArtworkProvenance(fresh)) return 'still_wrong';

  const updated = await db
    .update(album_metadata)
    .set({ artwork_url: fresh, updated_at: sql`NOW()` })
    .where(sql`"album_id" = ${row.album_id} AND "artwork_url" = ${row.artwork_url}`)
    .returning({ album_id: album_metadata.album_id });

  return updated.length === 0 ? 'raced' : 'healed';
};
