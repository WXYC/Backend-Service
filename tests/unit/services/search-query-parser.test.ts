import { parseSearchQuery } from '../../../apps/backend/services/search-parser.service';

describe('parseSearchQuery', () => {
  describe('simple terms', () => {
    it('parses a bare term as all-field search', () => {
      const result = parseSearchQuery('autechre');

      expect(result).toEqual([
        { operator: 'AND', field: 'all', value: 'autechre', exact: false, negated: false },
      ]);
    });

    it('parses multiple bare terms as separate AND conditions', () => {
      const result = parseSearchQuery('autechre confield');

      expect(result).toEqual([
        { operator: 'AND', field: 'all', value: 'autechre', exact: false, negated: false },
        { operator: 'AND', field: 'all', value: 'confield', exact: false, negated: false },
      ]);
    });
  });

  describe('field prefixes', () => {
    it.each([
      ['artist:autechre', 'artist_name', 'autechre'],
      ['song:poise', 'track_title', 'poise'],
      ['album:confield', 'album_title', 'confield'],
      ['label:warp', 'record_label', 'warp'],
      ['dj:jake', 'dj_name', 'jake'],
    ])('parses %s as field=%s value=%s', (input, expectedField, expectedValue) => {
      const result = parseSearchQuery(input);

      expect(result).toEqual([
        { operator: 'AND', field: expectedField, value: expectedValue, exact: false, negated: false },
      ]);
    });
  });

  describe('operators', () => {
    it('parses AND between two field terms', () => {
      const result = parseSearchQuery('artist:autechre AND album:confield');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'autechre', exact: false, negated: false },
        { operator: 'AND', field: 'album_title', value: 'confield', exact: false, negated: false },
      ]);
    });

    it('parses OR between two field terms', () => {
      const result = parseSearchQuery('artist:autechre OR artist:stereolab');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'autechre', exact: false, negated: false },
        { operator: 'OR', field: 'artist_name', value: 'stereolab', exact: false, negated: false },
      ]);
    });

    it('parses NOT as negation on the following condition', () => {
      const result = parseSearchQuery('NOT artist:autechre');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'autechre', exact: false, negated: true },
      ]);
    });

    it('parses operator + NOT combination', () => {
      const result = parseSearchQuery('artist:stereolab AND NOT artist:autechre');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'stereolab', exact: false, negated: false },
        { operator: 'AND', field: 'artist_name', value: 'autechre', exact: false, negated: true },
      ]);
    });
  });

  describe('exact match (quoted values)', () => {
    it('parses quoted value as exact match', () => {
      const result = parseSearchQuery('artist:"Autechre"');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'Autechre', exact: true, negated: false },
      ]);
    });

    it('parses quoted value with spaces', () => {
      const result = parseSearchQuery('artist:"Cat Power"');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'Cat Power', exact: true, negated: false },
      ]);
    });

    it('parses bare quoted value as all-field exact match', () => {
      const result = parseSearchQuery('"Juana Molina"');

      expect(result).toEqual([
        { operator: 'AND', field: 'all', value: 'Juana Molina', exact: true, negated: false },
      ]);
    });

    it('handles unmatched quote by treating rest of string as value', () => {
      const result = parseSearchQuery('artist:"Autechre');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'Autechre', exact: true, negated: false },
      ]);
    });
  });

  describe('date and dateRange', () => {
    it('parses date prefix', () => {
      const result = parseSearchQuery('date:2024-06-15');

      expect(result).toEqual([
        { operator: 'AND', field: 'add_time', value: '2024-06-15', exact: false, negated: false },
      ]);
    });

    it('parses dateRange prefix with .. separator', () => {
      const result = parseSearchQuery('dateRange:2024-01-01..2024-12-31');

      expect(result).toEqual([
        { operator: 'AND', field: 'add_time_range', value: '2024-01-01..2024-12-31', exact: false, negated: false },
      ]);
    });
  });

  describe('complex queries', () => {
    it('parses mixed field and operator query', () => {
      const result = parseSearchQuery('artist:autechre AND song:poise AND NOT label:warp');

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ field: 'artist_name', value: 'autechre', negated: false });
      expect(result[1]).toMatchObject({ field: 'track_title', value: 'poise', operator: 'AND' });
      expect(result[2]).toMatchObject({ field: 'record_label', value: 'warp', negated: true });
    });

    it('parses field prefix with simple query and OR', () => {
      const result = parseSearchQuery('artist:autechre OR artist:"Cat Power"');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'autechre', exact: false, negated: false },
        { operator: 'OR', field: 'artist_name', value: 'Cat Power', exact: true, negated: false },
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      expect(parseSearchQuery('')).toEqual([]);
    });

    it('returns empty array for whitespace-only string', () => {
      expect(parseSearchQuery('   ')).toEqual([]);
    });

    it('ignores field prefix with no value', () => {
      const result = parseSearchQuery('artist:');

      expect(result).toEqual([]);
    });

    it('handles multiple spaces between tokens', () => {
      const result = parseSearchQuery('artist:autechre   AND   album:confield');

      expect(result).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'autechre', exact: false, negated: false },
        { operator: 'AND', field: 'album_title', value: 'confield', exact: false, negated: false },
      ]);
    });
  });
});
