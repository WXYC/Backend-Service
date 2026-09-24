/**
 * Streaming reader for a `mysqldump` extended-INSERT dump (BS#2669).
 *
 * The archived tubafrenzy capture is a stock `mysqldump 10.13` file: one
 * `INSERT INTO \`TABLE\` VALUES (...),(...),(...);` statement per line, with
 * MySQL's backslash escaping inside single-quoted strings. mysqldump escapes
 * newlines as the two characters `\` `n` rather than emitting them raw, so a
 * statement never spans lines — but {@link readStatements} tracks quote state
 * anyway and joins continuation lines, so a dump written with a different
 * escaping setting degrades into slowness rather than into silent truncation.
 *
 * Why hand-rolled rather than `wxyc_etl.parser.iter_table_rows` (the Rust
 * parser the sibling ETL repos use): that binding is Python-only and is not
 * installed in this repo, which has no Python in CI at all. Adding a PyO3
 * wheel and a Python test lane to Backend-Service for one read-only analysis
 * costs more than it buys. The mitigation for "hand-rolled is fragile" is that
 * {@link parseValuesClause} is a pure function with the escaping rules
 * enumerated in its own unit suite, and that the job cross-checks its totals
 * against independently measured figures (see this job's README).
 */

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

/**
 * MySQL's single-quote string escapes, as emitted by `mysqldump`.
 *
 * `\0` and `\Z` are the two that a naive "backslash escapes the next
 * character" reader gets right by accident and a lookup table gets right on
 * purpose. Anything not listed here resolves to the escaped character itself,
 * which is MySQL's own rule for an unrecognised escape (`\q` is `q`).
 */
const ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '%': '\\%',
  _: '\\_',
};

/** One parsed row: a column is `null` for SQL NULL, otherwise its text. */
export type DumpRow = (string | null)[];

/**
 * Parse the `VALUES` clause of a mysqldump INSERT into rows.
 *
 * @param clause - everything after `VALUES`, i.e. `(1,'a'),(2,NULL)`, with or
 *                 without a trailing semicolon
 * @returns one entry per tuple, each a list of column values
 * @throws if the clause is malformed (unterminated string, unbalanced
 *         parentheses, stray text between tuples) — a parse that cannot be
 *         trusted must fail loudly, never return a short row
 */
export function parseValuesClause(clause: string): DumpRow[] {
  const rows: DumpRow[] = [];
  let i = 0;
  const n = clause.length;

  const skipSpace = () => {
    while (i < n && /\s/.test(clause[i])) i++;
  };

  skipSpace();
  while (i < n) {
    if (clause[i] === ';') {
      skipSpace();
      i++;
      skipSpace();
      if (i < n) throw new Error(`trailing text after statement terminator at offset ${i}`);
      break;
    }
    if (clause[i] !== '(') {
      throw new Error(`expected '(' at offset ${i}, found ${JSON.stringify(clause[i])}`);
    }
    i++; // consume '('

    const row: DumpRow = [];
    let field = '';
    let quoted = false;

    for (;;) {
      if (i >= n) throw new Error('unterminated tuple: end of input inside VALUES');
      const ch = clause[i];

      if (ch === "'") {
        // Opening quote. Consume through the matching close, resolving escapes.
        // Copied in runs between escapes rather than character by character:
        // the dump is ~700 MB of mostly escape-free text, and per-character
        // string concatenation over it is the difference between seconds and
        // minutes.
        quoted = true;
        i++;
        for (;;) {
          if (i >= n) throw new Error('unterminated string literal');
          const quote = clause.indexOf("'", i);
          const backslash = clause.indexOf('\\', i);
          const stop = backslash === -1 || (quote !== -1 && quote < backslash) ? quote : backslash;
          if (stop === -1) throw new Error('unterminated string literal');

          if (stop > i) field += clause.slice(i, stop);
          i = stop;

          if (clause[i] === '\\') {
            const next = clause[i + 1];
            if (next === undefined) throw new Error('dangling backslash at end of input');
            field += ESCAPES[next] ?? next;
            i += 2;
            continue;
          }
          // `''` inside a quoted string is a literal quote (MySQL accepts both
          // this and `\'`; mysqldump emits `\'`, but a dump produced with
          // NO_BACKSLASH_ESCAPES uses doubling, so handle both).
          if (clause[i + 1] === "'") {
            field += "'";
            i += 2;
            continue;
          }
          i++; // closing quote
          break;
        }
        continue;
      }

      if (ch === ',' || ch === ')') {
        row.push(!quoted && field.trim().toUpperCase() === 'NULL' ? null : quoted ? field : field.trim());
        field = '';
        quoted = false;
        i++;
        if (ch === ')') break;
        continue;
      }

      // Unquoted run (a number, NULL, or whitespace): copy to the next
      // structural character in one slice rather than one character at a time.
      let j = i;
      while (j < n) {
        const c = clause[j];
        if (c === ',' || c === ')' || c === "'") break;
        j++;
      }
      if (j === i) throw new Error(`unexpected character at offset ${i}`);
      field += clause.slice(i, j);
      i = j;
    }

    rows.push(row);
    skipSpace();
    if (i < n && clause[i] === ',') {
      i++;
      skipSpace();
    }
  }

  return rows;
}

/**
 * Stream statement text out of a gzipped SQL dump, one logical statement per
 * yield, filtered to the INSERTs for a single table.
 *
 * A statement is complete when its line ends in `;`. mysqldump escapes
 * newlines inside values as the two characters `\` `n`, so in practice every
 * statement is exactly one line; the continuation buffer exists so that a dump
 * written with raw newlines is re-joined rather than truncated. The one shape
 * neither handles is a raw newline in a value whose first fragment happens to
 * end in `;` — that splits early, and {@link parseValuesClause} then throws on
 * the unterminated string. Failing loudly on a dump this reader cannot read is
 * the point: a short read would silently under-count the very coverage this
 * job exists to measure.
 *
 * @param path - path to the `.sql.gz` dump
 * @param table - unquoted table name, e.g. `FLOWSHEET_ENTRY_PROD`
 */
async function* readInsertStatements(path: string, table: string): AsyncGenerator<string> {
  const prefix = `INSERT INTO \`${table}\` VALUES `;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied dump path; this job is read-only
  const stream = createReadStream(path).pipe(createGunzip());
  const decoder = new StringDecoder('utf8');

  let carry = '';
  let pending: string | null = null;

  const handle = function* (line: string): Generator<string> {
    if (pending !== null) {
      pending += '\n' + line;
      if (line.endsWith(';')) {
        yield pending.slice(prefix.length);
        pending = null;
      }
      return;
    }
    if (!line.startsWith(prefix)) return;
    if (line.endsWith(';')) {
      yield line.slice(prefix.length);
      return;
    }
    pending = line;
  };

  for await (const chunk of stream) {
    carry += decoder.write(chunk as Buffer);
    let nl = carry.indexOf('\n');
    while (nl !== -1) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      yield* handle(line);
      nl = carry.indexOf('\n');
    }
  }
  carry += decoder.end();
  if (carry !== '') yield* handle(carry);
  if (pending !== null) throw new Error('dump ended inside an unterminated INSERT statement');
}

/**
 * Stream every row of one table out of a gzipped mysqldump.
 *
 * @param path - path to the `.sql.gz` dump
 * @param table - unquoted table name
 * @yields each row as a list of column values, in dump order
 */
export async function* iterTableRows(path: string, table: string): AsyncGenerator<DumpRow> {
  for await (const clause of readInsertStatements(path, table)) {
    yield* parseValuesClause(clause);
  }
}
