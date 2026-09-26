/**
 * The pure decisions behind `scripts/repair-non-album-spotify-urls.ts`
 * (BS#2689), split out so they carry unit tests — see
 * `tests/unit/scripts/spotify-album-slot-repair.test.ts`. `scripts/**` sits
 * outside eslint's scope and outside `npm run typecheck`'s workspace list, so
 * for a file that UPDATEs prod the test is the only gate there is.
 *
 * Same split as `scripts/lib/headliner-export.ts`: the script keeps the IO and
 * the SQL, this keeps the judgement.
 */
import { isSpotifyUrl, isSpotifyAlbumSlotUrl } from '../../shared/lml-client/src/streaming-url-guard';

/**
 * Which of the three disjoint cohorts a persisted `album_metadata.spotify_url`
 * value falls in.
 *
 *   - `album-slot`  — an `/album/<id>` (optionally locale-prefixed) or a
 *                     `/search…` page. Correct; left alone.
 *   - `repair`      — on the Spotify host but naming some other entity (an
 *                     artist page, a track, a bare `/album`). BS#2689's cohort.
 *   - `foreign-host`— not a Spotify URL at all, e.g. a Deezer link filed under
 *                     `spotify_url`. BS#1710's cohort: relocating a real link
 *                     that landed in the wrong slot is a different decision
 *                     from nulling a wrong-entity one, so this script counts
 *                     these and never writes them.
 *
 * "Counted, not written" is the honest description of the `foreign-host` cohort
 * — do NOT read it as "handled elsewhere". `jobs/streaming-url-remediation` is
 * the closest owner but its SQL net is `spotify_url NOT ILIKE '%spotify.com%'`,
 * which structurally cannot select a value that CONTAINS that substring, so two
 * sub-populations this cohort holds are outside it: a suffix spoof
 * (`spotify.com.evil.example/album/…`, which that job's README explicitly puts
 * out of scope) and a backslash-authority value (rejected by `safeHostname`,
 * yet containing the apex). Those sit in prod with no owner. Reported here so
 * the number exists; not fixed here, because relocation is that job's contract.
 *
 * Decided by the SAME predicate the write-path guard uses, imported rather than
 * re-approximated in SQL, so the two cannot drift.
 */
export type SpotifyUrlCohort = 'album-slot' | 'foreign-host' | 'repair';

export function classifySpotifyUrl(url: string): SpotifyUrlCohort {
  if (isSpotifyAlbumSlotUrl(url)) return 'album-slot';
  return isSpotifyUrl(url) ? 'repair' : 'foreign-host';
}

/**
 * Mirrors `STREAMING_REASK_ATTEMPT_CAP` in `apps/enrichment-worker/enrich.ts`,
 * which is the source of truth. Copied rather than imported because importing it
 * would execute the enrichment worker's module graph (LML client, Sentry,
 * PostHog) inside a one-off script. The copy is not trusted on faith — the unit
 * test imports BOTH and asserts they are equal, so drift fails CI rather than
 * silently resetting the counter on the wrong rows.
 */
export const REASK_ATTEMPT_CAP = 3;

/**
 * The columns a repaired row gets written. Drizzle writes only the keys
 * present, so an ABSENT key means "leave that column alone" — which is the
 * whole point of both optional fields.
 */
export interface SpotifyRepairPatch {
  spotify_url: null;
  spotify_status?: 'unresolved';
  streaming_reask_attempts?: 0;
}

