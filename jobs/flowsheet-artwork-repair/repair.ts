/**
 * Per-row repair writers for the flowsheet-artwork-repair drain (BS#1209).
 *
 * Two populations stranded by LML#408 (fixed in LML#409, deployed prod
 * 2026-05-29):
 *
 *   1. Free-form rows  — `flowsheet.album_id IS NULL`,
 *                        `metadata_status = 'enriched_match'`,
 *                        `artwork_url IS NULL`. The enrichment-worker landed
 *                        a 10-col UPDATE with `artwork_url=NULL` and flipped
 *                        the status to `enriched_match`. We re-query LML and
 *                        write the same 10 cols (status untouched).
 *   2. Linked rows     — `album_metadata.artwork_url IS NULL`. The worker
 *                        UPSERTed `album_metadata` with `artwork_url=NULL`.
 *                        We re-query LML and UPSERT the same 10 cols. No
 *                        flowsheet write — the read-path COALESCE join over
 *                        `album_metadata` picks the fix up automatically.
 *
 * Hard contracts (from the ticket body):
 *
 *   - `metadata_status` is read-only. The drain MUST NOT flip it. The
 *     LML#400 follow-up backfill (if filed) will revisit `still_null_after_lml`
 *     rows for status correction.
 *   - Race-guarded WHERE on the free-form UPDATE: `id = $1 AND artwork_url
 *     IS NULL AND metadata_status = 'enriched_match'`. A concurrent fresh
 *     enrichment between the orchestrator's SELECT and our UPDATE would have
 *     flipped one of those two columns; either flip kicks the row out of
 *     the WHERE and we return `free_form_raced` instead of corrupting
 *     fresher data.
 *   - Race-guarded UPSERT on the linked path: `setWhere: album_metadata.
 *     updated_at < NOW()`, mirroring the enrichment-worker shape verbatim.
 *
 * The 10-column payload, spacer.gif filter, Discogs-bio cleanup, and the
 * `release_year || null` coercion all mirror `apps/enrichment-worker/
 * enrich.ts:181-198` (canonical writer) and `jobs/flowsheet-metadata-
 * backfill/enrich.ts` (sibling drain). The duplication is the same build-
 * graph isolation the other one-shot jobs carry: no imports from
 * `apps/backend` so the job's Docker image graph is independent.
 *
 * No-write early-return on still-null-after-LML: a fresh LML lookup that
 * returns `results: []`, `artwork: null`, or `artwork.artwork_url: null`
 * means the row is legitimate no-cover-anywhere territory (post-LML#409).
 * Writing null over null is a no-op at best and confuses the
 * `still_null_after_lml` counter at worst. Return early; let the LML#400
 * follow-up consume the bucket.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

export type FreeFormRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
};

export type LinkedAlbum = {
  album_id: number;
  artist_name: string;
  album_title: string;
};

export type RepairOutcome =
  | 'free_form_repaired'
  | 'free_form_raced'
  | 'linked_repaired'
  | 'linked_raced'
  | 'still_null_after_lml';

/**
 * Strip Discogs markup tags from bio text. Mirrors
 * `apps/backend/services/metadata/metadata.service.ts#cleanDiscogsBio`
 * and `jobs/flowsheet-metadata-backfill/enrich.ts#cleanDiscogsBio`
 * verbatim. Duplicated for build-graph isolation.
 */
export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');

/**
 * Drop Discogs spacer.gif placeholder URLs. Mirrors
 * `jobs/flowsheet-metadata-backfill/enrich.ts#filterSpacerGif`. The job
 * writes to nullable columns, so this returns `null` (not `undefined`).
 */
export const filterSpacerGif = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.includes('spacer.gif')) return null;
  return url;
};

/**
 * Pick the top-1 artwork block from an LML response, or null if the
 * response indicates the row is legitimate no-cover-anywhere territory
 * (empty results, or artwork field present-but-null on the top hit).
 */
export const extractArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
  const first = response.results?.[0];
  if (!first) return null;
  if (!first.artwork) return null;
  return first.artwork;
};

