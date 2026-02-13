import { transformToV2 } from '../../../apps/backend/services/flowsheet.service';
import { IFSEntry } from '../../../apps/backend/controllers/flowsheet.controller';

import { IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';

const defaultMetadata: IFSEntryMetadata = {
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
};

// Helper to create a base entry with common fields
const createBaseEntry = (overrides: Partial<IFSEntry & IFSEntryMetadata> = {}): IFSEntry => {
  const {
    artwork_url,
    discogs_url,
    release_year,
    spotify_url,
    apple_music_url,
    youtube_music_url,
    bandcamp_url,
    soundcloud_url,
    artist_bio,
    artist_wikipedia_url,
    metadata: metadataOverride,
    ...rest
  } = overrides;

  const metadata: IFSEntryMetadata = metadataOverride ?? {
    ...defaultMetadata,
    ...(artwork_url !== undefined && { artwork_url }),
    ...(discogs_url !== undefined && { discogs_url }),
    ...(release_year !== undefined && { release_year }),
    ...(spotify_url !== undefined && { spotify_url }),
    ...(apple_music_url !== undefined && { apple_music_url }),
    ...(youtube_music_url !== undefined && { youtube_music_url }),
    ...(bandcamp_url !== undefined && { bandcamp_url }),
    ...(soundcloud_url !== undefined && { soundcloud_url }),
    ...(artist_bio !== undefined && { artist_bio }),
    ...(artist_wikipedia_url !== undefined && { artist_wikipedia_url }),
  };

  return {
    id: 1,
    show_id: 100,
    album_id: null,
    rotation_id: null,
    entry_type: 'track',
    track_title: null,
    album_title: null,
    artist_name: null,
    record_label: null,
    play_order: 1,
    request_flag: false,
    message: null,
    add_time: new Date('2024-01-15T12:00:00Z'),
    rotation_bin: null,
    metadata,
    ...rest,
  };
};

describe('flowsheet.service', () => {
  describe('transformToV2', () => {
    describe('track entries', () => {
      it('includes track-specific fields for track entry_type', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artist_name: 'Built to Spill',
          album_title: 'Keep it Like a Secret',
          track_title: 'Carry the Zero',
          record_label: 'Warner Bros',
          album_id: 1,
          rotation_id: 5,
          request_flag: true,
          rotation_bin: 'H',
          artwork_url: 'https://example.com/art.jpg',
          spotify_url: 'https://open.spotify.com/track/123',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('track');
        expect(result.artist_name).toBe('Built to Spill');
        expect(result.album_title).toBe('Keep it Like a Secret');
        expect(result.track_title).toBe('Carry the Zero');
        expect(result.record_label).toBe('Warner Bros');
        expect(result.album_id).toBe(1);
        expect(result.rotation_id).toBe(5);
        expect(result.request_flag).toBe(true);
        expect(result.rotation_bin).toBe('H');
        expect(result.artwork_url).toBe('https://example.com/art.jpg');
        expect(result.spotify_url).toBe('https://open.spotify.com/track/123');
      });

      it('excludes message field from track entries', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artist_name: 'Test Artist',
          message: 'should not appear',
        });

        const result = transformToV2(entry);

        expect(result.message).toBeUndefined();
      });

      it('includes all metadata fields for tracks', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artwork_url: 'art.jpg',
          discogs_url: 'discogs.com',
          release_year: 1999,
          spotify_url: 'spotify.com',
          apple_music_url: 'apple.com',
          youtube_music_url: 'youtube.com',
          bandcamp_url: 'bandcamp.com',
          soundcloud_url: 'soundcloud.com',
          artist_bio: 'A great band',
          artist_wikipedia_url: 'wiki.com',
        });

        const result = transformToV2(entry);

        expect(result.artwork_url).toBe('art.jpg');
        expect(result.discogs_url).toBe('discogs.com');
        expect(result.release_year).toBe(1999);
        expect(result.spotify_url).toBe('spotify.com');
        expect(result.apple_music_url).toBe('apple.com');
        expect(result.youtube_music_url).toBe('youtube.com');
        expect(result.bandcamp_url).toBe('bandcamp.com');
        expect(result.soundcloud_url).toBe('soundcloud.com');
        expect(result.artist_bio).toBe('A great band');
        expect(result.artist_wikipedia_url).toBe('wiki.com');
      });
    });

    describe('show_start entries', () => {
      it('parses dj_name and timestamp from message', () => {
        const entry = createBaseEntry({
          entry_type: 'show_start',
          message: 'Start of Show: DJ Cool Cat joined the set at 1/15/2024, 7:00:00 PM',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('show_start');
        expect(result.dj_name).toBe('Cool Cat');
        expect(result.timestamp).toBe('1/15/2024, 7:00:00 PM');
      });

      it('excludes track-specific fields from show_start entries', () => {
        const entry = createBaseEntry({
          entry_type: 'show_start',
          message: 'Start of Show: DJ Test joined the set at 1/15/2024, 7:00:00 PM',
          artist_name: 'should not appear',
          album_title: 'should not appear',
        });

        const result = transformToV2(entry);

        expect(result.artist_name).toBeUndefined();
        expect(result.album_title).toBeUndefined();
        expect(result.track_title).toBeUndefined();
        expect(result.rotation_bin).toBeUndefined();
      });

      it('handles malformed show_start message gracefully', () => {
        const entry = createBaseEntry({
          entry_type: 'show_start',
          message: 'Some other message format',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('show_start');
        expect(result.dj_name).toBe('');
        expect(result.timestamp).toBe('');
      });
    });

    describe('show_end entries', () => {
      it('parses dj_name and timestamp from message', () => {
        const entry = createBaseEntry({
          entry_type: 'show_end',
          message: 'End of Show: DJ Night Owl left the set at 1/15/2024, 10:00:00 PM',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('show_end');
        expect(result.dj_name).toBe('DJ Night Owl');
        expect(result.timestamp).toBe('1/15/2024, 10:00:00 PM');
      });

      it('excludes track-specific fields from show_end entries', () => {
        const entry = createBaseEntry({
          entry_type: 'show_end',
          message: 'End of Show: Test left the set at 1/15/2024, 10:00:00 PM',
        });

        const result = transformToV2(entry);

        expect(result.artist_name).toBeUndefined();
        expect(result.album_title).toBeUndefined();
        expect(result.artwork_url).toBeUndefined();
      });
    });

    describe('dj_join entries', () => {
      it('parses dj_name from message', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          message: 'MC Hammer joined the set!',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('dj_join');
        expect(result.dj_name).toBe('MC Hammer');
      });

      it('excludes track and message fields', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          message: 'Test DJ joined the set!',
        });

        const result = transformToV2(entry);

        expect(result.message).toBeUndefined();
        expect(result.artist_name).toBeUndefined();
      });

      it('handles malformed dj_join message gracefully', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          message: 'Invalid format',
        });

        const result = transformToV2(entry);

        expect(result.dj_name).toBe('');
      });
    });

    describe('dj_leave entries', () => {
      it('parses dj_name from message', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_leave',
          message: 'DJ Shadow left the set!',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('dj_leave');
        expect(result.dj_name).toBe('DJ Shadow');
      });

      it('handles malformed dj_leave message gracefully', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_leave',
          message: null,
        });

        const result = transformToV2(entry);

        expect(result.dj_name).toBe('');
      });
    });

    describe('talkset entries', () => {
      it('includes message field', () => {
        const entry = createBaseEntry({
          entry_type: 'talkset',
          message: 'Station ID at the top of the hour',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('talkset');
        expect(result.message).toBe('Station ID at the top of the hour');
      });

      it('excludes track-specific fields', () => {
        const entry = createBaseEntry({
          entry_type: 'talkset',
          message: 'PSA announcement',
          artist_name: 'should not appear',
        });

        const result = transformToV2(entry);

        expect(result.artist_name).toBeUndefined();
        expect(result.album_title).toBeUndefined();
      });
    });

    describe('breakpoint entries', () => {
      it('includes message field (can be null)', () => {
        const entry = createBaseEntry({
          entry_type: 'breakpoint',
          message: 'Top of the hour',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('breakpoint');
        expect(result.message).toBe('Top of the hour');
      });

      it('handles null message for breakpoint', () => {
        const entry = createBaseEntry({
          entry_type: 'breakpoint',
          message: null,
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('breakpoint');
        expect(result.message).toBeNull();
      });
    });

    describe('message entries', () => {
      it('includes message field', () => {
        const entry = createBaseEntry({
          entry_type: 'message',
          message: 'Custom user message here',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('message');
        expect(result.message).toBe('Custom user message here');
      });

      it('excludes track-specific fields', () => {
        const entry = createBaseEntry({
          entry_type: 'message',
          message: 'Test message',
          rotation_bin: 'H',
        });

        const result = transformToV2(entry);

        expect(result.rotation_bin).toBeUndefined();
      });
    });

    describe('base fields', () => {
      it('always includes id, show_id, play_order, add_time, entry_type', () => {
        const testCases: Array<IFSEntry['entry_type']> = [
          'track',
          'show_start',
          'show_end',
          'dj_join',
          'dj_leave',
          'talkset',
          'breakpoint',
          'message',
        ];

        for (const entryType of testCases) {
          const entry = createBaseEntry({
            entry_type: entryType,
            id: 42,
            show_id: 100,
            play_order: 5,
            message:
              entryType === 'show_start'
                ? 'Start of Show: DJ Test joined the set at 1/1/2024, 12:00:00 PM'
                : entryType === 'show_end'
                  ? 'End of Show: Test left the set at 1/1/2024, 1:00:00 PM'
                  : entryType === 'dj_join'
                    ? 'Test joined the set!'
                    : entryType === 'dj_leave'
                      ? 'Test left the set!'
                      : 'Test message',
          });

          const result = transformToV2(entry);

          expect(result.id).toBe(42);
          expect(result.show_id).toBe(100);
          expect(result.play_order).toBe(5);
          expect(result.add_time).toEqual(entry.add_time);
          expect(result.entry_type).toBe(entryType);
        }
      });
    });

    describe('edge cases', () => {
      it('handles unknown entry_type by returning all fields', () => {
        const entry = createBaseEntry({
          entry_type: 'unknown_type' as any,
          message: 'test',
          artist_name: 'test artist',
        });

        const result = transformToV2(entry);

        // Should return the entry as-is for unknown types
        expect(result.message).toBe('test');
        expect(result.artist_name).toBe('test artist');
      });

      it('handles null show_id', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          show_id: null,
        });

        const result = transformToV2(entry);

        expect(result.show_id).toBeNull();
      });

      it('handles special characters in DJ names', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          message: "DJ O'Brien & The Crew joined the set!",
        });

        const result = transformToV2(entry);

        expect(result.dj_name).toBe("DJ O'Brien & The Crew");
      });
    });
  });
});
