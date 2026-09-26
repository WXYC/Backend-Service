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
 * The per-row judgement — which cohort a value is in, and what a cleared row
 * may have written to it — lives in `scripts/lib/spotify-album-slot-repair.ts`
 * under unit test, because `scripts/**` is outside both eslint and
 * `npm run typecheck`. Read that module's doc comments for WHY the patch is
 * shaped the way it is: two columns and not three, NULL and not
 * `'unresolved'`, `'absent'` preserved, `streaming_reask_attempts` never
 * touched. This file is the IO and the SQL.
 *
 * SCOPE. Deliberately NOT in scope:
 *   - `/album/…` and `/intl-xx/album/…` values (correct; kept)
 *   - `/search/…` values (the intentional synthesized fallback; kept)
 *   - values on a FOREIGN host, e.g. a Deezer URL under `spotify_url` — those
 *     are BS#1710's cohort and `jobs/streaming-url-remediation` owns them.
 *     Counted and reported here, never written.
 *   - `apple_music_url` — BS#2689 adds no Apple screen; see the
 *     `apple_music_url` branch in `sanitizeLookupStreamingUrls`.
 *   - **`flowsheet.spotify_url`** — the inline sibling column, and READ THE
 *     WARNING BELOW before running with `--apply`.
 *
 * ⚠ THE INLINE COLUMN CAN UNMASK. `apps/backend/utils/album-metadata-projection.ts`
 * serves `coalesce(album_metadata.spotify_url, flowsheet.spotify_url)`, and
 * `flowsheet.spotify_url` holds its own inline copy written by the pre-Epic-D
 * runtime path (and still written by the unlinked no-match arm). So for a
 * playcut whose album carries a legacy inline value, nulling
 * `album_metadata.spotify_url` PROMOTES `flowsheet.spotify_url` to the served
 * value — and the serve seam's `suppressMislabeledStreamingUrls` only
 * host-checks it, so if that inline value is itself an artist page the DJ still
 * lands on an artist page while a re-count over `album_metadata` reports the
 * column clean. The dry run therefore counts that cohort explicitly. It is not
 * repaired here: `flowsheet` has no `spotify_status` / `streaming_reask_attempts`
 * columns, so it is a different write with a different freeze analysis, and it
 * needs its own ticket rather than a second arm bolted onto this one.
 *
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

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
// Imported from sources, not the built `@wxyc/database` / `@wxyc/lml-client`
// packages, for the reason `scripts/backfill-missing-org-members.ts` documents:
// `@wxyc/database`'s barrel pulls the legacy tubafrenzy ETL utilities
// (node-ssh -> native cpu-features) and would block a standalone script run.
import { db } from '../shared/database/src/client';
import { album_metadata, flowsheet } from '../shared/database/src/schema';
import {
  classifySpotifyUrl,
  buildSpotifyRepairPatch,
  reportedEntityKind,
  type SpotifyUrlCohort,
} from './lib/spotify-album-slot-repair';

interface Candidate {
  album_id: number;
  spotify_url: string;
  spotify_status: string | null;
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Count the albums in `repairIds` whose `flowsheet.spotify_url` inline copy
 * would be promoted by the COALESCE and is ITSELF not an album URL — see the
 * unmask warning in this file's header. Reported so the scope decision is made
 * with a number rather than an assumption.
 */
async function countUnmaskableInlineRows(repairIds: number[]): Promise<number> {
  if (repairIds.length === 0) return 0;
  const inline = await db
    .select({ album_id: flowsheet.album_id, spotify_url: flowsheet.spotify_url })
    .from(flowsheet)
    .where(and(inArray(flowsheet.album_id, repairIds), isNotNull(flowsheet.spotify_url)));
  const affected = new Set<number>();
  for (const row of inline) {
    if (row.album_id === null || row.spotify_url === null) continue;
    if (classifySpotifyUrl(row.spotify_url) !== 'album-slot') affected.add(row.album_id);
  }
  return affected.size;
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

  const cohorts: Record<SpotifyUrlCohort, Candidate[]> = { 'album-slot': [], 'foreign-host': [], repair: [] };
  for (const row of rows) cohorts[classifySpotifyUrl(row.spotify_url)].push(row);
  const repair = cohorts.repair;

  console.log(`Populated spotify_url rows:            ${rows.length}`);
  console.log(`  album-slot shaped (kept)             ${cohorts['album-slot'].length}`);
  console.log(`  foreign host (BS#1710's, not mine)   ${cohorts['foreign-host'].length}`);
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
  console.log('');

  if (repair.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  const unmaskable = await countUnmaskableInlineRows(repair.map((row) => row.album_id));
  console.log(`Of those, albums whose flowsheet.spotify_url inline copy is ALSO not an album URL: ${unmaskable}`);
  console.log('  (nulling album_metadata promotes that value on serve — see this script’s header)');
  console.log('');

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
        // `sql\`NOW()\`` rather than the script host's clock: both write arms in
        // `apps/enrichment-worker/enrich.ts` carry
        // `setWhere: album_metadata.updated_at < NOW()`, and `precheck.ts`'s
        // header names an out-of-band backfill stamping a future timestamp as
        // the one shape that defeats them — a forward-skewed clock here would
        // make every later enrichment UPSERT on these rows a silent no-op.
        .set({ ...buildSpotifyRepairPatch(row.spotify_status), updated_at: sql`NOW()` })
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
