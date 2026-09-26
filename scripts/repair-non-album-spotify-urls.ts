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
 * THIS PASS IS NOT CLEANUP AFTER THE GUARD — it is the only thing that fixes an
 * existing row. The guard is prospective ONLY, and not merely because
 * persistence is fill-only: for a row already at `spotify_status = 'verified'`,
 * deleting the incoming `streaming_status.spotify` makes the incoming verdict
 * `undefined`, and `buildStreamingFieldConflictSet`'s not-consulted branch then
 * emits `url: CASE WHEN status = 'verified' THEN <live column> ELSE <fallback>
 * END` — so the UPDATE writes the stored artist URL back verbatim.
 * `mergeStreamingField` says the same thing one layer up, with
 * `if (current.status === 'verified') return current`. The guard stops the next
 * bad value; these ~4,353 rows change only if this script runs.
 *
 * The per-row judgement — which cohort a value is in, and what a cleared row
 * may have written to it — lives in `scripts/lib/spotify-album-slot-repair.ts`
 * under unit test, because `scripts/**` is outside both eslint and
 * `npm run typecheck`. Read that module's doc comments for WHY the patch is
 * shaped the way it is: `'unresolved'` and not NULL (the only re-ask-eligible
 * value, and the upstream fixes are landing), `'absent'` preserved as terminal,
 * and `streaming_reask_attempts` reset only where `'unresolved'` would
 * otherwise be inert. This file is the IO and the SQL.
 *
 * SCOPE. Deliberately NOT in scope:
 *   - `/album/…` and `/intl-xx/album/…` values (correct; kept)
 *   - `/search/…` values (the intentional synthesized fallback; kept)
 *   - values on a FOREIGN host, e.g. a Deezer URL under `spotify_url` — BS#1710's
 *     cohort. Counted and reported here, never written; see
 *     `classifySpotifyUrl`'s doc comment for which parts of it
 *     `jobs/streaming-url-remediation` can actually reach and which have no
 *     owner at all.
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
 * Upstream provenance: WXYC/library-metadata-lookup#1353 (an April-2026
 * enrichment campaign resolved ARTISTS into an album column) and #1352 (LML
 * serves these unverified). Both MERGED 2026-09-26, along with #1355 (the
 * export-side match-provenance gate).
 *
 * SEQUENCING, and the reason this is not purely an operator's convenience.
 * Every row this sets to `'unresolved'` becomes re-ask-eligible, and those
 * re-asks are bounded by ONE shared per-album counter across spotify, apple and
 * bandcamp (`STREAMING_REASK_ATTEMPT_CAP` = 3). So the pass spends a finite,
 * shared budget, and what it buys depends on what LML answers when it is spent:
 *
 *   - Run it while the LML fixes are unDEPLOYED and LML still serves the same
 *     artist page. The guard suppresses it, the conflict branch rewrites the
 *     search fallback, the counter increments, and after three attempts the rows
 *     sit at the cap still `'unresolved'` — which neither re-ask gate selects.
 *     They then do NOT self-heal when LML is fixed, which is the entire reason
 *     `'unresolved'` was chosen over NULL. The budget is spent for nothing and
 *     apple/bandcamp lose theirs on all ~4,353 rows too.
 *   - Run it after the fixes are live. LML no longer serves a non-album value in
 *     the slot at all, so the re-ask resolves to a real verdict.
 *
 * LML `main` deploys to STAGING; production tracks its `prod` branch, and the
 * export gate additionally only takes effect on the next daily `sync-library.sh`
 * re-export. So "merged" is not the bar — confirm LML prod serves an
 * album-shaped `spotify_url` (or none) for a sample of these albums before
 * `--apply`. If the pass has already run, it must be run again afterwards.
 *
 * SWEEP OCCUPANCY. The newly-`'unresolved'` rows are drained by the hourly
 * streaming-reask sweep at `ENRICHMENT_STREAMING_REASK_SWEEP_BATCH_SIZE` = 200
 * per tick, and `findUnresolvedStreamingCandidates` has no `ORDER BY`, so there
 * is no fairness between these rows and genuinely-unresolved albums. ~4,353 rows
 * is ~22 ticks per pass and up to ~65 ticks (~2.7 days) across the three
 * attempts, during which the sweep is largely working this cohort. Stage
 * `--apply` in batches if that window matters.
 *
 * Defaults to a dry-run. Pass --apply to actually write.
 *
 * Usage — via dotenvx, NOT a bare `tsx`. `import { config } from 'dotenv'; config()`
 * does not work in an ES module: every `import` below is hoisted above it, so
 * `shared/database/src/client.ts` evaluates first and throws on its
 * module-scope env validation before dotenv has read the file. This is the
 * mechanism package.json already uses for `check:audit-coverage`.
 *
 *   npx dotenvx run -f .env -- tsx scripts/repair-non-album-spotify-urls.ts
 *   npx dotenvx run -f .env -- tsx scripts/repair-non-album-spotify-urls.ts --apply
 *
 * Requires: DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD, and
 * DB_STATEMENT_TIMEOUT_MS well above the 5,000 ms default that
 * `shared/database/src/client.ts` resolves for HTTP callers — this pass full-
 * scans `album_metadata` and probes the flowsheet play log, and every sibling
 * one-off sets 300000 (see `Dockerfile.streaming-url-remediation`).
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
// Imported from sources, not the built `@wxyc/database` / `@wxyc/lml-client`
// packages, for the reason `scripts/backfill-missing-org-members.ts` documents:
// `@wxyc/database`'s barrel pulls the legacy tubafrenzy ETL utilities
// (node-ssh -> native cpu-features) and would block a standalone script run.
import { closeDatabaseConnection, db } from '../shared/database/src/client';
import { intArrayLiteral } from '../shared/database/src/int-array-literal';
import { album_metadata, flowsheet } from '../shared/database/src/schema';
import {
  classifySpotifyUrl,
  buildSpotifyRepairPatch,
  reportedEntityKind,
  REASK_ATTEMPT_CAP,
  countCounterResets,
  type SpotifyUrlCohort,
} from './lib/spotify-album-slot-repair';

