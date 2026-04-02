import { parseTuple, parseInsertLine } from '../../../../jobs/flowsheet-etl/parse-dump';

describe('flowsheet-etl parse-dump', () => {
  describe('parseTuple', () => {
    it('parses a simple tuple with string, number, and NULL', () => {
      const result = parseTuple("(1,'hello',NULL)", 0);
      expect(result).toEqual(expect.objectContaining({ values: [1, 'hello', null] }));
    });

    it('handles escaped single quotes', () => {
      const result = parseTuple("('it\\'s a test')", 0);
      expect(result).toEqual(expect.objectContaining({ values: ["it's a test"] }));
    });

    it('handles escaped backslashes', () => {
      const result = parseTuple("('path\\\\to\\\\file')", 0);
      expect(result).toEqual(expect.objectContaining({ values: ['path\\to\\file'] }));
    });

    it('handles escaped newlines and tabs', () => {
      const result = parseTuple("('line1\\nline2\\ttab')", 0);
      expect(result).toEqual(expect.objectContaining({ values: ['line1\nline2\ttab'] }));
    });

    it('handles negative numbers', () => {
      const result = parseTuple('(-42)', 0);
      expect(result).toEqual(expect.objectContaining({ values: [-42] }));
    });

    it('handles decimal numbers', () => {
      const result = parseTuple('(3.14)', 0);
      expect(result).toEqual(expect.objectContaining({ values: [3.14] }));
    });

    it('handles empty string', () => {
      const result = parseTuple("('')", 0);
      expect(result).toEqual(expect.objectContaining({ values: [''] }));
    });

    it('returns null for unterminated tuple', () => {
      expect(parseTuple("(1,'hello'", 0)).toBeNull();
    });

    it('parses tuple starting at non-zero offset', () => {
      const result = parseTuple("xxx(42,'test')", 3);
      expect(result).toEqual(expect.objectContaining({ values: [42, 'test'] }));
    });

    it('returns end position after closing paren', () => {
      const result = parseTuple("(1,'a'),rest", 0);
      expect(result).toEqual(expect.objectContaining({ end: 7 }));
    });
  });

  describe('parseInsertLine', () => {
    it('parses a single-tuple INSERT line', () => {
      const result = parseInsertLine(
        "INSERT INTO `PLAYLIST_SHOW` VALUES (1,'2023-10-15 20:00:00','2023-10-15 22:00:00');"
      );
      expect(result).toEqual({
        table: 'PLAYLIST_SHOW',
        tuples: [[1, '2023-10-15 20:00:00', '2023-10-15 22:00:00']],
      });
    });

    it('parses a multi-tuple INSERT line', () => {
      const line =
        "INSERT INTO `PLAYLIST_ENTRY` VALUES (1,10,0,'Autechre','Confield','VI Scose Poise','Warp',NULL,0,1,'2023-10-15 20:05:00'),(2,10,0,'Cat Power','Moon Pix','American Flag','Matador Records',NULL,0,2,'2023-10-15 20:10:00');";
      const result = parseInsertLine(line);
      expect(result).toEqual(
        expect.objectContaining({
          table: 'PLAYLIST_ENTRY',
          tuples: expect.arrayContaining([
            expect.arrayContaining([1, 10, 0, 'Autechre']),
            expect.arrayContaining([2, 10, 0, 'Cat Power']),
          ]),
        })
      );
      expect(result?.tuples).toHaveLength(2);
    });

    it('returns null for non-INSERT lines', () => {
      expect(parseInsertLine('-- This is a comment')).toBeNull();
      expect(parseInsertLine('CREATE TABLE `foo` ...')).toBeNull();
      expect(parseInsertLine('')).toBeNull();
    });

    it('handles strings with commas inside', () => {
      const line = "INSERT INTO `test` VALUES (1,'hello, world');";
      const result = parseInsertLine(line);
      expect(result?.tuples[0]).toEqual([1, 'hello, world']);
    });

    it('handles strings with parentheses inside', () => {
      const line = "INSERT INTO `test` VALUES (1,'value (with parens)');";
      const result = parseInsertLine(line);
      expect(result?.tuples[0]).toEqual([1, 'value (with parens)']);
    });

    it('handles NULL values correctly', () => {
      const line = "INSERT INTO `test` VALUES (1,NULL,NULL,'text');";
      const result = parseInsertLine(line);
      expect(result?.tuples[0]).toEqual([1, null, null, 'text']);
    });
  });
});
