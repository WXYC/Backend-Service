/**
 * Parity test: the inline `synthesizeSearchUrls` in
 * `jobs/flowsheet-artwork-repair/repair.ts` MUST produce identical
 * output to the canonical `SearchUrlProvider.getAllSearchUrls` in
 * `apps/backend/services/metadata/providers/search-urls.provider.ts`
 * for the same inputs (BS#889).
 *
 * The inline copy exists deliberately — the job's tsup build deliberately
 * doesn't pull in apps/backend (build-graph isolation; see the file
 * header on `repair.ts`). The cost of that isolation is silent drift
 * between the two implementations. This test pins them in lockstep so
 * the next drift fails CI loudly. Mirrors the sibling parity test under
 * `tests/unit/jobs/flowsheet-metadata-backfill/`.
 *
 * Asserted shape — the four URLs the canonical write path persists
 * post-BS#1192: `spotify_url`, `youtube_music_url`, `bandcamp_url`,
 * `soundcloud_url`. `apple_music_url` is excluded — null is load-bearing
 * "no verified iTunes match" on the write path (the read-path proxy
 * synthesizes a search URL when needed).
 */

import { synthesizeSearchUrls } from '../../../../jobs/flowsheet-artwork-repair/repair';
import { SearchUrlProvider } from '../../../../apps/backend/services/metadata/providers/search-urls.provider';

describe('synthesizeSearchUrls parity with SearchUrlProvider', () => {
  const canonical = new SearchUrlProvider();

  type Case = { name: string; artist: string; album: string | null; track: string | null };
  const cases: Case[] = [
    { name: 'full track + album + artist', artist: 'Juana Molina', album: 'DOGA', track: 'la paradoja' },
    { name: 'no track, album present', artist: 'Stereolab', album: 'Dots and Loops', track: null },
    { name: 'no album, track present', artist: 'Autechre', album: null, track: 'VI Scose Poise' },
    { name: 'artist only', artist: 'Chuquimamani-Condori', album: null, track: null },
    { name: 'diacritics in artist', artist: 'Nilüfer Yanya', album: 'Painless', track: 'stabilise' },
    { name: 'diacritics + nothing else', artist: 'Hermanos Gutiérrez', album: null, track: null },
    { name: 'spaces + ampersand in artist', artist: 'Duke Ellington & John Coltrane', album: null, track: null },
  ];

  it.each(cases)('$name', ({ artist, album, track }) => {
    const inline = synthesizeSearchUrls({
      id: 0,
      artist_name: artist,
      album_title: album,
      track_title: track,
    });
    const canonicalOut = canonical.getAllSearchUrls(artist, album ?? undefined, track ?? undefined);

    expect(inline.spotify_url).toBe(canonicalOut.spotifyUrl);
    expect(inline.youtube_music_url).toBe(canonicalOut.youtubeMusicUrl);
    expect(inline.bandcamp_url).toBe(canonicalOut.bandcampUrl);
    expect(inline.soundcloud_url).toBe(canonicalOut.soundcloudUrl);
  });
});