interface Candidate {
  album_id: number;
  spotify_url: string;
  spotify_status: string | null;
  streaming_reask_attempts: number;
  /**
   * True iff `spotify_url` is this row's ONLY populated streaming column, so
   * clearing it leaves the row with none. Read for the dry-run report, not for
   * the repair decision — see `countRowsLeftWithNoStreamingUrl`.
   */
  onlyStreamingUrl: boolean;
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Count the albums in `repairIds` whose `flowsheet.spotify_url` inline copy
 * would be promoted by the COALESCE and would then be SERVED — see the unmask
 * warning in this file's header. Reported so the scope decision is made with a
 * number rather than an assumption.
 *
 * The test is `=== 'repair'`, not `!== 'album-slot'`: a foreign-host inline
 * value cannot unmask, because the serve seams
 * (`album-metadata-projection.ts`'s `suppressMislabeledStreamingUrls`,
 * `flowsheet-projection.ts`) already null a non-Spotify host on every read. Only
 * a Spotify-host non-album value passes those host-only checks verbatim, so only
 * that cohort reaches a DJ. Folding the two together would inflate the number
 * the follow-up ticket gets sized from.
 *
 * `DISTINCT` and `= ANY(...::int[])` are both load-bearing. `flowsheet.album_id`
 * is not unique — it is a play log, ~1.2M linked rows — so the undeduped form
 * returns one row per PLAYCUT to build a set whose only consumer is `.size`. And
 * `intArrayLiteral` + `= ANY` is the repo's mandated shape over a bare array
 * (BS#2010, `docs/bulk-update-playbook.md`); a 4,353-element `inArray` binds one
 * parameter each, which is a ~30 KB statement walking toward PG's parameter
 * ceiling.
 */
async function countUnmaskableInlineRows(repairIds: number[]): Promise<number> {
  if (repairIds.length === 0) return 0;
  const idArrayLiteral = intArrayLiteral(repairIds);
  const inline = await db
    .selectDistinct({ album_id: flowsheet.album_id, spotify_url: flowsheet.spotify_url })
    .from(flowsheet)
    .where(and(sql`${flowsheet.album_id} = ANY(${idArrayLiteral}::int[])`, isNotNull(flowsheet.spotify_url)));
  const affected = new Set<number>();
  for (const row of inline) {
    if (row.album_id === null || row.spotify_url === null) continue;
    if (classifySpotifyUrl(row.spotify_url) === 'repair') affected.add(row.album_id);
  }
  return affected.size;
}

/**
 * ANALYZE after a run that wrote. Required by
 * `docs/bulk-update-playbook.md`'s `post-bulk-update-analyze` rule, and not
 * ceremony: this pass moves `spotify_url`'s `null_frac` by ~15% of the populated
 * column and rewrites `spotify_status`, both of which `precheck.ts` reads on
 * every enrichment and `album-metadata-projection.ts` plans against. BS#934 is
 * the cost of skipping it — un-ANALYZEd bulk UPDATEs pushed `/flowsheet/suggest/*`
 * to 5-second timeouts in front of on-air DJs. `jobs/streaming-columns-drain`
 * does the same thing for the same table.
 */
async function analyzeAlbumMetadata(): Promise<void> {
  await db.execute(sql.raw('ANALYZE "wxyc_schema"."album_metadata"'));
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
      apple_music_url: album_metadata.apple_music_url,
      youtube_music_url: album_metadata.youtube_music_url,
      bandcamp_url: album_metadata.bandcamp_url,
      soundcloud_url: album_metadata.soundcloud_url,
    })
    .from(album_metadata)
    .where(isNotNull(album_metadata.spotify_url))
    .orderBy(album_metadata.album_id);
  // The WHERE already excludes NULLs; narrow rather than cast, so a row that
  // somehow arrives NULL is dropped instead of flowing into the predicates as
  // a lie about its own type.
  const rows: Candidate[] = selected.flatMap((row) =>
    row.spotify_url === null
      ? []
      : [
          {
            album_id: row.album_id,
            spotify_url: row.spotify_url,
            spotify_status: row.spotify_status,
            streaming_reask_attempts: row.streaming_reask_attempts,
            onlyStreamingUrl:
              row.apple_music_url === null &&
              row.youtube_music_url === null &&
              row.bandcamp_url === null &&
              row.soundcloud_url === null,
          },
        ]
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
  // Asked of `buildSpotifyRepairPatch` rather than re-deriving `>= CAP` here:
  // the patch omits the counter for an `'absent'` row, so the inline condition
  // promised a reset on rows that never get one.
  console.log(`Of those, re-ask counter at/over the cap (will be cleared to 0): ${countCounterResets(repair)}`);
  const atCapNoReset =
    repair.filter((row) => row.streaming_reask_attempts >= REASK_ATTEMPT_CAP).length - countCounterResets(repair);
  if (atCapNoReset > 0) {
    console.log(`  (a further ${atCapNoReset} are at/over the cap but stay there: terminal 'absent' rows`);
    console.log('   keep both their verdict and their counter — see buildSpotifyRepairPatch)');
  }
  console.log('');

  if (repair.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const unmaskable = await countUnmaskableInlineRows(repair.map((row) => row.album_id));
  console.log(
    `Of those, albums whose flowsheet.spotify_url inline copy is ALSO a non-album Spotify URL: ${unmaskable}`
  );
  console.log('  (nulling album_metadata promotes that value on serve — see this script’s header)');
  console.log('');
  // Clearing `spotify_url` on one of these takes the row to zero populated
  // streaming columns, which trips three separate gates at once:
  // `precheck.ts`'s `hasAnyStreamingUrl` (so the row stops being skippable and
  // re-calls LML on every play), the BS#1924 counter increment, and
  // `album-metadata-projection.ts`'s Gate 1 `carriesWireableStreamingUrl` —
  // after which the flowsheet seams serve all five columns as NULL rather than
  // just this one. An operator needs the size of that before --apply.
  const leftWithNone = repair.filter((row) => row.onlyStreamingUrl).length;
  console.log(`Of those, rows where spotify_url is the ONLY populated streaming column: ${leftWithNone}`);
  console.log('  (clearing it takes the row to zero streaming URLs — flips precheck’s skip gate');
  console.log('   and the projection’s wireable-URL gate; see BS#2295 / BS#1924)');
  console.log('');

  if (!apply) {
    for (const row of repair.slice(0, 20)) {
      console.log(`  sample album_id=${row.album_id}  ${row.spotify_url}`);
    }
    console.log('');
    console.log('Dry run complete. Re-run with --apply to commit.');
    return;
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
        .set({
          ...buildSpotifyRepairPatch(row.spotify_status, row.streaming_reask_attempts),
          updated_at: sql`NOW()`,
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

  // Runs even when some rows failed: the rows that DID land already moved the
  // planner's statistics, so a partial run needs the ANALYZE as much as a clean
  // one does.
  if (updated > 0) await analyzeAlbumMetadata();

  console.log('');
  console.log(`Repaired:                  ${updated}`);
  console.log(`Skipped (changed under us):${skipped}`);
  console.log(`Failed:                    ${failures.length}`);
  // `process.exitCode` rather than `process.exit()`: this script's whole
  // operator interface is its stdout, and an operator runs it under `| tee`.
  // `process.exit()` tears down the process without flushing writes already
  // queued on a pipe, which silently truncated the tail of the report — the
  // sample rows and the completion line — in exactly that invocation.
  process.exitCode = failures.length > 0 ? 1 : 0;
}

// Terminates by closing the pg pool and letting the event loop drain, NOT via
// `process.exit()`. This script's entire operator interface is its stdout and it
// is meant to be run under `| tee`; `process.exit()` tears the process down
// without flushing writes already queued on a pipe, which silently truncated the
// tail of the report — the sample rows and the completion line — in exactly that
// invocation. The pool is why the sibling one-offs reach for `process.exit` at
// all: an open pg pool keeps the loop alive, so the close has to be explicit or
// the script appears to hang after finishing. `finally`, so a fatal error still
// releases the connections.
main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabaseConnection());
