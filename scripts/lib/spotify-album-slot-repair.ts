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
 *                     `spotify_url`. BS#1710's cohort, owned by
 *                     `jobs/streaming-url-remediation`: relocating a real link
 *                     that landed in the wrong slot is a different decision
 *                     from nulling a wrong-entity one, so this script counts
 *                     these and never writes them.
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
 * The columns a repaired row gets written. Drizzle writes only the keys
 * present, so an ABSENT `spotify_status` means "leave the persisted verdict
 * alone" — which is the whole point of it being optional.
 */
export interface SpotifyRepairPatch {
  spotify_url: null;
  spotify_status?: null;
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
 * **Why NULL and not `'unresolved'`.** NULL is "never consulted", which is the
 * honest state — the value we had was not trustworthy, and we have not asked
 * since. It also matches exactly what the guard lands for a fresh row, so the
 * write path and the corrective pass state one policy rather than two. Per
 * `precheck.ts`, "a NULL status (never-consulted) does not force a re-ask; only
 * an explicit `'unresolved'` does", and that is the point: the upstream defect
 * (WXYC/library-metadata-lookup#1353) is still open, so every re-ask would
 * return the same artist URL, the guard would null it again, and the row would
 * burn all three `streaming_reask_attempts` for nothing — then sit inert at the
 * cap, worse off than if it had never been asked. This is the hazard
 * `isBandcampReaskEnabled`'s doc comment gates against in so many words.
 * NULL still un-pins merge rule 1, so the first play after LML#1353 lands can
 * adopt a real album URL via rule 3.
 *
 * **Why `'absent'` survives.** Merge rule 4 makes `'absent'` terminal
 * specifically so a negative-cached field is never resurrected for re-ask — the
 * BS#1747/#1089 per-play amplifier. Clearing the URL is still right for such a
 * row (an artist page is wrong either way, and `'absent'` + NULL is the
 * canonical negative-cache shape), so the URL goes and the verdict stays.
 *
 * **Why `streaming_reask_attempts` is not here at all.** Resetting an exhausted
 * counter only matters if the row is going to `'unresolved'`, which it is not.
 * Leaving it out also removes a write-back of a minutes-old read: a concurrent
 * enrichment that bumped the counter without changing the URL would otherwise
 * have its increment silently reverted, loosening the very bound #1747 added.
 */
export function buildSpotifyRepairPatch(currentStatus: string | null): SpotifyRepairPatch {
  if (currentStatus === 'absent') return { spotify_url: null };
  return { spotify_url: null, spotify_status: null };
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
