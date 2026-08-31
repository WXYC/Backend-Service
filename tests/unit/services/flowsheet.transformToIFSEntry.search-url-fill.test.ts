import { transformToIFSEntry, type FSEntryRaw } from '../../../apps/backend/services/flowsheet.service';

/**
 * #2339. `transformToIFSEntry` is one of the TWO read-GET seams that fill an
 * absent streaming URL with a synthesized search URL — it builds the IFSEntry
 * behind both `GET /flowsheet` (top-level fields) and `/v2/flowsheet`
 * (`transformToV2`, nested `metadata`), so a single fill covers both. The other
 * seam is `applyPlaycutMetadata` in `playlist-proxy.service.ts` (legacy `?v=2`).
 *
 * It is NOT the single producer of every flowsheet-shaped payload, and the two
 * other producers deliberately do not fill: the mutation/peek echoes go through
 * `projectFlowsheetEntry` and the SSE `liveFs:update` channel through
 * `pickClientFacingColumns` (both in `utils/flowsheet-projection.ts`, both
 * allow-list projections straight off the DB/CDC row, neither routing through
 * `transformToIFSEntry`). That is safe because the fill is GATED: it only fires
 * on rows that already carry a real streaming URL, so the only bit shipped iOS
 * 3.2 branches on (`inline.streaming.hasAny`) is identical across producers for
 * the same row — only button decoration differs.
 *
 * The fill mirrors `GET /proxy/metadata/album`'s degradation (BS#1184/#1185)
 * for rows that qualify, and preserves NULLs (and the client's live proxy
 * fallback) for rows that don't.
 */

const makeRaw = (overrides: Partial<FSEntryRaw> = {}): FSEntryRaw => ({
  id: 1,
  show_id: 100,
  album_id: null,
  entry_type: 'track',
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  track_position: null,
  record_label: 'Sonamos',
  label_id: null,
  rotation_id: null,
  rotation_bin: null,
  artist_id: null,
  request_flag: false,
  segue: false,
  message: null,
  play_order: 1,
  legacy_entry_id: null,
  legacy_release_id: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  dj_name: null,
  linkage_source: null,
  linkage_confidence: null,
  linked_at: null,
  artwork_url: null,
  discogs_url: null,
  release_year: null,
  spotify_url: null,
  apple_music_url: null,
  youtube_music_url: null,
  bandcamp_url: null,
  soundcloud_url: null,
  artist_bio: null,
  artist_wikipedia_url: null,
  genres: null,
  styles: null,
  on_streaming: null,
  discogs_unavailable: null,
  discogs_unavailable_note: null,
  metadata_status: 'enriched_no_match',
  enriching_since: null,
  radio_hour: null,
  ...overrides,
});

