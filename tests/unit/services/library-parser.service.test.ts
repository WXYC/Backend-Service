import { parseSearchQuery, CATALOG_PARSER_CONFIG } from '../../../apps/backend/services/search-parser.service';

const parse = (q: string) => parseSearchQuery(q, CATALOG_PARSER_CONFIG);

describe('parseSearchQuery (catalog config)', () => {
  describe('field prefixes', () => {
    it.each([
      ['artist:autechre', 'artist_name', 'autechre'],
      ['album:confield', 'album_title', 'confield'],
      ['label:warp', 'label', 'warp'],
    ])('parses %s as field=%s value=%s', (input, expectedField, expectedValue) => {
      expect(parse(input)).toEqual([
        { operator: 'AND', field: expectedField, value: expectedValue, exact: false, negated: false },
      ]);
    });
  });

  describe('flowsheet-only prefixes fall back to all', () => {
    it.each([
      ['song:poise', 'song:poise'],
      ['dj:jake', 'dj:jake'],
      ['date:2024-06-15', 'date:2024-06-15'],
      ['dateRange:2024-01-01..2024-12-31', 'dateRange:2024-01-01..2024-12-31'],
    ])('treats %s as a bare all-field term (no flowsheet prefixes in catalog)', (input, expected) => {
      // The catalog config does not register `song:`, `dj:`, `date:`, or
      // `dateRange:` prefixes, so the tokenizer sees a bare value containing
      // a colon — which it parses as a single all-field term.
      expect(parse(input)).toEqual([{ operator: 'AND', field: 'all', value: expected, exact: false, negated: false }]);
    });
  });

  describe('operators and quoting', () => {
    it('parses AND between fields', () => {
      expect(parse('artist:foo AND label:bar')).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'foo', exact: false, negated: false },
        { operator: 'AND', field: 'label', value: 'bar', exact: false, negated: false },
      ]);
    });

    it('parses OR between fields', () => {
      expect(parse('artist:foo OR artist:bar')).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'foo', exact: false, negated: false },
        { operator: 'OR', field: 'artist_name', value: 'bar', exact: false, negated: false },
      ]);
    });

    it('negates with NOT', () => {
      expect(parse('artist:foo AND NOT label:warp')).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'foo', exact: false, negated: false },
        { operator: 'AND', field: 'label', value: 'warp', exact: false, negated: true },
      ]);
    });

    it('parses quoted value as exact match', () => {
      expect(parse('artist:"Cat Power"')).toEqual([
        { operator: 'AND', field: 'artist_name', value: 'Cat Power', exact: true, negated: false },
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      expect(parse('')).toEqual([]);
    });

    it('treats a bare term as all-field', () => {
      expect(parse('stereolab')).toEqual([
        { operator: 'AND', field: 'all', value: 'stereolab', exact: false, negated: false },
      ]);
    });
  });
});
