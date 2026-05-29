/**
 * Parity test: the inline `synthesizeSearchUrls` in
 * `jobs/flowsheet-metadata-backfill/enrich.ts` MUST produce the same
 * write-path-eligible search URLs as the canonical `SearchUrlProvider`
 * in `apps/backend/services/metadata/providers/search-urls.provider.ts`
 * (BS#889 / BS#1189).
 *
 * The inline copy exists deliberately — the job's tsup build deliberately
 * doesn't pull in apps/backend (build-graph isolation; see the file
 * header on `enrich.ts` and on `lml-fetch.ts`). The cost of that
 * isolation is silent drift between the two implementations. Three
 * different services historically diverged here, and iOS users saw
 * different Spotify/YouTube/Bandcamp/SoundCloud URLs depending on which
 * BS path enriched the row. This test pins them in lockstep so the next
 * drift fails CI loudly.
 *
 * Asserted shape — the **four** URLs the canonical write path
 * (`metadata.service.fetchMetadata`) actually persists post-BS#1192:
 * `spotify_url`, `youtube_music_url`, `bandcamp_url`, `soundcloud_url`.
 * `appleMusicUrl` is intentionally excluded — `SearchUrlProvider` still
 * exposes it for the read-path proxy (`proxy.controller.getAlbumMetadata`),
 * but it does not flow to durable storage. See BS#1192 for the rationale.
 */

import { synthesizeSearchUrls } from '../../../../jobs/flowsheet-metadata-backfill/enrich';
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
