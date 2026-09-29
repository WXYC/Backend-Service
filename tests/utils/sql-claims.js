/**
 * Executable database-behaviour claims in docs (WXYC/Backend-Service#2737).
 *
 * A prose claim about what Postgres does ("`to_tsquery('simple', $$'-3d':*$$)`
 * lexes to `'-3':* <-> 'd':*`") is checkable in seconds and, left as prose, is
 * checked by nobody. ADR 0015 took four review rounds, and three of its fix
 * commits each introduced a new false claim of exactly this kind. This module
 * parses such claims out of markdown and evaluates them, so a wrong one fails
 * `tests/integration/doc-sql-claims.spec.js` by file:line instead of surviving
 * review.
 *
 * ## Grammar (the one place it is documented)
 *
 * A claim block is a fenced code block whose info string is exactly
 * `sql-claim`, opened with three backticks at column 0:
 *
 *     ```sql-claim
 *     to_tsquery('simple', $$'-transient':*$$)  ->  'transient':*   -- a comment
 *     to_tsvector('simple', 'Minus 5 -3d World') @@ to_tsquery('simple', $$'3d':*$$)  ->  false
 *     ```
 *
 * - One claim per line: `<expression> -> <expected>`. The separator is `->`
 *   with whitespace on both sides, outside any string literal; `<->` (the
 *   tsquery FOLLOWED BY operator) is not a separator.
 * - The claim asserts that `SELECT (<expression>)::text` returns exactly one
 *   row whose value equals `<expected>` character for character. A boolean
 *   claim (an `@@` match verdict) is the same form with `true` or `false` as
 *   the expected text, since that is how Postgres renders `boolean::text`.
 * - A trailing `-- comment` after the expected text is stripped. A `--` inside
 *   a quoted lexeme of the expected text (`'--foo'`) is not a comment.
 * - Blank lines and whole-line `-- comments` inside a block are ignored.
 * - Everything is strict. A block with zero claims, an unclosed block, a
 *   near-miss info string (`sql-claims`, `SQL-claim`, `sql-claim x`), an
 *   indented or tilde fence, a line with no separator, and an expression the
 *   lexer below does not accept are all errors naming file:line. Nothing is
 *   skipped: a skipped claim is a check that silently covers nothing.
 *
 * A claim is a single scalar expression over literals. It cannot read a table
 * (and the lexer rejects any attempt), so a claim like "matches 2,788 of the
 * 64,193 clone rows" stays prose.
 *
 * ## Read-only by construction
 *
 * The runner executes text taken from markdown, so it assumes the text is
 * hostile. Five independent layers, each pinned by a test that bypasses the
 * others (`tests/unit/utils/sql-claims.test.ts` for the lexer,
 * `tests/integration/doc-sql-claims.spec.js` for the rest):
 *
 * 1. **Lexical allowlist** (`assertSafeExpression`). The expression is
 *    tokenized and every token must be on a list: string literals (`'...'`
 *    and `$$...$$` only), plain numbers, `( ) ,`, the operators in
 *    `ALLOWED_OPERATORS`, `true`/`false`/`null`/`and`/`or`/`not`, a type name
 *    in `ALLOWED_TYPES` directly after `::`, and a function name in
 *    `ALLOWED_FUNCTIONS` directly before `(`. That rejects statement
 *    separators, every SQL keyword (so no `SELECT`, `FROM`, DDL or DML),
 *    qualified and quoted identifiers, comments, parameters, prefixed string
 *    literals (`E'…'`, `U&'…'`, whose escaping a naive lexer misreads), and
 *    unbalanced parentheses. Balanced parens are what keep the expression
 *    inside the `SELECT (…)::text` wrapper.
 * 2. **Extended query protocol.** The wrapped query is sent as one unnamed
 *    extended-protocol statement (`simple: false`), which the server refuses
 *    to parse if it holds more than one command (SQLSTATE 42601). postgres.js
 *    would otherwise send a parameterless `unsafe()` over the simple protocol,
 *    which accepts `;`-separated statements.
 * 3. **Read-only transaction, twice.** The connection is opened with
 *    `default_transaction_read_only=on` as a startup parameter, and every
 *    claim additionally runs inside `BEGIN READ ONLY`. Either alone rejects a
 *    write (SQLSTATE 25006).
 * 4. **Always rolled back.** The claim's transaction ends in ROLLBACK, never
 *    COMMIT, so even a side effect that escaped layers 1-3 does not persist.
 * 5. **Pinned session**, both as startup parameters and again by `SET LOCAL`
 *    inside each claim's transaction. `search_path=pg_catalog` (the only
 *    schema searched, so an unqualified application table does not resolve
 *    and an allowlisted function name resolves only among the built-ins),
 *    `statement_timeout` (a CPU- or sleep-bound expression is cancelled), and
 *    `standard_conforming_strings=on` (so a backslash inside `'…'` is literal,
 *    matching what the lexer assumes). `default_text_search_config` is pinned
 *    to `pg_catalog.simple` so a one-argument text-search call is
 *    deterministic regardless of the server's initdb locale.
 *
 * Layer 1 is still load-bearing on its own: a read-only transaction does not
 * stop `pg_sleep`, `pg_terminate_backend` or `set_config`. Layers 2-5 are
 * there so that a lexer bug is not, by itself, a way to write to the database.
 *
 * ### Why these functions
 *
 * `ALLOWED_FUNCTIONS` holds built-in text-search functions that are pure over
 * their arguments: they read nothing but the named text-search configuration
 * and write nothing. Deliberately excluded:
 * - `ts_stat` and `ts_rewrite(tsquery, text)`: their text argument is an SQL
 *   query that the function executes.
 * - `ts_debug`: set-returning, so it cannot satisfy "one scalar"; it would
 *   produce one row per token.
 * - `similarity` (pg_trgm): an extension function outside `pg_catalog`, so it
 *   does not resolve under the pinned `search_path`. Trigram claims stay prose.
 * Widening the list is a reviewable edit to this file; it is not something a
 * doc can do.
 *
 * ## Version sensitivity
 *
 * Text-search output is stable across recent Postgres majors but not
 * guaranteed forever. If a claim starts failing after a Postgres upgrade, the
 * check is working: the document's claim stopped being true on the version we
 * now run. Fix the document (and any code that relied on the old behaviour);
 * do not delete the check. Every claim in the docs today was verified on
 * PostgreSQL 18.6.
 */

const { readdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');

const ALLOWED_FUNCTIONS = new Set([
  'to_tsvector',
  'to_tsquery',
  'plainto_tsquery',
  'phraseto_tsquery',
  'websearch_to_tsquery',
  'setweight',
  'ts_delete',
  'strip',
  'numnode',
  'querytree',
  'tsquery_phrase',
  'ts_rank',
  'ts_rank_cd',
]);

const ALLOWED_TYPES = new Set(['text', 'tsquery', 'tsvector', 'regconfig', 'boolean', 'integer', 'real']);

const ALLOWED_WORDS = new Set(['true', 'false', 'null', 'and', 'or', 'not']);

const ALLOWED_OPERATORS = new Set(['@@', '||', '=', '<>', '<', '>', '<=', '>=']);

/** Postgres's operator character set: a maximal run of these lexes as one operator. */
const OPERATOR_CHARS = new Set('+-*/<>=~!@#%^&|`?');

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Session parameters sent in the startup packet (layers 3 and 5). */
const SESSION_PARAMETERS = {
  default_transaction_read_only: 'on',
  search_path: 'pg_catalog',
  statement_timeout: '2000',
  standard_conforming_strings: 'on',
  default_text_search_config: 'pg_catalog.simple',
};

class ClaimSyntaxError extends Error {}

function reject(message) {
  throw new ClaimSyntaxError(message);
}

function nextNonSpace(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/**
 * Layer 1: throw `ClaimSyntaxError` unless `expr` is one scalar expression
 * built only from allowlisted tokens (see the module header). Returns nothing.
 */
function assertSafeExpression(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') reject('empty expression');
  let depth = 0;
  let expectType = false;
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (expectType && !IDENT_START.test(c)) reject('`::` must be followed by a type name');

    if (c === "'") {
      if (i > 0 && /[A-Za-z0-9_$&']/.test(expr[i - 1])) {
        reject(`prefixed or adjacent string literal at column ${i + 1} (E'', U&'', B'' and X'' are not allowed)`);
      }
      i++;
      for (;;) {
        if (i >= expr.length) reject('unterminated string literal');
        if (expr[i] === "'") {
          if (expr[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      if (i < expr.length && IDENT_CHAR.test(expr[i]))
        reject(`identifier character directly after a string literal at column ${i + 1}`);
      continue;
    }

    if (c === '$') {
      if (expr[i + 1] !== '$')
        reject(`\`$\` at column ${i + 1}: only \`$$…$$\` dollar quotes are allowed (no parameters, no tagged quotes)`);
      if (i > 0 && IDENT_CHAR.test(expr[i - 1]))
        reject(`\`$$\` directly after an identifier character at column ${i + 1}`);
      const close = expr.indexOf('$$', i + 2);
      if (close < 0) reject('unterminated $$ string');
      i = close + 2;
      if (i < expr.length && IDENT_CHAR.test(expr[i]))
        reject(`identifier character directly after a $$ string at column ${i + 1}`);
      continue;
    }

    if (c === ';') reject('statement separator `;`');
    if (c === '"') reject('quoted identifier');
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) reject(`unbalanced \`)\` at column ${i + 1}`);
      depth--;
      i++;
      continue;
    }
    if (c === ',') {
      i++;
      continue;
    }
    if (c === ':') {
      if (expr[i + 1] !== ':') reject(`bare \`:\` at column ${i + 1}`);
      expectType = true;
      i += 2;
      continue;
    }

    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(expr.slice(i));
      i += m[0].length;
      if (i < expr.length && (IDENT_CHAR.test(expr[i]) || expr[i] === '.'))
        reject(`malformed number at column ${i + 1}`);
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      if (expr[j] === '$') reject(`\`$\` inside an identifier at column ${j + 1}`);
      if (expr[j] === '.') reject(`qualified name at column ${i + 1}`);
      const word = expr.slice(i, j).toLowerCase();
      const after = nextNonSpace(expr, j);
      if (expectType) {
        if (!ALLOWED_TYPES.has(word)) reject(`type \`${word}\` is not in ALLOWED_TYPES`);
        if (expr[after] === '(' || expr[after] === '[') reject(`type modifier on \`${word}\``);
        expectType = false;
      } else if (expr[after] === '(') {
        if (!ALLOWED_FUNCTIONS.has(word)) reject(`function \`${word}\` is not in ALLOWED_FUNCTIONS`);
      } else if (!ALLOWED_WORDS.has(word)) {
        reject(`\`${word}\` is not an allowed word (no keywords, identifiers or table references)`);
      }
      i = j;
      continue;
    }

    if (OPERATOR_CHARS.has(c)) {
      let j = i;
      while (j < expr.length && OPERATOR_CHARS.has(expr[j])) j++;
      const op = expr.slice(i, j);
      if (op.includes('--') || op.includes('/*')) reject(`comment at column ${i + 1}`);
      if (!ALLOWED_OPERATORS.has(op)) reject(`operator \`${op}\` is not in ALLOWED_OPERATORS`);
      i = j;
      continue;
    }

    reject(`character ${JSON.stringify(c)} at column ${i + 1} is not allowed`);
  }
  if (expectType) reject('`::` must be followed by a type name');
  if (depth !== 0) reject('unbalanced `(`');
}

/**
 * Scan `s` outside single-quoted and `$$` literals and return the index of
 * the first match of `test(s, i)`, or -1. Throws on an unterminated literal.
 */
function scanOutsideLiterals(s, test, { dollarQuotes }) {
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1;
      if (i >= s.length) reject('unterminated string literal');
      i++;
      continue;
    }
    if (dollarQuotes && s[i] === '$' && s[i + 1] === '$') {
      const close = s.indexOf('$$', i + 2);
      if (close < 0) reject('unterminated $$ string');
      i = close + 2;
      continue;
    }
    if (test(s, i)) return i;
    i++;
  }
  return -1;
}

const isSeparator = (s, i) =>
  s[i] === '-' && s[i + 1] === '>' && /\s/.test(s[i - 1] || '') && /\s/.test(s[i + 2] || '');
const isCommentStart = (s, i) => s[i] === '-' && s[i + 1] === '-' && (i === 0 || /\s/.test(s[i - 1]));

/** Parse one claim line into `{ expr, expected }`. Throws `ClaimSyntaxError`. */
function parseClaimLine(line) {
  const sep = scanOutsideLiterals(line, isSeparator, { dollarQuotes: true });
  if (sep < 0) reject('no ` -> ` separator between expression and expected text');
  const expr = line.slice(0, sep).trim();
  let rest = line.slice(sep + 2);
  const comment = scanOutsideLiterals(rest, isCommentStart, { dollarQuotes: false });
  if (comment >= 0) rest = rest.slice(0, comment);
  const expected = rest.trim();
  if (expected === '') reject('empty expected text');
  if (scanOutsideLiterals(expected, isSeparator, { dollarQuotes: false }) >= 0)
    reject('more than one ` -> ` separator');
  assertSafeExpression(expr);
  return { expr, expected };
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Parse every `sql-claim` block in a markdown document.
 * @param {string} text  markdown source
 * @param {string} file  label used in `file:line` locations
 * @returns {{ claims: {file:string,line:number,expr:string,expected:string}[], errors: {file:string,line:number,message:string}[] }}
 */
function parseSqlClaims(text, file) {
  const lines = text.split('\n');
  const claims = [];
  const errors = [];
  const err = (line, message) => errors.push({ file, line, message });

  let n = 0;
  while (n < lines.length) {
    const m = FENCE.exec(lines[n]);
    if (!m) {
      n++;
      continue;
    }
    const [, indent, marker, infoRaw] = m;
    const info = infoRaw.trim();
    const openLine = n + 1;
    const isClaimFence = /^sql[-_ ]?claim/i.test(info);
    if (isClaimFence && (info !== 'sql-claim' || marker !== '```' || indent !== '')) {
      err(
        openLine,
        `malformed sql-claim fence ${JSON.stringify(lines[n])}: open it with exactly "\`\`\`sql-claim" at column 0`
      );
    }
    const closes = (l) => {
      const c = FENCE.exec(l);
      return c && c[2][0] === marker[0] && c[2].length >= marker.length && c[3].trim() === '';
    };
    let end = n + 1;
    while (end < lines.length && !closes(lines[end])) end++;
    if (end >= lines.length) {
      if (isClaimFence) err(openLine, 'unclosed sql-claim block');
      break;
    }
    if (info === 'sql-claim' && marker === '```' && indent === '') {
      let count = 0;
      for (let k = n + 1; k < end; k++) {
        const body = lines[k].trim();
        if (body === '' || body.startsWith('--')) continue;
        try {
          claims.push({ file, line: k + 1, ...parseClaimLine(body) });
          count++;
        } catch (e) {
          if (!(e instanceof ClaimSyntaxError)) throw e;
          err(k + 1, `${e.message}: ${body}`);
        }
      }
      if (count === 0) err(openLine, 'sql-claim block contains zero claims');
    }
    n = end + 1;
  }
  return { claims, errors };
}

/** Every `.md` file under `dir`, recursively, in a stable order. */
function findMarkdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) findMarkdownFiles(p, out);
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Parse every markdown file under `dir`; `label(path)` names each file in locations. */
function collectSqlClaims(dir, label = (p) => p) {
  const claims = [];
  const errors = [];
  for (const path of findMarkdownFiles(dir)) {
    const r = parseSqlClaims(readFileSync(path, 'utf8'), label(path));
    claims.push(...r.claims);
    errors.push(...r.errors);
  }
  return { claims, errors };
}

/** postgres.js options for the claim connection: add these to host/port/user/etc. */
function claimConnectionOptions(base) {
  return { ...base, max: 1, onnotice: () => {}, connection: { ...SESSION_PARAMETERS } };
}

const ROLLBACK = Symbol('sql-claim rollback');

/**
 * Evaluate `expr` WITHOUT the lexical check: layers 2-5 only. Exists so the
 * integration spec can prove those layers hold on their own. Everything else
 * calls `evaluateClaim`.
 */
async function evaluateWithoutLexicalCheck(sql, expr) {
  let rows;
  try {
    await sql.begin('read only', async (tx) => {
      await tx.unsafe(
        "SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '2s'; " +
          "SET LOCAL standard_conforming_strings = on; SET LOCAL default_text_search_config = 'pg_catalog.simple'"
      );
      rows = await tx.unsafe(`SELECT (${expr})::text AS v`, [], { simple: false, prepare: false });
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
  return rows[0].v;
}

/** Lexically check `expr`, then evaluate it read-only and return `(expr)::text`. */
async function evaluateClaim(sql, expr) {
  assertSafeExpression(expr);
  return evaluateWithoutLexicalCheck(sql, expr);
}

module.exports = {
  ALLOWED_FUNCTIONS,
  ALLOWED_TYPES,
  ALLOWED_WORDS,
  ALLOWED_OPERATORS,
  SESSION_PARAMETERS,
  ClaimSyntaxError,
  assertSafeExpression,
  parseClaimLine,
  parseSqlClaims,
  findMarkdownFiles,
  collectSqlClaims,
  claimConnectionOptions,
  evaluateClaim,
  evaluateWithoutLexicalCheck,
};