/**
 * Build the patch for one row whose `spotify_url` is being cleared.
 *
 * TWO columns, and the second one only sometimes. Both halves are constrained
 * by `mergeStreamingField` in `apps/enrichment-worker/enrich.ts`, whose rules
 * this script bypasses by issuing SQL directly and therefore has to honor by
 * hand.
 *
 * **Why the verdict must not stay as it is.** These rows are typically
 * `'verified'`, and merge rule 1 never revisits a `'verified'` field — so
 * `spotify_url = NULL` beside `spotify_status = 'verified'` is an album with no
 * Spotify link that nothing will ever reconsider. That is the BS#1747/#1915
 * permanent-null freeze, and it is the same failure the guard avoids by
 * deleting `streaming_status.spotify` rather than only nulling the URL.
 *
 * **Why `'unresolved'` and not NULL.** `'unresolved'` is the ONLY value either
 * re-ask gate selects on. `streaming-reask.ts`'s `needsStreamingReask` requires
 * `spotify_status = 'unresolved'` (under `streaming_reask_attempts < CAP`), and
 * `schema.ts`'s own `spotify_status` doc comment spells the vocabulary out: NULL
 * means "never consulted" and "must NOT be treated as `absent`", but neither is
 * it re-ask-eligible. A NULLed row therefore asks nothing, ever. That matters
 * because the upstream defect is being FIXED, not merely acknowledged —
 * WXYC/library-metadata-lookup#1355, #1356 and #1357 are landing to make LML
 * return a correct Spotify album URL or an honest null instead of an artist
 * page. A row left `'unresolved'` picks that corrected link up unattended, via
 * merge rule 3, inside the existing bound; a row left NULL is frozen against
 * exactly the improvement the rest of this work delivers.
 *
 * This is also the call `jobs/streaming-columns-drain` already made for this
 * same column, in the same situation, and its comment is the whole argument:
 * "hand it to the bounded sweep rather than leaving a NULL that nothing will
 * ever re-ask." This pass now agrees with that drain instead of contradicting
 * it.
 *
 * **Why the counter reset is conditional.** Both gates also require
 * `streaming_reask_attempts < CAP`, so on a row already at or over the cap
 * `'unresolved'` is inert — the status would be a lie about what happens next.
 * Those rows get the counter cleared to 0. Rows under the cap do NOT: the key is
 * omitted from the patch entirely rather than written back, because the value
 * was read minutes earlier and re-asserting it would silently revert a
 * concurrent increment, loosening the very bound #1747 added. (The counter is
 * per-album, shared across the three services, so clearing an exhausted one does
 * grant apple/bandcamp a fresh bounded budget on that row; that is the narrowest
 * available instrument, and it stays bounded.)
 *
 * **Why `'absent'` survives.** Merge rule 4 makes `'absent'` terminal
 * specifically so a negative-cached field is never resurrected for re-ask — the
 * BS#1747/#1089 per-play amplifier. Clearing the URL is still right for such a
 * row (an artist page is wrong either way), so the URL goes and the verdict
 * stays — and with it the counter, since granting fresh attempts to a terminal
 * row would only spend the shared per-album budget on the other two services.
 *
 * An earlier draft called `'absent'` + NULL "the canonical negative-cache
 * shape". It is not the shape the LIVE path writes: `buildStreamingFieldConflictSet`'s
 * absent branch sets `url` to the synthesized search fallback for every service
 * that has one, so an `'absent'` Spotify row written by the worker carries a
 * search URL. Clearing to NULL here is still correct, for a different and better
 * reason — `proxy.controller.ts` re-synthesizes all five search URLs at REQUEST
 * time for any falsy column, so the DJ still gets a working Spotify search link
 * off a NULL, and BS#1192's invariant as that file states it is precisely "don't
 * persist synth URLs in album_metadata". Writing the fallback from a one-off
 * script would persist one. NULL is the conservative write, not a degraded one.
 */
export function buildSpotifyRepairPatch(currentStatus: string | null, currentAttempts: number): SpotifyRepairPatch {
  if (currentStatus === 'absent') return { spotify_url: null };
  const patch: SpotifyRepairPatch = { spotify_url: null, spotify_status: 'unresolved' };
  if (currentAttempts >= REASK_ATTEMPT_CAP) patch.streaming_reask_attempts = 0;
  return patch;
}

/**
 * How many rows in a cohort will actually have their re-ask counter reset.
 *
 * Derived by asking {@link buildSpotifyRepairPatch}, not by re-deriving its
 * `attempts >= CAP` condition — the dry run prints this under "will be cleared
 * to 0" and an operator reads it before committing thousands of UPDATEs, so the
 * reported number and the written patch must be incapable of disagreeing. The
 * inline version over-reported: the patch omits the counter entirely for an
 * `'absent'` row (see that function's "Why `'absent'` survives"), so an
 * exhausted `'absent'` row was counted as a reset that never happens.
 */
export function countCounterResets(
  rows: readonly { spotify_status: string | null; streaming_reask_attempts: number }[]
): number {
  return rows.filter(
    (row) => buildSpotifyRepairPatch(row.spotify_status, row.streaming_reask_attempts).streaming_reask_attempts !== undefined
  ).length;
}

/**
 * The Spotify entity a URL names (`/artist/`, `/track/`, …), for the dry-run
 * breakdown ONLY — this is the material for BS#2689's post-fix re-count of the
 * ticket's shape table. The keep-or-clear decision is
 * {@link classifySpotifyUrl}'s alone; this returns a label even for shapes that
 * predicate has no opinion about.
 *
 * Skips a leading `intl-` locale segment on the same over-accepting rule
 * `isSpotifyAlbumSlotUrl` uses, so the breakdown reads by entity rather than
 * splitting one entity across locales.
 */
export function reportedEntityKind(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '(unparseable)';
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments[0]?.toLowerCase().startsWith('intl-')) segments.shift();
  if (segments.length === 0) return '(no path)';
  return segments.length === 1 ? `/${segments[0]} (no id)` : `/${segments[0]}/`;
}