describe('transformToIFSEntry streaming-URL search-url fill (#2339)', () => {
  // A row that already carries a real streaming URL short-circuits iOS 3.2's
  // inline gate regardless of what we do, so filling it only upgrades grey
  // buttons. `youtube_music_url` here stands in for the post-#2295-drain
  // cohort, which carries exactly these synthesized YT/Bandcamp/SoundCloud
  // URLs and NULL Spotify/Apple.
  it('fills the absent streaming URLs on a row that already carries one, on both the top-level fields and nested metadata', () => {
    const verifiedYoutube = 'https://music.youtube.com/playlist?list=OLAK5uy_verified';
    const entry = transformToIFSEntry(makeRaw({ youtube_music_url: verifiedYoutube }));

    const expected = {
      spotify_url: 'https://open.spotify.com/search/Juana%20Molina%20la%20paradoja',
      apple_music_url: 'https://music.apple.com/search?term=Juana%20Molina%20la%20paradoja',
      bandcamp_url: 'https://bandcamp.com/search?q=Juana%20Molina%20DOGA',
      soundcloud_url: 'https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja',
    };

    expect(entry.spotify_url).toBe(expected.spotify_url);
    expect(entry.apple_music_url).toBe(expected.apple_music_url);
    expect(entry.bandcamp_url).toBe(expected.bandcamp_url);
    expect(entry.soundcloud_url).toBe(expected.soundcloud_url);
    // The verified value wins untouched — the fill only fills absences.
    expect(entry.youtube_music_url).toBe(verifiedYoutube);

    expect(entry.metadata.spotify_url).toBe(expected.spotify_url);
    expect(entry.metadata.apple_music_url).toBe(expected.apple_music_url);
    expect(entry.metadata.bandcamp_url).toBe(expected.bandcamp_url);
    expect(entry.metadata.soundcloud_url).toBe(expected.soundcloud_url);
    expect(entry.metadata.youtube_music_url).toBe(verifiedYoutube);
  });

  // THE GATE. Shipped iOS 3.2's `PlaycutMetadataService` skips the live
  // `/proxy/metadata/album` fetch when `metadataStatus?.isTerminal == true ||
  // inline.streaming.hasAny`. A payload whose only populated fields would be
  // synthesized fallbacks must not satisfy the client's inline-metadata gate —
  // zero-streaming rows serve no streaming keys at all, so the proxy fallback
  // (which returns full metadata AND synthesizes its own links) still fires.
  it('does not fill a row with zero real streaming URLs — the terminal-but-empty case that must keep the 3.2 proxy fallback', () => {
    const entry = transformToIFSEntry(makeRaw({ metadata_status: 'enriched_no_match' }));

    expect(entry.spotify_url).toBeNull();
    expect(entry.apple_music_url).toBeNull();
    expect(entry.youtube_music_url).toBeNull();
    expect(entry.bandcamp_url).toBeNull();
    expect(entry.soundcloud_url).toBeNull();
    expect(entry.metadata.spotify_url).toBeNull();
    expect(entry.metadata.apple_music_url).toBeNull();
    expect(entry.metadata.youtube_music_url).toBeNull();
    expect(entry.metadata.bandcamp_url).toBeNull();
    expect(entry.metadata.soundcloud_url).toBeNull();
  });

  it('a verified persisted URL still wins — fill only touches absent fields', () => {
    const entry = transformToIFSEntry(
      makeRaw({
        spotify_url: 'https://open.spotify.com/album/genuine',
        youtube_music_url: 'https://music.youtube.com/playlist?list=verified',
      })
    );

    expect(entry.spotify_url).toBe('https://open.spotify.com/album/genuine');
    expect(entry.youtube_music_url).toBe('https://music.youtube.com/playlist?list=verified');
    // The other three were still absent on a qualifying row, so they're filled.
    expect(entry.apple_music_url).not.toBeNull();
    expect(entry.bandcamp_url).not.toBeNull();
    expect(entry.soundcloud_url).not.toBeNull();
  });

  // A suppressed URL is not a real streaming URL: the row it leaves behind has
  // zero, so it serves NULLs and the proxy fallback both fetches and
  // synthesizes — consistent with BS#1714's degradation.
  it('treats a row whose ONLY streaming URL was host-guard-suppressed as zero-streaming', () => {
    const entry = transformToIFSEntry(makeRaw({ spotify_url: 'https://www.deezer.com/album/254381182' }));

    expect(entry.spotify_url).toBeNull();
    expect(entry.apple_music_url).toBeNull();
    expect(entry.youtube_music_url).toBeNull();
    expect(entry.bandcamp_url).toBeNull();
    expect(entry.soundcloud_url).toBeNull();
  });

  it('degrades a host-guard-suppressed URL to a synthesized one when a sibling keeps the row qualifying', () => {
    const entry = transformToIFSEntry(
      makeRaw({
        spotify_url: 'https://www.deezer.com/album/254381182',
        bandcamp_url: 'https://juanamolina.bandcamp.com/album/doga',
      })
    );

    expect(entry.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
    expect(entry.bandcamp_url).toBe('https://juanamolina.bandcamp.com/album/doga');
  });

  // Blank-aware, matching the proxy's `if (!metadata.spotifyUrl)` falsy branch:
  // a persisted '' degrades to a synthesized URL on a qualifying row, rather
  // than surviving a `??`-nullish check and reaching the V1 wire as `""`.
  it("degrades a persisted '' to a synthesized URL on a qualifying row", () => {
    const entry = transformToIFSEntry(
      makeRaw({ spotify_url: '', bandcamp_url: 'https://juanamolina.bandcamp.com/album/doga' })
    );

    expect(entry.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
    expect(entry.metadata.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
  });

  it('never emits a blank on the V1 wire — a whitespace-only value on a non-qualifying row becomes null, not ""', () => {
    const entry = transformToIFSEntry(makeRaw({ spotify_url: '   ', soundcloud_url: '' }));

    expect(entry.spotify_url).toBeNull();
    expect(entry.soundcloud_url).toBeNull();
    expect(entry.metadata.spotify_url).toBeNull();
    expect(entry.metadata.soundcloud_url).toBeNull();
  });

  it('synthesizes nothing for a whitespace-only artist_name (five buttons opening "%20%20%20" searches is not a degradation)', () => {
    const entry = transformToIFSEntry(
      makeRaw({ artist_name: '   ', bandcamp_url: 'https://juanamolina.bandcamp.com/album/doga' })
    );

    expect(entry.spotify_url).toBeNull();
    expect(entry.apple_music_url).toBeNull();
    expect(entry.soundcloud_url).toBeNull();
    // The one real value is untouched.
    expect(entry.bandcamp_url).toBe('https://juanamolina.bandcamp.com/album/doga');
  });

  it('leaves every streaming URL null for a marker row with no artist_name (nothing to search on)', () => {
    const entry = transformToIFSEntry(
      makeRaw({
        entry_type: 'talkset',
        artist_name: null,
        album_title: null,
        track_title: null,
        bandcamp_url: 'https://example.bandcamp.com/album/x',
      })
    );

    expect(entry.spotify_url).toBeNull();
    expect(entry.apple_music_url).toBeNull();
    expect(entry.youtube_music_url).toBeNull();
    expect(entry.soundcloud_url).toBeNull();
  });
});
