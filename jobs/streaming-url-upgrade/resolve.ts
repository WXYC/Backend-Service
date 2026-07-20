/**
 * Write-side of the streaming-url-upgrade remediation (BS#1672).
 *
 * Backend-Service persisted LML's write-time streaming fallbacks verbatim:
 * when a lookup could not resolve a verified Spotify/Bandcamp link, LML
 * synthesized a provider *search* URL (`@wxyc/metadata` `synthesizeSearchUrls`
 * + `search-urls.provider.ts`) and BS stored it. Those rows never re-query,
 * so a search URL that could now resolve to a verified album link stays a
 * search URL forever. With the LML-side drains landed (LML#831 Spotify,
 * LML#832 Bandcamp), a re-query resolves many of them; this module applies
 * what the re-query returns.
 *
 * Three invariants, all load-bearing:
 *
 *   1. One column at a time: `applyUpgrade` sets exactly the one target
 *      streaming column (plus the `updated_at` bump on album_metadata — the
 *      writer convention from apps/enrichment-worker/enrich.ts; flowsheet's
 *      BEFORE UPDATE trigger `bump_flowsheet_updated_at` owns its own stamp,
 *      migration 0084). A single LML lookup can upgrade both spotify and
 *      bandcamp on one row, but each is a separate guarded UPDATE so a raced
 *      write to one column never blocks the other.
 *
 *   2. Never-downgrade, enforced in SQL: the WHERE carries
 *      `<column> LIKE '<search-prefix>%'` — this job only ever overwrites a
 *      *search-shaped* value. A verified link that appeared between the
 *      orchestrator's SELECT and this UPDATE (enrichment worker, a parallel
 *      run, manual fix) no longer matches the LIKE, so it is left untouched
 *      and reported as 'skipped_not_search' rather than clobbered. This is
 *      the shape-predicate analogue of the apple-music-url-backfill's
 *      `IS NULL` guard (BS#1631).
 *
 *   3. No search→search: `extractStreamingUrls` returns a URL only when it
 *      is present, non-empty, AND not itself search-shaped, so a lookup that
 *      still falls back to a search URL is treated as "no upgrade" — the row
 *      stays search-shaped and is retried on a later run instead of being
 *      rewritten with an equivalent search URL.
 *
 * Errors propagate — the orchestrator's catch arm counts them as
 * 'db_error' and continues.
 *
 * YouTube Music (`youtube_music_url`) and SoundCloud (`soundcloud_url`) are
 * deliberately OUT of scope: the AC1 prod audit (2026-07-20) found zero
 * verified rows for either across 3.6M+ column-values, and only spotify +
 * bandcamp have a drain ticket. YouTube can be added here once LML#833 lands
 * (append a ServiceConfig); SoundCloud has no path to verified links.
 */

import { and, eq, like, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';

export type ApplyTarget = 'album_metadata' | 'flowsheet';
export type UpgradeService = 'spotify' | 'bandcamp';
export type ApplyOutcome = 'upgraded' | 'skipped_not_search';

export interface ServiceConfig {
  service: UpgradeService;
  /** The streaming column on both album_metadata and flowsheet. */
  column: 'spotify_url' | 'bandcamp_url';
  /**
   * The exact search-URL prefix LML synthesizes for this service — byte-
   * identical to `@wxyc/metadata` `synthesizeSearchUrls` /
   * `search-urls.provider.ts`, confirmed against prod (BS#1672 AC1: exactly
   * one prefix per service, no historical variants). A value starting with
   * this prefix is upgradeable; anything else is a verified link (or a
   * foreign-provider link — see BS#1710) and is left alone.
   */
  searchPrefix: string;
}

export const SERVICE_CONFIGS: readonly ServiceConfig[] = [
  { service: 'spotify', column: 'spotify_url', searchPrefix: 'https://open.spotify.com/search/' },
  { service: 'bandcamp', column: 'bandcamp_url', searchPrefix: 'https://bandcamp.com/search?q=' },
] as const;

const CONFIG_BY_SERVICE: Record<UpgradeService, ServiceConfig> = Object.fromEntries(
  SERVICE_CONFIGS.map((c) => [c.service, c])
) as Record<UpgradeService, ServiceConfig>;

/**
 * True iff `url` is the search-URL fallback for `service`. The candidate
 * predicate (orchestrator) and this write guard both key on it, so a row's
 * "is upgradeable" verdict can never drift between SELECT and UPDATE.
 */
export const isSearchShaped = (service: UpgradeService, url: string | null | undefined): boolean =>
  !!url && url.startsWith(CONFIG_BY_SERVICE[service].searchPrefix);

/**
 * Read the verified streaming URL per in-scope service off the top-1 lookup
 * result's artwork block.
 *
 * Top-1 only — mirroring what the enrichment worker persisted from the
 * original lookup; a URL on a lower-ranked (different-release) result is not
 * evidence about THIS row's release. A value that is empty, absent, or still
 * search-shaped coerces to null so the job never writes a blank or another
 * search URL into the column.
 */
export const extractStreamingUrls = (response: LookupResponse): Record<UpgradeService, string | null> => {
  const artwork = response.results?.[0]?.artwork;
  const out = {} as Record<UpgradeService, string | null>;
  for (const cfg of SERVICE_CONFIGS) {
    const value = artwork ? (artwork as Record<string, unknown>)[cfg.column] : null;
    out[cfg.service] = typeof value === 'string' && value !== '' && !isSearchShaped(cfg.service, value) ? value : null;
  }
  return out;
};

/**
 * Overwrite a single still-search-shaped streaming column with the verified
 * `url`. `id` is `album_metadata.album_id` or `flowsheet.id` per `target`.
 * Returns 'skipped_not_search' when the guarded UPDATE matches 0 rows (the
 * column was verified — or otherwise stopped being search-shaped — since the
 * orchestrator's SELECT).
 */
export const applyUpgrade = async (
  target: ApplyTarget,
  id: number,
  service: UpgradeService,
  url: string
): Promise<ApplyOutcome> => {
  const pattern = CONFIG_BY_SERVICE[service].searchPrefix + '%';

  let updated: Array<{ id: number }>;
  if (target === 'album_metadata') {
    const guardColumn = service === 'spotify' ? album_metadata.spotify_url : album_metadata.bandcamp_url;
    const set = service === 'spotify' ? { spotify_url: url } : { bandcamp_url: url };
    updated = await db
      .update(album_metadata)
      .set({ ...set, updated_at: sql`NOW()` })
      .where(and(eq(album_metadata.album_id, id), like(guardColumn, pattern)))
      .returning({ id: album_metadata.album_id });
  } else {
    const guardColumn = service === 'spotify' ? flowsheet.spotify_url : flowsheet.bandcamp_url;
    const set = service === 'spotify' ? { spotify_url: url } : { bandcamp_url: url };
    updated = await db
      .update(flowsheet)
      .set(set)
      .where(and(eq(flowsheet.id, id), like(guardColumn, pattern)))
      .returning({ id: flowsheet.id });
  }

  return updated.length === 0 ? 'skipped_not_search' : 'upgraded';
};
