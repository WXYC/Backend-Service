import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';

const mockSearchDiscogs = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  searchDiscogs: mockSearchDiscogs,
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
    it('returns album with format_name, genre_name, date_lost, date_found, and on_streaming', async () => {
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
      };
      const chain = createMockQueryChain([mockAlbum]);
      db.select.mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([mockAlbum]);

      const result = await getAlbumFromDB(42);

      expect(result).toEqual(mockAlbum);
      expect(result).toHaveProperty('format_name', 'CD');
      expect(result).toHaveProperty('genre_name', 'Electronic');
      expect(result).toHaveProperty('date_lost', null);
      expect(result).toHaveProperty('date_found', null);
      expect(result).toHaveProperty('on_streaming', true);
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
      expect(mockSearchDiscogs).not.toHaveBeenCalled();
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
      expect(mockSearchDiscogs).not.toHaveBeenCalled();
    });

    it('fetches artwork from LML for uncached results and caches to DB', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 1 }]);

      mockSearchDiscogs.mockResolvedValue({
        results: [
          {
            release_id: 12345,
            release_url: 'https://www.discogs.com/release/12345',
            artwork_url: 'https://i.discogs.com/confield.jpg',
            album: 'Confield',
            artist: 'Autechre',
            confidence: 0.95,
          },
        ],
        total: 1,
        cached: false,
      });

      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBe('https://i.discogs.com/confield.jpg');
      expect(mockSearchDiscogs).toHaveBeenCalledWith('Autechre', 'Confield');
      expect(db.update).toHaveBeenCalled();
    });

    it('filters spacer.gif artwork URLs', async () => {
      mockSearchDiscogs.mockResolvedValue({
        results: [
          {
            release_id: 99999,
            release_url: 'https://www.discogs.com/release/99999',
            artwork_url: 'https://st.discogs.com/images/spacer.gif',
            album: 'Unknown',
            artist: 'Unknown',
            confidence: 0.5,
          },
        ],
        total: 1,
        cached: false,
      });

      const results = [{ id: 1, artist_name: 'Unknown Artist', album_title: 'Unknown Album', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('handles LML failure gracefully without throwing', async () => {
      mockSearchDiscogs.mockRejectedValue(new Error('LML timeout'));

      const results = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched).toEqual(results);
      expect(enriched[0].artwork_url).toBeNull();
    });

    it('does not overwrite existing cached artwork', async () => {
      const chain = createMockQueryChain();
      db.update.mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 2 }]);

      mockSearchDiscogs.mockResolvedValue({
        results: [
          {
            release_id: 67890,
            release_url: 'https://www.discogs.com/release/67890',
            artwork_url: 'https://i.discogs.com/lp5.jpg',
            album: 'LP5',
            artist: 'Autechre',
            confidence: 0.9,
          },
        ],
        total: 1,
        cached: false,
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
      expect(mockSearchDiscogs).toHaveBeenCalledTimes(1);
      expect(mockSearchDiscogs).toHaveBeenCalledWith('Autechre', 'LP5');
    });

    it('handles LML returning no results', async () => {
      mockSearchDiscogs.mockResolvedValue({
        results: [],
        total: 0,
        cached: false,
      });

      const results = [{ id: 1, artist_name: 'Obscure Artist', album_title: 'Rare Album', artwork_url: null }];

      const enriched = await enrichWithArtwork(results);

      expect(enriched[0].artwork_url).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
