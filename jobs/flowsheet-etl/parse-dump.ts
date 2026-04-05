/**
 * MySQL dump parser for the flowsheet ETL bulk load mode.
 *
 * Parses INSERT INTO statements from a mysqldump file, extracting tuple values.
 * Handles MySQL-specific escaping: backslash escapes within single-quoted strings,
 * NULL literals, and numeric values.
 */

type TupleValue = string | number | null;

/**
 * Parse a single value from a MySQL INSERT tuple.
 * Advances the position past the value and returns the parsed result.
 *
 * Handles:
 * - 'string' with \\, \', \n, \r, \t, \0 escapes
 * - NULL literal
 * - Numeric values (integers and floats)
 */
const parseValue = (line: string, start: number): { value: TupleValue; end: number } | null => {
  if (start >= line.length) return null;
  const ch = line[start];

  // String literal
  if (ch === "'") {
    let i = start + 1;
    let str = '';
    while (i < line.length) {
      if (line[i] === '\\') {
        i++;
        if (i >= line.length) break;
        const escaped = line[i];
        if (escaped === 'n') str += '\n';
        else if (escaped === 'r') str += '\r';
        else if (escaped === 't') str += '\t';
        else if (escaped === '0') str += '\0';
        else str += escaped; // \', \\, etc.
        i++;
      } else if (line[i] === "'") {
        return { value: str, end: i + 1 };
      } else {
        str += line[i];
        i++;
      }
    }
    return null; // unterminated string
  }

  // NULL literal
  if (line.slice(start, start + 4) === 'NULL') {
    return { value: null, end: start + 4 };
  }

  // Numeric value
  let i = start;
  if (line[i] === '-') i++;
  while (i < line.length && ((line[i] >= '0' && line[i] <= '9') || line[i] === '.')) {
    i++;
  }
  if (i > start) {
    const num = Number(line.slice(start, i));
    return Number.isFinite(num) ? { value: num, end: i } : null;
  }

  return null;
};

/**
 * Parse a single tuple from a MySQL INSERT VALUES clause.
 * Example: (1,'hello',NULL,42)
 *
 * Returns the parsed values array and the position after the closing paren.
 */
export const parseTuple = (line: string, start: number): { values: TupleValue[]; end: number } | null => {
  if (line[start] !== '(') return null;

  const values: TupleValue[] = [];
  let pos = start + 1;

  while (pos < line.length) {
    // Skip whitespace
    while (pos < line.length && line[pos] === ' ') pos++;

    if (line[pos] === ')') {
      return { values, end: pos + 1 };
    }

    const result = parseValue(line, pos);
    if (!result) return null;

    values.push(result.value);
    pos = result.end;

    // Skip comma between values
    while (pos < line.length && line[pos] === ' ') pos++;
    if (line[pos] === ',') pos++;
  }

  return null; // unterminated tuple
};

/**
 * Parse all tuples from a MySQL INSERT INTO line.
 * Example: INSERT INTO `tablename` VALUES (1,'a',NULL),(2,'b',3);
 *
 * Returns the table name and array of tuple values.
 */
export const parseInsertLine = (line: string): { table: string; tuples: TupleValue[][] } | null => {
  const match = line.match(/^INSERT INTO `([^`]+)` VALUES\s*/);
  if (!match) return null;

  const table = match[1];
  const tuples: TupleValue[][] = [];
  let pos = match[0].length;

  while (pos < line.length) {
    if (line[pos] === '(') {
      const result = parseTuple(line, pos);
      if (!result) break;
      tuples.push(result.values);
      pos = result.end;

      // Skip comma or semicolon between tuples
      while (pos < line.length && (line[pos] === ',' || line[pos] === ' ')) pos++;
      if (line[pos] === ';') break;
    } else {
      break;
    }
  }

  return tuples.length > 0 ? { table, tuples } : null;
};
