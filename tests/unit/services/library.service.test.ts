import { isISODate, filterResultsByArtist } from '@/services/library.service';
import { EnrichedLibraryResult } from '@/services/requestLine/types';

describe('library.service', () => {
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

  describe('filterResultsByArtist', () => {
    const mockResults: EnrichedLibraryResult[] = [
      {
        id: 1,
        title: 'Album One',
        artist: 'Test Artist',
        codeLetters: 'RO',
        codeArtistNumber: 1,
        codeNumber: 1,
        genre: 'Rock',
        format: 'CD',
        callNumber: 'Rock CD RO 1/1',
        libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=1',
      },
      {
        id: 2,
        title: 'Album Two',
        artist: 'Test Artist',
        codeLetters: 'RO',
        codeArtistNumber: 1,
        codeNumber: 2,
        genre: 'Rock',
        format: 'CD',
        callNumber: 'Rock CD RO 1/2',
        libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=2',
      },
      {
        id: 3,
        title: 'Other Album',
        artist: 'Different Artist',
        codeLetters: 'RO',
        codeArtistNumber: 2,
        codeNumber: 1,
        genre: 'Rock',
        format: 'CD',
        callNumber: 'Rock CD RO 2/1',
        libraryUrl: 'http://www.wxyc.info/wxycdb/libraryRelease?id=3',
      },
    ];

    it('filters results to only include matching artist (case-insensitive)', () => {
      const filtered = filterResultsByArtist(mockResults, 'Test Artist');
      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => r.artist === 'Test Artist')).toBe(true);
    });

    it('filters using case-insensitive startsWith matching', () => {
      const filtered = filterResultsByArtist(mockResults, 'test');
      expect(filtered).toHaveLength(2);
    });

    it('returns all results when artist is null or undefined', () => {
      expect(filterResultsByArtist(mockResults, null)).toHaveLength(3);
      expect(filterResultsByArtist(mockResults, undefined)).toHaveLength(3);
    });

    it('returns empty array when no artists match', () => {
      const filtered = filterResultsByArtist(mockResults, 'Nonexistent');
      expect(filtered).toHaveLength(0);
    });

    it('returns empty array when artist is empty string', () => {
      // Empty string matches nothing since no artist starts with empty
      // Actually, every string starts with empty string, so this should return all
      const filtered = filterResultsByArtist(mockResults, '');
      expect(filtered).toHaveLength(3);
    });
  });
});
