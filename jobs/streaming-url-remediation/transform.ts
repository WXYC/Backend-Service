/**
 * Per-row host-guard arbiter for the streaming-URL remediation (BS#1715).
 *
 * BS#1710 established that a value persisted under `spotify_url` must be a
 * Spotify host and a value under `apple_music_url` must be an Apple host
 * (`@wxyc/lml-client` `isSpotifyUrl` / `isAppleMusicUrl`). The ingestion guard
 * (#1712) and the read-time serve-seam guard (#1714) protect new writes and
 * live reads, but BS persistence is fill-only, so rows persisted *before* the
 * guard shipped keep their mislabeled value forever — a Deezer/Apple/Bandcamp
 * URL sitting in the green "Spotify" button slot. This module is the durable
 * data fix: for a candidate row it recomputes both columns so each holds only
 * a host-correct value, relocating a real link that landed in the wrong slot.
 *
 * The transform is symmetric and self-recovering:
 *
 *   - `spotify_url` keeps its value iff that value is a Spotify host; else it
 *     adopts `apple_music_url`'s value iff *that* is a Spotify host (a Spotify
 *     link mis-filed in the apple slot); else it becomes null.
 *   - `apple_music_url` is the mirror image.
 *
 * Worked cases (all verified idempotent — re-running a fixed row is a no-op
 * because a host-correct value is never re-selected by the candidate net):
 *
 *   | before spotify        | before apple          | after spotify     | after apple       |
 *   | music.apple.com/X     | null                  | null              | music.apple.com/X | ← relocate
 *   | music.apple.com/X     | music.apple.com/Y     | null              | music.apple.com/Y | ← keep real apple, drop dupe
 *   | deezer.com/X          | null                  | null              | null              | ← unrecoverable, clear
 *   | deezer.com/X          | music.apple.com/Y     | null              | music.apple.com/Y | ← clear foreign, keep apple
 *   | null                  | open.spotify.com/X    | open.spotify.com/X| null              | ← relocate the other way
 *   | open.spotify.com/X    | null                  | open.spotify.com/X| null              | ← already correct (no-op)
 *
 * The relocation target is decided by the SAME guard the candidate net and
 * the post-run verification use, so a row's verdict can never drift between
 * the SELECT that picks it up and the assertion that it was healed.
 *
 * A null result on a slot is deliberate: the read path (`/proxy/metadata` and
 * the serve seam) synthesizes an `open.spotify.com/search/…` fallback for a
 * null `spotify_url`, so nulling a foreign value restores correct behavior
 * rather than leaving a dead button.
 */
import { isSpotifyUrl, isAppleMusicUrl } from '@wxyc/lml-client';

/**
 * The apex-host substrings the coarse SQL candidate net keys on. A row is a
 * candidate iff a non-null `spotify_url` does NOT contain `spotify.com`
 * (case-insensitive) or a non-null `apple_music_url` does NOT contain
 * `apple.com`. These are a superset of what the guard rejects for the
 * whole-domain pollution that exists in prod (Deezer/Apple/Bandcamp/Tidal in
 * the wrong slot); they intentionally do NOT catch suffix-spoofs like
 * `spotify.com.evil.example` (which *contain* the substring) — those are
 * absent from prod historically and are covered at read time by #1714. The
 * per-row guard below is the true arbiter within this net; the substrings
 * only bound the scan.
 */
export const SPOTIFY_HOST_SUBSTR = 'spotify.com';
export const APPLE_HOST_SUBSTR = 'apple.com';

export interface StreamingUrlRow {
  spotify_url: string | null;
  apple_music_url: string | null;
}

export interface StreamingUrlFix {
  spotify_url: string | null;
  apple_music_url: string | null;
  /** True iff either column's value changed — the row needs an UPDATE. */
  changed: boolean;
}

/**
 * Recompute a row's two streaming columns so each holds only a host-correct
 * value, relocating a real link out of the wrong slot. Pure: no I/O, imports
 * only the host guards, so it is exhaustively unit-testable and shares its
 * "is this host correct" verdict with the SQL net and the verifier.
 */
export const computeStreamingUrlFix = (row: StreamingUrlRow): StreamingUrlFix => {
  const s = row.spotify_url;
  const a = row.apple_music_url;
  const spotify = isSpotifyUrl(s) ? s : isSpotifyUrl(a) ? a : null;
  const apple = isAppleMusicUrl(a) ? a : isAppleMusicUrl(s) ? s : null;
  return {
    spotify_url: spotify,
    apple_music_url: apple,
    changed: spotify !== s || apple !== a,
  };
};
