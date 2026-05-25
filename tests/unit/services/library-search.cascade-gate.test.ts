import { parseSearchQuery, CATALOG_PARSER_CONFIG } from '../../../apps/backend/services/search-parser.service';
import { isPlainTextQuery, MAX_CASCADE_CONDITIONS } from '../../../apps/backend/services/library-search.service';

const parse = (q: string) => parseSearchQuery(q, CATALOG_PARSER_CONFIG);

describe('isPlainTextQuery (catalog cascade gate)', () => {
  describe('accepts', () => {
    it('single bareword', () => {
      expect(isPlainTextQuery(parse('autechre'))).toBe(true);
    });

    it('multi-bareword AND-joined (the bug fix case)', () => {
      expect(isPlainTextQuery(parse('vi scose poise'))).toBe(true);
    });

    it('multi-bareword with explicit AND', () => {
      expect(isPlainTextQuery(parse('vi AND scose AND poise'))).toBe(true);
    });
  });

  describe('rejects', () => {
    it('empty conditions', () => {
      expect(isPlainTextQuery(parse(''))).toBe(false);
    });

    it('field-prefixed query', () => {
      expect(isPlainTextQuery(parse('artist:autechre'))).toBe(false);
    });

    it('mixed bareword + field-prefixed', () => {
      expect(isPlainTextQuery(parse('vi scose artist:autechre'))).toBe(false);
    });

    it('exact-match (quoted)', () => {
      expect(isPlainTextQuery(parse('"vi scose poise"'))).toBe(false);
    });

    it('NOT-negated condition', () => {
      expect(isPlainTextQuery(parse('vi NOT scose'))).toBe(false);
    });

    it('OR-joined conditions', () => {
      expect(isPlainTextQuery(parse('vi OR scose'))).toBe(false);
    });

    it('more than MAX_CASCADE_CONDITIONS conditions (pathological multi-word)', () => {
      const tooMany = Array.from({ length: MAX_CASCADE_CONDITIONS + 1 }, (_, i) => `w${i}`).join(' ');
      expect(isPlainTextQuery(parse(tooMany))).toBe(false);
    });

    it('exactly MAX_CASCADE_CONDITIONS conditions still accepted', () => {
      const atCap = Array.from({ length: MAX_CASCADE_CONDITIONS }, (_, i) => `w${i}`).join(' ');
      expect(isPlainTextQuery(parse(atCap))).toBe(true);
    });
  });
});
