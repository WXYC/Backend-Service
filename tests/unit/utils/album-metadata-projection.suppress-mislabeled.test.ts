/**
 * Serve-seam screen on the two host-guarded streaming fields (BS#1714, BS#2697).
 *
 * `suppressMislabeledStreamingUrls` runs on the POST-COALESCE values from
 * `ALBUM_METADATA_PROJECTION` (`coalesce(album_metadata.X, flowsheet.X)`), which
 * makes it the only guard in the codebase that reaches `flowsheet.spotify_url`
 * as well as the `album_metadata` copy — the BS#2696 reach a write-path guard
 * structurally cannot have. It had no test coverage at all before BS#2697.
 *
 * BS#2697 narrows the `spotify_url` leg from "is on a Spotify host"
 * (`isSpotifyUrl`) to "names a release or a search" (`isSpotifyAlbumSlotUrl`),
 * so 4,362 of the 29,240 persisted values (14.92%, measured on prod
 * 2026-09-26) stop being served under the hardwired iOS "Spotify" button and
 * degrade to the synthesized search URL instead. The decisive safety number is
 * on that ticket: ZERO rows have Spotify as their only streaming URL, at either
 * seam, so no row can be pushed to zero-streaming by this screen and
 * `fillSynthesizedSearchUrls`'s Gate 1 cannot flip.
 *
 * `apple_music_url` is deliberately NOT narrowed — see BS#2691 and the
 * `sanitizeLookupStreamingUrls` doc comment.
 */
import { suppressMislabeledStreamingUrls } from '../../../apps/backend/utils/album-metadata-projection';

const ALBUM = 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo';
const APPLE = 'https://music.apple.com/us/album/moon-pix/1440830867';

const screened = (spotify_url: string | null) =>
  suppressMislabeledStreamingUrls({ spotify_url, apple_music_url: APPLE }).spotify_url;

describe('suppressMislabeledStreamingUrls — spotify_url (BS#2697)', () => {
  describe('rejects a value that is on the host but is not a release', () => {
    it.each([
      [
        'artist page (3,470 prod rows — the April-2026 campaign)',
        'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7',
      ],
      [
        'track page (841 prod rows — see the ticket, this is the debatable one)',
        'https://open.spotify.com/track/1A2GTWGtFfWp7KSQTwWOyo',
      ],
      ['playlist (6)', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
      ['user (2)', 'https://open.spotify.com/user/wxyc'],
      ['podcast show (1)', 'https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk'],
      ['id-less /album (14)', 'https://open.spotify.com/album'],
    ])('%s', (_label, url) => {
      expect(screened(url)).toBeNull();
    });
  });

  describe('keeps everything that was already being served correctly', () => {
    it.each([
      ['canonical album page', ALBUM],
      ['locale-prefixed album page', 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo'],
      // The premise that foreclosed this whole option was that narrowing the
      // read path would suppress the 3,787 persisted synthesized search URLs.
      // True of `isSpotifyUrl`; false of this predicate, which accepts them.
      // If this case ever goes red, the ticket's objection has become real.
      ['synthesized search fallback — path form', 'https://open.spotify.com/search/Cat%20Power%20Moon%20Pix'],
      ['synthesized search fallback — query form', 'https://open.spotify.com/search?q=Cat%20Power'],
      ['album page on a non-open spotify host', 'https://play.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo'],
    ])('%s', (_label, url) => {
      expect(screened(url)).toBe(url);
    });
  });

  it('passes a null through unchanged', () => {
    expect(screened(null)).toBeNull();
  });

  it('leaves apple_music_url alone when spotify_url is screened', () => {
    // BS#2691 is the Apple analogue and is explicitly NOT in this change's
    // scope: a null apple_music_url has no search fallback (BS#1192), so
    // narrowing it blanks the button rather than degrading it.
    const out = suppressMislabeledStreamingUrls({
      spotify_url: 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7',
      apple_music_url: APPLE,
    });
    expect(out.spotify_url).toBeNull();
    expect(out.apple_music_url).toBe(APPLE);
  });

  it('still rejects the off-host values BS#1714 was about', () => {
    // The narrowing must not lose the host check it composes over.
    expect(screened('https://www.deezer.com/album/254381182')).toBeNull();
    expect(screened('https://open.spotify.com.evil.example/album/1')).toBeNull();
  });
});
