/**
 * Parity test: the inline `synthesizeSearchUrls` in
 * `apps/enrichment-worker/enrich.ts` MUST produce identical output to the
 * canonical `SearchUrlProvider.getAllSearchUrls` in
 * `apps/backend/services/metadata/providers/search-urls.provider.ts`
 * for the same inputs (BS#889).
 *
 * The inline copy exists for the same build-graph-isolation reason as the
 * backfill's: `apps/enrichment-worker` is bundled independently of
 * `apps/backend`. The cost of that isolation is silent drift between the
 * two implementations — historically three different services diverged
 * here, and iOS users saw different YouTube/Bandcamp/SoundCloud URLs
 * depending on which BS path enriched the row. This test pins them in
 * lockstep so the next drift fails CI loudly.
 *
 * Sibling test:
 *   - `tests/unit/jobs/flowsheet-metadata-backfill/synthesize-search-urls-parity.test.ts`
 */

import { synthesizeSearchUrls } from '../../../../apps/enrichment-worker/enrich';
import { SearchUrlProvider } from '../../../../apps/backend/services/metadata/providers/search-urls.provider';

describe('synthesizeSearchUrls parity (enrichment-worker inline ↔ SearchUrlProvider)', () => {
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

    expect(inline.youtube_music_url).toBe(canonicalOut.youtubeMusicUrl);
    expect(inline.bandcamp_url).toBe(canonicalOut.bandcampUrl);
    expect(inline.soundcloud_url).toBe(canonicalOut.soundcloudUrl);
  });
});
