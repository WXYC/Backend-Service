/**
 * Unit tests for the pure half of `scripts/repair-non-album-spotify-urls.ts`
 * (BS#2689): which cohort a persisted `album_metadata.spotify_url` falls in,
 * and what a repaired row is allowed to have written to it.
 *
 * These exist because `scripts/**` is outside BOTH quality gates — it is in
 * `eslint.config.mjs`'s global ignore list, and `npm run typecheck` spans only
 * `@wxyc/database` + `shared/**` + `apps/**`. So for a file that issues UPDATEs
 * against prod, a unit test is the only thing between a future edit and a
 * silently wrong write.
 *
 * The invariants pinned here are not stylistic. Each one corresponds to a rule
 * `apps/enrichment-worker/enrich.ts`'s `mergeStreamingField` enforces on the
 * live path, which this script bypasses by writing SQL directly:
 *
 *   - `'absent'` is terminal (merge rule 4) — never downgraded to
 *     `'unresolved'`, or the row is resurrected for re-ask and the
 *     BS#1747/#1089 per-play amplifier comes back.
 *   - `streaming_reask_attempts` is never written, so the re-ask bound cannot
 *     be loosened by a stale read.
 *   - a cleared verdict goes to NULL ("never consulted"), not `'unresolved'`,
 *     matching what the guard itself lands for a fresh row.
 */
import {
  classifySpotifyUrl,
  buildSpotifyRepairPatch,
  reportedEntityKind,
} from '../../../scripts/lib/spotify-album-slot-repair';

describe('classifySpotifyUrl', () => {
  it.each([
    ['plain album page', 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo'],
    ['locale-prefixed album', 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo'],
    ['synthesized search fallback', 'https://open.spotify.com/search/Jessica%20Pratt'],
  ])('leaves a legitimate album-slot value alone (%s)', (_label, url) => {
    expect(classifySpotifyUrl(url)).toBe('album-slot');
  });

  it.each([
    ['artist page (the reported defect)', 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7'],
    ['track page', 'https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M'],
    ['bare /album with no id', 'https://open.spotify.com/album'],
  ])('marks a Spotify-host non-album value for repair (%s)', (_label, url) => {
    expect(classifySpotifyUrl(url)).toBe('repair');
  });

  // BS#1710's cohort, owned by `jobs/streaming-url-remediation`. This script
  // counts them and never writes them — relocating a foreign link is a
  // different decision than nulling a wrong-entity one.
  it.each([
    ['Deezer album URL', 'https://www.deezer.com/album/254381182'],
    ['host-suffix spoof', 'https://spotify.com.evil.example/album/abc'],
    ['not a URL at all', 'not a url'],
  ])('routes a foreign-host value away from the repair set (%s)', (_label, url) => {
    expect(classifySpotifyUrl(url)).toBe('foreign-host');
  });
});

describe('buildSpotifyRepairPatch', () => {
  it.each([['verified'], ['unresolved'], [null]])("clears the verdict to NULL, not 'unresolved' (was %s)", (status) => {
    // NULL is "never consulted": `precheck.ts` does not force a re-ask on it,
    // so the row costs no LML calls while upstream LML#1353 is still serving
    // artist URLs, and `mergeStreamingField` rule 1 no longer pins it — a
    // later genuine 'verified' can adopt a real album URL (rule 3).
    // `'unresolved'` would instead spend all three re-ask attempts against an
    // upstream with no better answer and then leave the row inert.
    expect(buildSpotifyRepairPatch(status)).toEqual({ spotify_url: null, spotify_status: null });
  });

  it("preserves a terminal 'absent' verdict instead of resurrecting it", () => {
    const patch = buildSpotifyRepairPatch('absent');
    expect(patch.spotify_url).toBeNull();
    // Key absent, not set to null: drizzle only writes columns present in the
    // `set` object, so omitting it leaves the negative cache exactly as-is.
    expect(patch).not.toHaveProperty('spotify_status');
  });

  it.each([['verified'], ['absent'], [null]])(
    'never writes streaming_reask_attempts, so the re-ask bound cannot loosen (was %s)',
    (status) => {
      expect(buildSpotifyRepairPatch(status)).not.toHaveProperty('streaming_reask_attempts');
    }
  );
});

describe('reportedEntityKind', () => {
  it.each([
    ['https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7', '/artist/'],
    ['https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M', '/track/'],
    // The locale segment is skipped for the same reason the predicate skips it,
    // so the operator's breakdown reads by entity and not by locale.
    ['https://open.spotify.com/intl-fr/artist/7CaUk9xCxdXAmmqQn3PLR7', '/artist/'],
    ['https://open.spotify.com/album', '/album (no id)'],
    ['https://open.spotify.com/', '(no path)'],
    ['not a url', '(unparseable)'],
  ])('labels %s as %s', (url, expected) => {
    expect(reportedEntityKind(url)).toBe(expected);
  });
});
