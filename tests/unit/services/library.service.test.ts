import { jest } from '@jest/globals';
import { db, createMockQueryChain, library, library_artist_view, album_plays } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
}));

import {
  isISODate,
  fuzzySearchLibrary,
  searchLibrary,
  searchByArtist,
  searchAlbumsByTitle,
  getAlbumFromDB,
  markAlbumMissing,
  markAlbumFound,
  enrichWithArtwork,
  updateArtworkUrl,
} from '../../../apps/backend/services/library.service';

describe('library.service', () => {
  describe('fuzzySearchLibrary', () => {
    const mockViewRow = {
      id: 1,
      code_letters: 'AU',
      code_artist_number: 3,
      code_number: 2,
      artist_name: 'Autechre',
      alphabetical_name: 'Autechre',
      album_title: 'Confield',
      format_name: 'cd',
      genre_name: 'Electronic',
      rotation_bin: null,
      add_date: new Date('2024-01-15'),
      label: 'Warp',
      label_id: null,
      on_streaming: true,
      album_artist: null,
      plays: 5,
      artwork_url: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns results with code_artist_number mapped from the view', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await fuzzySearchLibrary('Autechre', undefined, 5);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('code_artist_number', 3);
    });

    it('applies on_streaming filter when provided', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await fuzzySearchLibrary('Autechre', undefined, 5, true);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('on_streaming', true);
    });
  });

  // Shared mock view row for search function tests
  const mockViewRow = {
    id: 1,
    code_letters: 'AU',
    code_artist_number: 3,
    code_number: 2,
    artist_name: 'Autechre',
    alphabetical_name: 'Autechre',
    album_title: 'Confield',
    format_name: 'cd',
    genre_name: 'Electronic',
    rotation_bin: null,
    add_date: new Date('2024-01-15'),
    label: 'Warp',
    label_id: null,
    on_streaming: true,
    album_artist: null,
    plays: 5,
    artwork_url: null,
  };

  describe('searchLibrary', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('maps code_artist_number from the view into codeArtistNumber', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchLibrary('Autechre');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('codeArtistNumber', 3);
    });

    it('routes free-text query through library + album_plays join (not library_artist_view)', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      await searchLibrary('stereolab transient');

      // Tsvector path reads from `library` directly so the search_doc GIN
      // index is reachable; reading from the view forces a 5-way join first.
      expect(chain.from).toHaveBeenCalledWith(library);
      expect(chain.from).not.toHaveBeenCalledWith(library_artist_view);
      // album_plays drives the play-weighted ranking factor.
      const leftJoinTables = chain.leftJoin.mock.calls.map((c) => c[0]);
      expect(leftJoinTables).toContain(album_plays);
    });

    it('returns empty without a DB call for pure-punctuation queries', async () => {
      const results = await searchLibrary('!!!');

      expect(results).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('falls back to trigram when tsvector returns 0 rows', async () => {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain([mockViewRow]);
      trigramChain.limit = jest.fn().mockResolvedValue([mockViewRow]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });

      const results = await searchLibrary('pikn floyd');

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(1);
    });

    it('does not fall back to trigram for single-character queries', async () => {
      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      db.select.mockReset();
      db.select.mockReturnValue(tsvectorChain);

      const results = await searchLibrary('a');

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);
    });
  });

  describe('fuzzySearchLibrary Both-mode routing', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('routes through tsvector + album_plays when artist_name and album_title are identical', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      await fuzzySearchLibrary('Stereolab', 'Stereolab', 5);

      expect(chain.from).toHaveBeenCalledWith(library);
      expect(chain.from).not.toHaveBeenCalledWith(library_artist_view);
      const leftJoinTables = chain.leftJoin.mock.calls.map((c) => c[0]);
      expect(leftJoinTables).toContain(album_plays);
    });

    it('keeps single-column path (no album_plays join) when only artist is provided', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      await fuzzySearchLibrary('Autechre', undefined, 5);

      const leftJoinTables = chain.leftJoin.mock.calls.map((c) => c[0]);
      expect(leftJoinTables).not.toContain(album_plays);
    });
  });

  describe('searchByArtist', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('maps code_artist_number from the view into codeArtistNumber', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchByArtist('Autechre');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('codeArtistNumber', 3);
    });
  });

  describe('searchAlbumsByTitle', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('maps code_artist_number from the view into codeArtistNumber', async () => {
      const chain = createMockQueryChain([mockViewRow]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockViewRow]);

      const results = await searchAlbumsByTitle('Confield');

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('codeArtistNumber', 3);
    });
  });

  describe('isISODate', () => {
    it('returns true for valid ISO date format YYYY-MM-DD', () => {
      expect(isISODate('2024-01-15')).toBe(true);
      expect(isISODate('2000-12-31')).toBe(true);
      expect(isISODate('1999-06-01')).toBe(true);
    });

    it('returns false for invalid formats', () => {
      expect(isISODate('01-15-2024')).toBe(false); // MM-DD-YYYY
      expect(isISODate('15/01/2024')).toBe(false); // DD/MM/YYYY
      expect(isISODate('2024/01/15')).toBe(false); // YYYY/MM/DD
      expect(isISODate('January 15, 2024')).toBe(false);
      expect(isISODate('2024-1-15')).toBe(false); // single digit month
      expect(isISODate('2024-01-5')).toBe(false); // single digit day
    });

    it('returns false for empty or invalid strings', () => {
      expect(isISODate('')).toBe(false);
      expect(isISODate('not-a-date')).toBe(false);
      expect(isISODate('2024')).toBe(false);
      expect(isISODate('2024-01')).toBe(false);
    });

    it('returns true for edge case dates (format only, not validity)', () => {
      // Note: isISODate only checks format, not calendar validity
      expect(isISODate('2024-02-29')).toBe(true); // leap year
      expect(isISODate('2024-02-30')).toBe(true); // invalid day but correct format
      expect(isISODate('2024-13-01')).toBe(true); // invalid month but correct format
    });
  });

  describe('getAlbumFromDB', () => {
    it('returns album with format_name, genre_name, date_lost, date_found, on_streaming, and nested reconciled_identity', async () => {
      const mockAlbum = {
        id: 42,
        code_letters: 'AU',
        code_artist_number: 1,
        code_number: 3,
        artist_name: 'Autechre',
        alphabetical_name: 'Autechre',
        album_title: 'Confield',
        record_label: 'Warp',
        label_id: 10,
        plays: 5,
        add_date: new Date('2024-01-15'),
        last_modified: new Date('2024-03-01'),
        format_name: 'CD',
        genre_name: 'Electronic',
        date_lost: null,
        date_found: null,
        on_streaming: true,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };
      const chain = createMockQueryChain([mockAlbum]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockAlbum]);

      const result = await getAlbumFromDB(42);

      expect(result).toHaveProperty('format_name', 'CD');
      expect(result).toHaveProperty('genre_name', 'Electronic');
      expect(result).toHaveProperty('date_lost', null);
      expect(result).toHaveProperty('date_found', null);
      expect(result).toHaveProperty('on_streaming', true);
      expect(result).toHaveProperty('reconciled_identity', null);
      // The flat external-ID columns are stripped from the wire shape.
      expect(result).not.toHaveProperty('discogs_artist_id');
      expect(result).not.toHaveProperty('musicbrainz_artist_id');
      expect(db.select).toHaveBeenCalled();
    });

    it('returns undefined when album not found', async () => {
      const chain = createMockQueryChain([]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([]);

      const result = await getAlbumFromDB(999);

      expect(result).toBeUndefined();
    });
  });

  describe('markAlbumMissing', () => {
    it('issues UPDATE and returns the updated row ID', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42 }]);

      const result = await markAlbumMissing(42);

      expect(result).toEqual({ id: 42 });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns undefined when album does not exist', async () => {
      const chain = createMockQueryChain([]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await markAlbumMissing(999);

      expect(result).toBeUndefined();
    });
  });

  describe('markAlbumFound', () => {
    it('issues UPDATE and returns the updated row ID', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42 }]);

      const result = await markAlbumFound(42);

      expect(result).toEqual({ id: 42 });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns undefined when album does not exist', async () => {
      const chain = createMockQueryChain([]);
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await markAlbumFound(999);

      expect(result).toBeUndefined();
    });
  });

  describe('updateArtworkUrl', () => {
    it('updates the artwork_url column and returns the updated row', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42, artwork_url: 'https://i.discogs.com/confield.jpg' }]);

      const result = await updateArtworkUrl(42, 'https://i.discogs.com/confield.jpg');

      expect(result).toEqual({ id: 42, artwork_url: 'https://i.discogs.com/confield.jpg' });
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('enrichWithArtwork', () => {
    beforeEach(() => {
      mockIsLmlConfigured.mockReturnValue(true);
    });

    it('returns results unchanged when LML is not configured', async () => {
      mockIsLmlConfigured.mockReturnValue(false);
      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('returns results unchanged when all have artwork cached', async () => {
      const results = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: 'https://i.discogs.com/confield.jpg' },
        {
          id: 2,
          artist_name: 'Stereolab',
          album_title: 'Aluminum Tunes',
          artwork_url: 'https://i.discogs.com/aluminum.jpg',
        },
      ];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('fetches artwork from LML for uncached results and caches to DB', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 1 }]);

      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'Confield',
              artist: 'Autechre',
              call_number: 'Electronic CD AUT 1/1',
              library_url: '',
            },
            artwork: {
              release_id: 12345,
              release_url: 'https://www.discogs.com/release/12345',
              artwork_url: 'https://i.discogs.com/confield.jpg',
              confidence: 0.95,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBe('https://i.discogs.com/confield.jpg');
      expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield');
      expect(db.update).toHaveBeenCalled();
    });

    it('filters spacer.gif artwork URLs', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'Unknown',
              artist: 'Unknown',
              call_number: 'Rock CD UNK 1/1',
              library_url: '',
            },
            artwork: {
              release_id: 99999,
              release_url: 'https://www.discogs.com/release/99999',
              artwork_url: 'https://st.discogs.com/images/spacer.gif',
              confidence: 0.5,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [{ id: 1, artist_name: 'Unknown Artist', album_title: 'Unknown Album', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('handles LML failure gracefully without throwing', async () => {
      mockLookupMetadata.mockRejectedValue(new Error('LML timeout'));

      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(enriched[0].artwork_url).toBeNull();
    });

    it('does not overwrite existing cached artwork', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 2 }]);

      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 2,
              title: 'LP5',
              artist: 'Autechre',
              call_number: 'Electronic CD AUT 2/1',
              library_url: '',
            },
            artwork: {
              release_id: 67890,
              release_url: 'https://www.discogs.com/release/67890',
              artwork_url: 'https://i.discogs.com/lp5.jpg',
              confidence: 0.9,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: 'https://i.discogs.com/confield.jpg' },
        { id: 2, artist_name: 'Autechre', album_title: 'LP5', artwork_url: null },
      ];

      const enriched = await enrichWithArtwork(results);

      // Cached result unchanged
      expect(enriched[0].artwork_url).toBe('https://i.discogs.com/confield.jpg');
      // Uncached result enriched
      expect(enriched[1].artwork_url).toBe('https://i.discogs.com/lp5.jpg');
      // Only one LML call (for LP5, not Confield)
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
      expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'LP5');
    });

    it('handles LML returning no results', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [],
        search_type: 'none',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = [{ id: 1, artist_name: 'Obscure Artist', album_title: 'Rare Album', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
