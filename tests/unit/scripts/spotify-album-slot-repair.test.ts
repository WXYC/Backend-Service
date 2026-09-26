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
 *   - a cleared verdict goes to `'unresolved'`, the ONLY value either re-ask
 *     gate selects on. `schema.ts`'s `spotify_status` doc comment states the
 *     vocabulary outright, and `jobs/streaming-columns-drain` — a shipped
 *     one-off over this same column — makes the same call for the same reason.
 *   - `streaming_reask_attempts` is reset ONLY on a row already at/over the
 *     cap, where `'unresolved'` would otherwise be inert, and is otherwise
 *     absent from the patch entirely rather than written back from a stale read.
 */
import { STREAMING_REASK_ATTEMPT_CAP } from '../../../apps/enrichment-worker/enrich';
import {
  classifySpotifyUrl,
  buildSpotifyRepairPatch,
  countCounterResets,
  reportedEntityKind,
  REASK_ATTEMPT_CAP,
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
  // The mirrored cap must equal the real one or the reset arm fires on the
  // wrong rows. Asserted rather than promised — the original copy carried only
  // a comment arguing drift was safe in one direction.
  it('mirrors the enrichment worker\u2019s attempt cap exactly', () => {
    expect(REASK_ATTEMPT_CAP).toBe(STREAMING_REASK_ATTEMPT_CAP);
  });

  it.each([['verified'], ['unresolved'], [null]])(
    "clears the verdict to 'unresolved', the only re-ask-eligible value (was %s)",
    (status) => {
      // NULL would be invisible to both gates: `needsStreamingReask` requires
      // `spotify_status = 'unresolved'`, and `schema.ts` says NULL means never
      // consulted. Leaving NULL freezes the row against the upstream fixes
      // (LML#1355/#1356/#1357) that are landing to make LML return a correct
      // album URL — a re-ask is exactly how the row picks that up, unattended,
      // under the existing bound.
      expect(buildSpotifyRepairPatch(status, 0)).toEqual({
        spotify_url: null,
        spotify_status: 'unresolved',
      });
    }
  );

  it("preserves a terminal 'absent' verdict instead of resurrecting it", () => {
    const patch = buildSpotifyRepairPatch('absent', 0);
    expect(patch.spotify_url).toBeNull();
    // Key absent, not set to null: drizzle only writes columns present in the
    // `set` object, so omitting it leaves the negative cache exactly as-is.
    expect(patch).not.toHaveProperty('spotify_status');
    expect(patch).not.toHaveProperty('streaming_reask_attempts');
  });

  it.each([[0], [1], [REASK_ATTEMPT_CAP - 1]])(
    'leaves an under-cap counter out of the patch entirely (attempts=%s)',
    (attempts) => {
      // Omitted, not written back: the value was read minutes earlier, so
      // re-asserting it would silently revert a concurrent increment and
      // loosen the #1747 bound.
      expect(buildSpotifyRepairPatch('verified', attempts)).not.toHaveProperty('streaming_reask_attempts');
    }
  );

  it.each([[REASK_ATTEMPT_CAP], [REASK_ATTEMPT_CAP + 5]])(
    "resets an exhausted counter so 'unresolved' is not inert (attempts=%s)",
    (attempts) => {
      // Both gates require `streaming_reask_attempts < CAP`, so on an already
      // exhausted row `'unresolved'` alone selects nothing.
      expect(buildSpotifyRepairPatch('verified', attempts)).toEqual({
        spotify_url: null,
        spotify_status: 'unresolved',
        streaming_reask_attempts: 0,
      });
    }
  );

  it("never resets an exhausted counter on an 'absent' row", () => {
    // Rule 4 keeps the verdict terminal, so granting fresh attempts would only
    // spend the shared per-album budget on the other two services.
    expect(buildSpotifyRepairPatch('absent', REASK_ATTEMPT_CAP + 1)).toEqual({ spotify_url: null });
  });
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

describe('countCounterResets', () => {
  // The dry run prints this number under "will be cleared to 0" and an operator
  // reads it before committing ~4,353 UPDATEs. The CLI used to compute it
  // inline as `attempts >= CAP`, which over-reported: `buildSpotifyRepairPatch`
  // omits the counter for an `'absent'` row, so an exhausted `'absent'` row was
  // counted as a reset that never happens. Deriving the count FROM the patch
  // builder makes the two incapable of drifting.
  it('counts only rows whose patch actually carries the reset', () => {
    const rows = [
      { spotify_status: 'verified', streaming_reask_attempts: STREAMING_REASK_ATTEMPT_CAP },
      { spotify_status: 'unresolved', streaming_reask_attempts: STREAMING_REASK_ATTEMPT_CAP + 2 },
      { spotify_status: null, streaming_reask_attempts: STREAMING_REASK_ATTEMPT_CAP },
    ];
    expect(countCounterResets(rows)).toBe(3);
  });

  it('excludes an exhausted absent row, whose patch omits the counter', () => {
    const rows = [{ spotify_status: 'absent', streaming_reask_attempts: STREAMING_REASK_ATTEMPT_CAP + 5 }];
    expect(buildSpotifyRepairPatch('absent', STREAMING_REASK_ATTEMPT_CAP + 5)).not.toHaveProperty(
      'streaming_reask_attempts'
    );
    expect(countCounterResets(rows)).toBe(0);
  });

  it('excludes rows under the cap regardless of status', () => {
    const rows = [
      { spotify_status: 'verified', streaming_reask_attempts: 0 },
      { spotify_status: 'unresolved', streaming_reask_attempts: STREAMING_REASK_ATTEMPT_CAP - 1 },
      { spotify_status: 'absent', streaming_reask_attempts: 1 },
    ];
    expect(countCounterResets(rows)).toBe(0);
  });

  it('is zero for an empty cohort', () => {
    expect(countCounterResets([])).toBe(0);
  });
});
