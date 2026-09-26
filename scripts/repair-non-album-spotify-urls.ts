/**
 * One-off corrective pass for BS#2689: clear the `album_metadata.spotify_url`
 * values that are Spotify URLs but not ALBUM URLs.
 *
 * 14.9% of the populated column pointed somewhere other than the release the
 * row is about — 3,468 artist pages and 841 track pages out of 29,233, so a DJ
 * tapping "Play on Spotify" landed on an artist page or a single track. The
 * write-path guard (`shared/lml-client/src/streaming-url-guard.ts`,
 * `isSpotifyAlbumSlotUrl`) stops new ones arriving; BS persistence is
 * fill-only, so the rows already stored need this pass.
 *
 * WHAT IT WRITES, and why it is three columns and not one:
 *   spotify_url              -> NULL          (the read path in
 *                                              `proxy.controller.ts` then
 *                                              synthesizes a real
 *                                              `open.spotify.com/search/…`
 *                                              link, which is a working
 *                                              answer where an artist page
 *                                              was the wrong record)
 *   spotify_status           -> 'unresolved'  (NOT left as-is)
 *   streaming_reask_attempts -> 0, ONLY if already at/over the cap
 *
 * A bare `spotify_url = NULL` would FREEZE the row. `spotify_status` on these
 * rows is typically `'verified'`, and `mergeStreamingField`
 * (`apps/enrichment-worker/enrich.ts`) rule 1 never revisits a `verified`
 * field, while `precheck.ts` / `streaming-reask.ts` only re-ask an
 * `'unresolved'` one — so null URL + verified status is an album with no
 * Spotify link that nothing will ever look at again. That is the
 * BS#1747/#1915 permanent-null freeze, and it is the same failure the guard
 * avoids by deleting `streaming_status.spotify` rather than just nulling the
 * URL. `'unresolved'` is the value that puts the row back in front of both
 * re-ask mechanisms.
 *
 * `streaming_reask_attempts` is touched only where it would make
 * `'unresolved'` inert: both re-ask gates also require
 * `streaming_reask_attempts < STREAMING_REASK_ATTEMPT_CAP`. Rows under the cap
 * keep their counter untouched — the bound stays as tight as it was. (The
 * counter is per-album, shared across the three services, so clearing an
 * exhausted one does grant apple/bandcamp a fresh bounded budget on that row;
 * that is the narrowest available instrument, and it stays bounded.)
 *
 * SCOPE. The decision is per row, by the same predicate the write path uses —
 * imported, not reimplemented in SQL, so the two cannot drift. Deliberately
 * NOT in scope:
 *   - `/album/…` and `/intl-xx/album/…` values (correct; kept)
 *   - `/search/…` values (the intentional synthesized fallback; kept)
 *   - values on a FOREIGN host, e.g. a Deezer URL under `spotify_url` — those
 *     are BS#1710's cohort and `jobs/streaming-url-remediation` owns them.
 *     Counted and reported here, never written.
 *   - `apple_music_url` — BS#2689 adds no Apple screen; see the
 *     `apple_music_url` branch in `sanitizeLookupStreamingUrls`.
 * Each UPDATE re-asserts the exact URL it read in its WHERE clause, so a value
 * a concurrent enrichment write changed in between is skipped rather than
 * clobbered.
 *
 * Upstream provenance (being fixed in parallel, and not a reason to wait):
 * WXYC/library-metadata-lookup#1353 (an April-2026 enrichment campaign
 * resolved ARTISTS into an album column) and #1352 (LML serves these
 * unverified).
 *
 * Defaults to a dry-run. Pass --apply to actually write.
 *
 * Usage:
 *   npx tsx scripts/repair-non-album-spotify-urls.ts
 *   npx tsx scripts/repair-non-album-spotify-urls.ts --apply
 *
 * Requires: DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD
 */

import { config } from 'dotenv';
config();

import { and, eq, isNotNull } from 'drizzle-orm';
// Imported from sources, not the built `@wxyc/database` / `@wxyc/lml-client`
// packages, for the reason `scripts/backfill-missing-org-members.ts` documents:
// `@wxyc/database`'s barrel pulls the legacy tubafrenzy ETL utilities
// (node-ssh -> native cpu-features) and would block a standalone script run.
import { db } from '../shared/database/src/client';
import { album_metadata } from '../shared/database/src/schema';
import { isSpotifyUrl, isSpotifyAlbumSlotUrl } from '../shared/lml-client/src/streaming-url-guard';

/**
 * Mirrors `STREAMING_REASK_ATTEMPT_CAP` in `apps/enrichment-worker/enrich.ts`,
 * which is the source of truth. Copied rather than imported because importing
 * it would execute the enrichment worker's module graph (LML client, PostHog,
 * …) inside a one-off script. Drift is safe in the direction that matters: if
 * the real cap grew, this script would clear FEWER counters than it could,
 * never more.
 */
