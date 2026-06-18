import {
  transformToV2,
  getDJsInCurrentShow,
  getOnAirStatusForDJ,
  getLatestShow,
} from '../../../apps/backend/services/flowsheet.service';
import { IFSEntry, IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';

const nullMetadata: IFSEntryMetadata = {
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
};

// Helper to create a base entry with common fields
const createBaseEntry = (overrides: Partial<IFSEntry & { metadata?: Partial<IFSEntryMetadata> }> = {}): IFSEntry => {
  const { metadata: metadataOverrides, ...rest } = overrides;
  return {
    id: 1,
    show_id: 100,
    album_id: null,
    rotation_id: null,
    entry_type: 'track',
    track_title: null,
    track_position: null,
    album_title: null,
    artist_name: null,
    record_label: null,
    label_id: null,
    play_order: 1,
    request_flag: false,
    segue: false,
    message: null,
    add_time: new Date('2024-01-15T12:00:00Z'),
    dj_name: null,
    rotation_bin: null,
    on_streaming: null,
    metadata: {
      ...nullMetadata,
      ...metadataOverrides,
    },
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
          metadata: {
            artwork_url: 'https://example.com/art.jpg',
            spotify_url: 'https://open.spotify.com/track/123',
          },
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

      it('includes segue field for track entry_type', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          segue: true,
        });

        const result = transformToV2(entry);

        expect(result.segue).toBe(true);
      });

      it('defaults segue to false when not set', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
        });

        const result = transformToV2(entry);

        expect(result.segue).toBe(false);
      });

      it('includes rotation_bin field', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          rotation_bin: 'H',
        });

        const result = transformToV2(entry);

        expect(result.rotation_bin).toBe('H');
      });

      it('includes rotation_bin as null when rotation_bin is null', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          rotation_bin: null,
        });

        const result = transformToV2(entry);

        expect(result.rotation_bin).toBeNull();
      });

      it('includes track_position when set by the flowsheet picker', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artist_name: 'Autechre',
          album_title: 'Confield',
          track_title: 'VI Scose Poise',
          track_position: 'A1',
        });

        const result = transformToV2(entry);

        expect(result.track_position).toBe('A1');
      });

      it('includes track_position as null when unset (free-text or legacy row)', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artist_name: 'Juana Molina',
          track_position: null,
        });

        const result = transformToV2(entry);

        expect(result.track_position).toBeNull();
      });

      it('includes label_id in track entries', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artist_name: 'Merge Records Artist',
          label_id: 42,
          record_label: 'Merge Records',
        });

        const result = transformToV2(entry);

        expect(result.label_id).toBe(42);
      });

      it.each([
        { value: true, description: 'true' },
        { value: false, description: 'false' },
        { value: null, description: 'null' },
      ])('includes on_streaming as $description for track entries', ({ value }) => {
        const entry = createBaseEntry({
          entry_type: 'track',
          artist_name: 'Autechre',
          album_title: 'Confield',
          on_streaming: value,
        });

        const result = transformToV2(entry);

        expect(result.on_streaming).toBe(value);
      });

      it('defaults on_streaming to null when entry has no album_id', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          album_id: null,
          artist_name: 'Autechre',
          album_title: 'Confield',
        });

        const result = transformToV2(entry);

        expect(result.on_streaming).toBeNull();
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
          metadata: {
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
          },
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

      // BS#1441: genres/styles are album_metadata-only arrays. Unlike the
      // scalar siblings (plain `?? null`), they coerce empty→null so the wire
      // has one canonical "no genres" value matching the LEFT-JOIN-miss case.
      it('projects populated genres/styles arrays for tracks', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          metadata: {
            genres: ['Rock', 'Electronic'],
            styles: ['Post-Rock', 'Ambient'],
          },
        });

        const result = transformToV2(entry);

        expect(result.genres).toEqual(['Rock', 'Electronic']);
        expect(result.styles).toEqual(['Post-Rock', 'Ambient']);
      });

      it('coerces empty genres/styles arrays to null', () => {
        const entry = createBaseEntry({
          entry_type: 'track',
          metadata: {
            genres: [],
            styles: [],
          },
        });

        const result = transformToV2(entry);

        expect(result.genres).toBeNull();
        expect(result.styles).toBeNull();
      });

      it('projects null genres/styles when metadata has none', () => {
        const entry = createBaseEntry({ entry_type: 'track' });

        const result = transformToV2(entry);

        expect(result.genres).toBeNull();
        expect(result.styles).toBeNull();
      });
    });

    describe('show_start entries', () => {
      it('returns dj_name from the column (not regex-parsed from message)', () => {
        const entry = createBaseEntry({
          entry_type: 'show_start',
          dj_name: 'Cool Cat',
          // Deliberately malformed message to prove the serializer no longer reads it
          message: 'this is not the canonical format',
          add_time: new Date('2024-01-16T00:00:00Z'),
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('show_start');
        expect(result.dj_name).toBe('Cool Cat');
        // timestamp derived from add_time in en-US America/New_York locale
        expect(result.timestamp).toBe('1/15/2024, 7:00:00 PM');
      });

      it('excludes track-specific fields from show_start entries', () => {
        const entry = createBaseEntry({
          entry_type: 'show_start',
          dj_name: 'Test',
          artist_name: 'should not appear',
          album_title: 'should not appear',
        });

        const result = transformToV2(entry);

        expect(result.artist_name).toBeUndefined();
        expect(result.album_title).toBeUndefined();
        expect(result.track_title).toBeUndefined();
        expect(result.rotation_bin).toBeUndefined();
      });

      it('returns empty strings when dj_name is null and add_time is missing', () => {
        const entry = createBaseEntry({
          entry_type: 'show_start',
          dj_name: null,
        });
        // The schema-inferred type marks add_time as non-null, but legacy rows
        // can carry a null value through the read path. Force it via override
        // to exercise the empty-string fallback.
        (entry as { add_time: Date | null }).add_time = null;

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('show_start');
        expect(result.dj_name).toBe('');
        expect(result.timestamp).toBe('');
      });
    });

    describe('show_end entries', () => {
      it('returns dj_name from the column (not regex-parsed from message)', () => {
        const entry = createBaseEntry({
          entry_type: 'show_end',
          dj_name: 'DJ Night Owl',
          message: 'not the canonical format',
          add_time: new Date('2024-01-16T03:00:00Z'),
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('show_end');
        expect(result.dj_name).toBe('DJ Night Owl');
        expect(result.timestamp).toBe('1/15/2024, 10:00:00 PM');
      });

      it('excludes track-specific fields from show_end entries', () => {
        const entry = createBaseEntry({
          entry_type: 'show_end',
          dj_name: 'Test',
        });

        const result = transformToV2(entry);

        expect(result.artist_name).toBeUndefined();
        expect(result.album_title).toBeUndefined();
        expect(result.artwork_url).toBeUndefined();
      });
    });

    describe('dj_join entries', () => {
      it('returns dj_name from the column (not regex-parsed from message)', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          dj_name: 'MC Hammer',
          message: 'not the canonical format',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('dj_join');
        expect(result.dj_name).toBe('MC Hammer');
      });

      it('excludes track and message fields', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          dj_name: 'Test DJ',
        });

        const result = transformToV2(entry);

        expect(result.message).toBeUndefined();
        expect(result.artist_name).toBeUndefined();
      });

      it('returns empty string when dj_name is null', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          dj_name: null,
        });

        const result = transformToV2(entry);

        expect(result.dj_name).toBe('');
      });
    });

    describe('dj_leave entries', () => {
      it('returns dj_name from the column (not regex-parsed from message)', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_leave',
          dj_name: 'DJ Shadow',
          message: 'not the canonical format',
        });

        const result = transformToV2(entry);

        expect(result.entry_type).toBe('dj_leave');
        expect(result.dj_name).toBe('DJ Shadow');
      });

      it('returns empty string when dj_name is null', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_leave',
          dj_name: null,
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

      it('preserves special characters in DJ names', () => {
        const entry = createBaseEntry({
          entry_type: 'dj_join',
          dj_name: "DJ O'Brien & The Crew",
        });

        const result = transformToV2(entry);

        expect(result.dj_name).toBe("DJ O'Brien & The Crew");
      });
    });
  });

  describe('no-show edge cases', () => {
    // The mock DB returns [] by default, so getLatestShow() returns undefined

    it('getLatestShow returns undefined when no shows exist', async () => {
      const result = await getLatestShow();
      expect(result).toBeUndefined();
    });

    it('getDJsInCurrentShow returns empty array when no shows exist', async () => {
      const result = await getDJsInCurrentShow();
      expect(result).toEqual([]);
    });

    it('getOnAirStatusForDJ returns false when no shows exist', async () => {
      const result = await getOnAirStatusForDJ('some-dj-id');
      expect(result).toBe(false);
    });
  });
});
