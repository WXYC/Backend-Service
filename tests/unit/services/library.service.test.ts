import { db, createMockQueryChain } from '../../mocks/database.mock';

import {
  isISODate,
  fuzzySearchLibrary,
  getAlbumFromDB,
  markAlbumMissing,
  markAlbumFound,
} from '../../../apps/backend/services/library.service';

describe('library.service', () => {
  describe('fuzzySearchLibrary', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('passes through results when no on_streaming filter is provided', async () => {
      const mockResults = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', on_streaming: true },
        { id: 2, artist_name: 'Autechre', album_title: 'LP5', on_streaming: false },
      ];
      (db.execute as jest.Mock).mockResolvedValueOnce(mockResults);

      const results = await fuzzySearchLibrary('Autechre', undefined, 5);

      expect(results).toEqual(mockResults);
      expect(db.execute).toHaveBeenCalled();
    });

    it('calls db.execute when on_streaming filter is provided', async () => {
      const mockResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', on_streaming: true }];
      (db.execute as jest.Mock).mockResolvedValueOnce(mockResults);

      const results = await fuzzySearchLibrary('Autechre', undefined, 5, true);

      expect(results).toEqual(mockResults);
      expect(db.execute).toHaveBeenCalled();
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
      (db.select as jest.Mock).mockReturnValue(chain);
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
      (db.select as jest.Mock).mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([]);

      const result = await getAlbumFromDB(999);

      expect(result).toBeUndefined();
    });
  });

  describe('markAlbumMissing', () => {
    it('issues UPDATE and returns the updated row ID', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      (db.update as jest.Mock).mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42 }]);

      const result = await markAlbumMissing(42);

      expect(result).toEqual({ id: 42 });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns undefined when album does not exist', async () => {
      const chain = createMockQueryChain([]);
      (db.update as jest.Mock).mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await markAlbumMissing(999);

      expect(result).toBeUndefined();
    });
  });

  describe('markAlbumFound', () => {
    it('issues UPDATE and returns the updated row ID', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      (db.update as jest.Mock).mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([{ id: 42 }]);

      const result = await markAlbumFound(42);

      expect(result).toEqual({ id: 42 });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns undefined when album does not exist', async () => {
      const chain = createMockQueryChain([]);
      (db.update as jest.Mock).mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue([]);

      const result = await markAlbumFound(999);

      expect(result).toBeUndefined();
    });
  });
});