const STREAMING_REASK_ATTEMPT_CAP = 3;

interface Candidate {
  album_id: number;
  spotify_url: string;
  spotify_status: string | null;
  streaming_reask_attempts: number;
}

/**
 * The Spotify entity a URL names (`album`, `artist`, `track`, …), for the
 * dry-run breakdown ONLY. The keep-or-clear decision is
 * `isSpotifyAlbumSlotUrl`'s alone; this is reporting, and returns a label even
 * for shapes that predicate has no opinion about.
 */
function reportedEntityKind(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '(unparseable)';
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0 && /^intl-[a-z]{2}$|^intl-[a-z]{2}-[a-z]{2}$/.test(segments[0])) segments.shift();
  if (segments.length === 0) return '(no path)';
  return segments.length === 1 ? `/${segments[0]} (no id)` : `/${segments[0]}/`;
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  console.log(apply ? 'MODE: APPLY (writes will be committed)' : 'MODE: DRY RUN (no writes; pass --apply to commit)');
  console.log('');

  const selected = await db
    .select({
      album_id: album_metadata.album_id,
      spotify_url: album_metadata.spotify_url,
      spotify_status: album_metadata.spotify_status,
      streaming_reask_attempts: album_metadata.streaming_reask_attempts,
    })
    .from(album_metadata)
    .where(isNotNull(album_metadata.spotify_url))
    .orderBy(album_metadata.album_id);
  // The WHERE already excludes NULLs; narrow rather than cast, so a row that
  // somehow arrives NULL is dropped instead of flowing into the predicates as
  // a lie about its own type.
  const rows: Candidate[] = selected.flatMap((row) =>
    row.spotify_url === null ? [] : [{ ...row, spotify_url: row.spotify_url }]
  );

  const keep = rows.filter((row) => isSpotifyAlbumSlotUrl(row.spotify_url));
  const foreignHost = rows.filter((row) => !isSpotifyUrl(row.spotify_url));
  const repair = rows.filter((row) => isSpotifyUrl(row.spotify_url) && !isSpotifyAlbumSlotUrl(row.spotify_url));

  console.log(`Populated spotify_url rows:            ${rows.length}`);
  console.log(`  album-slot shaped (kept)             ${keep.length}`);
  console.log(`  foreign host (BS#1710's, not mine)   ${foreignHost.length}`);
  console.log(`  TO REPAIR                            ${repair.length}`);
  console.log('');
  console.log('To-repair breakdown by Spotify entity:');
  for (const [kind, count] of tally(repair.map((row) => reportedEntityKind(row.spotify_url)))) {
    console.log(`  ${kind.padEnd(22)} ${count}`);
  }
  console.log('');
  console.log('To-repair breakdown by current spotify_status:');
  for (const [status, count] of tally(repair.map((row) => row.spotify_status ?? '(null)'))) {
    console.log(`  ${status.padEnd(22)} ${count}`);
  }
  const exhausted = repair.filter((row) => row.streaming_reask_attempts >= STREAMING_REASK_ATTEMPT_CAP);
  console.log('');
  console.log(`Of those, re-ask counter at/over the cap (will be cleared to 0): ${exhausted.length}`);
  console.log('');

  if (repair.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }
  if (!apply) {
    for (const row of repair.slice(0, 20)) {
      console.log(`  sample album_id=${row.album_id}  ${row.spotify_url}`);
    }
    console.log('');
    console.log('Dry run complete. Re-run with --apply to commit.');
    process.exit(0);
  }

  let updated = 0;
  let skipped = 0;
  const failures: { album_id: number; error: string }[] = [];
  for (const row of repair) {
    try {
      const result = await db
        .update(album_metadata)
        .set({
          spotify_url: null,
          spotify_status: 'unresolved',
          // Untouched unless it would make 'unresolved' inert. See the header.
          streaming_reask_attempts:
            row.streaming_reask_attempts >= STREAMING_REASK_ATTEMPT_CAP ? 0 : row.streaming_reask_attempts,
          updated_at: new Date(),
        })
        // Re-asserting the exact value read above makes this a no-op rather
        // than a clobber if enrichment rewrote the row in between.
        .where(and(eq(album_metadata.album_id, row.album_id), eq(album_metadata.spotify_url, row.spotify_url)))
        .returning({ album_id: album_metadata.album_id });
      if (result.length === 0) {
        console.log(`  skip album_id=${row.album_id} (spotify_url changed under us)`);
        skipped++;
      } else {
        updated++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ album_id: row.album_id, error: message });
      console.error(`  FAIL album_id=${row.album_id}  ${message}`);
    }
  }

  console.log('');
  console.log(`Repaired:                  ${updated}`);
  console.log(`Skipped (changed under us):${skipped}`);
  console.log(`Failed:                    ${failures.length}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
