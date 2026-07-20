/**
 * Unit tests for the streaming-URL remediation transform (BS#1715).
 *
 * `computeStreamingUrlFix` is the pure host-guard arbiter the remediation job
 * applies to every candidate row: it recomputes `spotify_url` / `apple_music_url`
 * so each column holds only a host-correct value, relocating a real link that
 * landed in the wrong slot and nulling an unrecoverable foreign value. These
 * tests pin the full truth table plus the property the whole job depends on:
 * a row the transform has already fixed is a no-op on re-run (idempotency).
 *
 * URLs use WXYC-representative artists per the org fixture convention.
 */

import { computeStreamingUrlFix, type StreamingUrlRow } from '../../../../jobs/streaming-url-remediation/transform';

// Real host shapes drawn from the BS#1710 pollution: a foreign provider (Deezer,
// Bandcamp, Tidal) or an Apple URL sitting under the `spotify_url` column.
const SPOTIFY = 'https://open.spotify.com/album/1JuanaMolinaDOGA';
const SPOTIFY_ALT = 'https://open.spotify.com/track/2JessicaPrattBackBaby';
const APPLE = 'https://music.apple.com/us/album/doga/1JuanaMolina';
const APPLE_ALT = 'https://music.apple.com/us/album/on-your-own-love-again/2JessicaPratt';
const DEEZER = 'https://www.deezer.com/album/1234567';
const BANDCAMP = 'https://juanamolina.bandcamp.com/album/doga';

describe('computeStreamingUrlFix: host-correct pass-through', () => {
  it('leaves a correctly-labeled pair untouched (no change)', () => {
    const fix = computeStreamingUrlFix({ spotify_url: SPOTIFY, apple_music_url: APPLE });
    expect(fix).toEqual({ spotify_url: SPOTIFY, apple_music_url: APPLE, changed: false });
  });

  it('leaves a Spotify-only row untouched', () => {
    const fix = computeStreamingUrlFix({ spotify_url: SPOTIFY, apple_music_url: null });
    expect(fix).toEqual({ spotify_url: SPOTIFY, apple_music_url: null, changed: false });
  });

  it('leaves an all-null row untouched', () => {
    const fix = computeStreamingUrlFix({ spotify_url: null, apple_music_url: null });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: null, changed: false });
  });
});

describe('computeStreamingUrlFix: relocation (real link in the wrong slot)', () => {
  it('relocates an Apple URL out of the spotify slot into an empty apple slot', () => {
    // The exact BS#1710 shape: LML stored an Apple link under spotify_url and
    // the apple slot was empty. Move it; the (now-null) spotify slot lets the
    // read path synthesize the open.spotify.com/search fallback.
    const fix = computeStreamingUrlFix({ spotify_url: APPLE, apple_music_url: null });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: APPLE, changed: true });
  });

  it('relocates a Spotify URL out of the apple slot into an empty spotify slot', () => {
    const fix = computeStreamingUrlFix({ spotify_url: null, apple_music_url: SPOTIFY });
    expect(fix).toEqual({ spotify_url: SPOTIFY, apple_music_url: null, changed: true });
  });

  it('swaps a fully transposed pair back into the right columns', () => {
    const fix = computeStreamingUrlFix({ spotify_url: APPLE, apple_music_url: SPOTIFY });
    expect(fix).toEqual({ spotify_url: SPOTIFY, apple_music_url: APPLE, changed: true });
  });
});

describe('computeStreamingUrlFix: keep the real value, drop the misfiled duplicate', () => {
  it('nulls an Apple-in-spotify value when a distinct real apple value already exists', () => {
    // 2,535 prod rows: apple URL in the spotify slot AND a *different* apple URL
    // in the apple slot. The apple slot is authoritative; the spotify slot is
    // just a mislabeled apple dupe → null it (no Spotify link is recoverable).
    const fix = computeStreamingUrlFix({ spotify_url: APPLE, apple_music_url: APPLE_ALT });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: APPLE_ALT, changed: true });
  });

  it('nulls a Spotify-in-apple value when a distinct real spotify value already exists', () => {
    const fix = computeStreamingUrlFix({ spotify_url: SPOTIFY, apple_music_url: SPOTIFY_ALT });
    expect(fix).toEqual({ spotify_url: SPOTIFY, apple_music_url: null, changed: true });
  });
});

describe('computeStreamingUrlFix: unrecoverable foreign hosts', () => {
  it('nulls a Deezer URL in the spotify slot with nothing to recover', () => {
    const fix = computeStreamingUrlFix({ spotify_url: DEEZER, apple_music_url: null });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: null, changed: true });
  });

  it('nulls a foreign spotify value but keeps a real apple value', () => {
    const fix = computeStreamingUrlFix({ spotify_url: DEEZER, apple_music_url: APPLE });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: APPLE, changed: true });
  });

  it('nulls a Bandcamp URL in the spotify slot', () => {
    const fix = computeStreamingUrlFix({ spotify_url: BANDCAMP, apple_music_url: null });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: null, changed: true });
  });

  it('nulls foreign values in both slots', () => {
    const fix = computeStreamingUrlFix({ spotify_url: DEEZER, apple_music_url: BANDCAMP });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: null, changed: true });
  });

  it('nulls an empty-string value (never a valid host)', () => {
    const fix = computeStreamingUrlFix({ spotify_url: '', apple_music_url: null });
    expect(fix).toEqual({ spotify_url: null, apple_music_url: null, changed: true });
  });
});

describe('computeStreamingUrlFix: idempotency', () => {
  // The whole batched-drain design relies on this: applying the fix a second
  // time must be a no-op, because a fixed row is never re-selected by the
  // candidate net and, if it somehow were, must not thrash.
  const cases: Array<[string, StreamingUrlRow]> = [
    ['apple-in-spotify, empty apple', { spotify_url: APPLE, apple_music_url: null }],
    ['apple-in-spotify, distinct apple', { spotify_url: APPLE, apple_music_url: APPLE_ALT }],
    ['deezer, nothing to recover', { spotify_url: DEEZER, apple_music_url: null }],
    ['foreign spotify, real apple', { spotify_url: DEEZER, apple_music_url: APPLE }],
    ['transposed pair', { spotify_url: APPLE, apple_music_url: SPOTIFY }],
    ['empty string', { spotify_url: '', apple_music_url: null }],
  ];

  it.each(cases)('is a fixed point after one application: %s', (_label, row) => {
    const first = computeStreamingUrlFix(row);
    const second = computeStreamingUrlFix({
      spotify_url: first.spotify_url,
      apple_music_url: first.apple_music_url,
    });
    expect(second.changed).toBe(false);
    expect(second.spotify_url).toBe(first.spotify_url);
    expect(second.apple_music_url).toBe(first.apple_music_url);
  });
});