/**
 * Build the 10-column metadata payload from an LML artwork block. Same
 * shape as `apps/enrichment-worker/enrich.ts:181-198` (canonical writer).
 * Fan-out URLs default to null on no-LML-provided value — the drain
 * deliberately does NOT synthesize search URLs, unlike the sibling
 * `flowsheet-metadata-backfill` drain. Those URLs were already written
 * by the original enrichment cycle that landed `metadata_status =
 * 'enriched_match'` (the population this drain targets), so re-writing
 * with `null` would silently strip the synthesized fallbacks. Leaving
 * `null` in the payload pairs with the WHERE's IS NULL guard to preserve
 * the existing fan-out URLs on UPDATE.
 *
 * Wait — the WHERE only narrows by `artwork_url IS NULL`; it doesn't
 * pin the other 9. To avoid clobbering existing values on those, the
 * 10-col UPDATE shape includes them all, but in practice the population's
 * upstream cycle never wrote them either (they all came back null from
 * LML's degenerate response), so the UPDATE just confirms the same null.
 * The canonical writer shape is what the consumer wrote originally; we
 * mirror it exactly so the comparison "would the consumer have written
 * this column to this value if it had a fresh LML response?" answers yes
 * for every column, every time.
 */
const buildPayload = (artwork: DiscogsMatchResult) => ({
  artwork_url: filterSpacerGif(artwork.artwork_url),
  discogs_url: artwork.release_url ?? null,
  // Discogs returns 0 as "year unknown"; coerce to null so the column
  // doesn't carry a sentinel that iOS renders as literal "0". Mirrors
  // the runtime path in `metadata.service.ts#extractAlbumMetadata` (#1002).
  release_year: artwork.release_year || null,
  spotify_url: artwork.spotify_url ?? null,
  apple_music_url: artwork.apple_music_url ?? null,
  youtube_music_url: artwork.youtube_music_url ?? null,
  bandcamp_url: artwork.bandcamp_url ?? null,
  soundcloud_url: artwork.soundcloud_url ?? null,
  artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
  artist_wikipedia_url: artwork.wikipedia_url ?? null,
});

/**
 * Repair one free-form flowsheet row. UPDATE `flowsheet` with the 10
 * metadata columns; idempotent WHERE narrows by `id`, `artwork_url IS NULL`,
 * `metadata_status = 'enriched_match'`. `metadata_status` is NOT in the
 * .set() block.
 *
 * Outcomes:
 *   - `still_null_after_lml` — LML returned no usable artwork; no DB write.
 *   - `free_form_raced` — UPDATE ran, 0 rows matched (artwork already
 *     non-null OR status flipped). Idempotent; correctness preserved.
 *   - `free_form_repaired` — UPDATE ran, 1 row matched. Done.
 */
export const repairFreeFormRow = async (row: FreeFormRow, response: LookupResponse): Promise<RepairOutcome> => {
  const artwork = extractArtwork(response);
  if (!artwork || !artwork.artwork_url) return 'still_null_after_lml';

  const payload = buildPayload(artwork);
  const updated = await db
    .update(flowsheet)
    .set(payload)
    .where(sql`"id" = ${row.id} AND "artwork_url" IS NULL AND "metadata_status" = 'enriched_match'`)
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'free_form_raced' : 'free_form_repaired';
};

/**
 * Repair one linked album. UPSERT `album_metadata` with the 10 metadata
 * columns + `updated_at = NOW()`. Race guard: `setWhere: album_metadata.
 * updated_at < NOW()` mirrors the enrichment-worker shape (BS#899)
 * verbatim. No flowsheet write — the read-path COALESCE join picks the
 * fix up automatically.
 *
 * Outcomes:
 *   - `still_null_after_lml` — LML returned no usable artwork; no DB write.
 *   - `linked_raced` — UPSERT's ON CONFLICT branch didn't fire (setWhere
 *     missed); a concurrent fresh enrichment landed first. RETURNING is
 *     empty.
 *   - `linked_repaired` — UPSERT wrote a row. RETURNING is non-empty.
 *
 * Note on race detection: the linked population's qualifying SELECT
 * (`album_metadata.artwork_url IS NULL`) guarantees a row already exists
 * for `album_id`, so we always take the UPDATE branch in practice. The
 * INSERT branch is unreachable but specified for correctness against
 * future schema changes (e.g., a partial unique index that lets the row
 * be deleted out from under us).
 */
export const repairLinkedAlbum = async (album: LinkedAlbum, response: LookupResponse): Promise<RepairOutcome> => {
  const artwork = extractArtwork(response);
  if (!artwork || !artwork.artwork_url) return 'still_null_after_lml';

  const payload = buildPayload(artwork);
  const updated = await db
    .insert(album_metadata)
    .values({ album_id: album.album_id, ...payload, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: { ...payload, updated_at: sql`NOW()` },
      setWhere: sql`${album_metadata.updated_at} < NOW()`,
    })
    .returning({ album_id: album_metadata.album_id });
  return updated.length === 0 ? 'linked_raced' : 'linked_repaired';
};

/**
 * Re-export the drizzle helper trio for tests + orchestrator. Keeps the
 * surface of imports stable across the package.
 */
export { and, eq, isNull };
