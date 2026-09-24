/**
 * The mysqldump VALUES tokenizer (BS#2669).
 *
 * BS#2669 warns against hand-rolling "a fragile INSERT tokenizer". This suite
 * is the answer to that: every escaping rule the parser claims to handle is
 * enumerated here, and the parser's failure mode is a thrown error rather than
 * a short row — because a silently truncated read would under-count the exact
 * coverage figure the whole ticket exists to produce.
 *
 * The literals below are written the way `mysqldump` writes them: a backslash
 * escape is two characters in the file, so it is two characters in the TS
 * source too (`\\'` in a single-quoted TS string is backslash + quote).
 */

import { parseValuesClause } from '../../../../jobs/library-label-backfill/dump';

describe('parseValuesClause', () => {
  it('parses a single tuple', () => {
    expect(parseValuesClause("(1,'Sub Pop',NULL)")).toEqual([['1', 'Sub Pop', null]]);
  });

  it('parses several tuples and a trailing semicolon', () => {
    expect(parseValuesClause("(1,'a'),(2,'b');")).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
  });

  it('distinguishes SQL NULL from the string "NULL"', () => {
    expect(parseValuesClause("(NULL,'NULL')")).toEqual([[null, 'NULL']]);
  });

  it('keeps an empty string as an empty string, not NULL', () => {
    expect(parseValuesClause("('',0)")).toEqual([['', '0']]);
  });

  describe('escaping', () => {
    it.each([
      ["('HONEST JON\\'S')", "HONEST JON'S"],
      ["('a\\\\b')", 'a\\b'],
      ["('line1\\nline2')", 'line1\nline2'],
      ["('col1\\tcol2')", 'col1\tcol2'],
      ["('carriage\\rreturn')", 'carriage\rreturn'],
      ['(\'say \\"hi\\"\')', 'say "hi"'],
      ["('nul\\0byte')", 'nul\0byte'],
      // MySQL's escape for U+001A. The expected value is built with
      // fromCharCode so no raw control byte lands in this source file.
      ["('ctrl\\Z')", 'ctrl' + String.fromCharCode(0x1a)],
      ["('back\\bspace')", 'back\bspace'],
    ])('resolves %s', (clause, expected) => {
      expect(parseValuesClause(clause)).toEqual([[expected]]);
    });

    it('keeps the backslash on the LIKE pattern escapes', () => {
      // MySQL preserves `\%` and `\_` inside a string literal.
      expect(parseValuesClause("('100\\% Silk')")).toEqual([['100\\% Silk']]);
      expect(parseValuesClause("('a\\_b')")).toEqual([['a\\_b']]);
    });

    it('resolves an unrecognised escape to the escaped character itself', () => {
      // MySQL's own rule: `\q` is `q`.
      expect(parseValuesClause("('\\q')")).toEqual([['q']]);
    });

    it('accepts doubled quotes as well as backslash-escaped ones', () => {
      // mysqldump emits `\'`, but a NO_BACKSLASH_ESCAPES dump doubles instead.
      expect(parseValuesClause("('HONEST JON''S')")).toEqual([["HONEST JON'S"]]);
    });
  });

  describe('structural characters inside strings are not structure', () => {
    it.each([
      ["('Warner, Elektra, Atlantic')", 'Warner, Elektra, Atlantic'],
      ["('Rough Trade (US)')", 'Rough Trade (US)'],
      ["('4AD),(fake')", '4AD),(fake'],
      ["('ends with semicolon;')", 'ends with semicolon;'],
    ])('%s stays one field', (clause, expected) => {
      expect(parseValuesClause(clause)).toEqual([[expected]]);
    });
  });

  it('parses a realistic FLOWSHEET_ENTRY_PROD row at the documented column indices', () => {
    // Verbatim from the archived dump (row id 8), trimmed to the first nine
    // columns. LIBRARY_RELEASE_ID is index 6, LABEL_NAME index 8.
    const clause =
      "(8,'Bettye Swann',0,'myheart is closed for the season','s/t',0,47312,11413,'HONEST JON\\'S/ASTRALWERKS')";
    const [row] = parseValuesClause(clause);
    expect(row[6]).toBe('47312');
    expect(row[8]).toBe("HONEST JON'S/ASTRALWERKS");
  });

  it('handles whitespace between tuples', () => {
    expect(parseValuesClause("(1,'a'), (2,'b') ;")).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
  });

  it('preserves non-ASCII bytes', () => {
    expect(parseValuesClause("('Csillagrablók')")).toEqual([['Csillagrablók']]);
  });

  describe('fails loudly rather than returning a short row', () => {
    it.each([
      ['unterminated string', "(1,'abc"],
      ['unbalanced parenthesis', "(1,'a'"],
      ['dangling backslash', "(1,'a\\"],
      ['stray text after the terminator', "(1,'a'); oops"],
      ['a tuple that does not start with (', "1,'a'"],
    ])('throws on %s', (_label, clause) => {
      expect(() => parseValuesClause(clause)).toThrow();
    });
  });
});
