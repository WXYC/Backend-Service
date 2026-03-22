/**
 * Unit tests for flowsheet-etl MySQL dump parser.
 *
 * Tests the pure parsing functions that extract data from MySQL dump INSERT lines.
 */

jest.mock('@wxyc/database', () => ({}));

import { parseTuple, parseInsertValues } from '../../../../jobs/flowsheet-etl/parse-dump';

describe('flowsheet-etl parse-dump', () => {
  describe('parseTuple', () => {
    it('parses a simple tuple with strings, numbers, and NULL', () => {
      const input = "(1,'hello',NULL,42)";
      const result = parseTuple(input, 1); // start after '('
      expect(result.values).toEqual([1, 'hello', null, 42]);
    });

    it('handles escaped single quotes in strings', () => {
      const input = "(1,'it\\'s a test')";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, "it's a test"]);
    });

    it('handles escaped backslashes in strings', () => {
      const input = "(1,'back\\\\slash')";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, 'back\\slash']);
    });

    it('handles escaped newlines and tabs in strings', () => {
      const input = "(1,'line\\none\\ttwo')";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, 'line\none\ttwo']);
    });

    it('handles string containing closing paren', () => {
      const input = "(1,'value (with parens)')";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, 'value (with parens)']);
    });

    it('handles string containing ),( sequence', () => {
      const input = "(1,'tricky),(value')";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, 'tricky),(value']);
    });

    it('handles empty string', () => {
      const input = "(1,'')";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, '']);
    });

    it('handles bigint values', () => {
      const input = '(1234567890000)';
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1234567890000]);
    });

    it('returns correct endIndex', () => {
      const input = "(1,'a'),next";
      const result = parseTuple(input, 1);
      expect(result.values).toEqual([1, 'a']);
      expect(result.endIndex).toBe(6); // index of ')'
    });
  });

  describe('parseInsertValues', () => {
    it('parses a single tuple from INSERT line', () => {
      const line = "INSERT INTO `SOME_TABLE` VALUES (1,'test',NULL);";
      const results = [...parseInsertValues(line)];
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual([1, 'test', null]);
    });

    it('parses multiple tuples from INSERT line', () => {
      const line = "INSERT INTO `TABLE` VALUES (1,'a'),(2,'b'),(3,'c');";
      const results = [...parseInsertValues(line)];
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual([1, 'a']);
      expect(results[1]).toEqual([2, 'b']);
      expect(results[2]).toEqual([3, 'c']);
    });

    it('handles tuple with many fields', () => {
      const line = "INSERT INTO `T` VALUES (1,'name',0,NULL,1234567890000,'label',2,3);";
      const results = [...parseInsertValues(line)];
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual([1, 'name', 0, null, 1234567890000, 'label', 2, 3]);
    });

    it('returns empty for non-INSERT lines', () => {
      expect([...parseInsertValues('-- comment')]).toHaveLength(0);
      expect([...parseInsertValues('DROP TABLE foo;')]).toHaveLength(0);
      expect([...parseInsertValues('')]).toHaveLength(0);
    });

    it('handles strings with commas', () => {
      const line = "INSERT INTO `T` VALUES (1,'hello, world');";
      const results = [...parseInsertValues(line)];
      expect(results[0]).toEqual([1, 'hello, world']);
    });
  });
});
