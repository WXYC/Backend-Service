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
 *   LF and CRLF line endings are both read. The block closes at the next line
 *   of three or more backticks indented at most three spaces (a closer
 *   indented four is content under CommonMark, so it is read as a claim line
 *   and fails for lacking a separator).
 * - Everything is strict. Any line whose fence marker sits where a fence can
 *   start (the start of the line, after any leading whitespace, so a fence
 *   four or more spaces into list-item content counts, and any blockquote
 *   `>` or list-item `-`/`*`/`+`/`1.` prefixes) and is followed by
 *   `sql` and then `claim` (with format characters such as a zero-width space
 *   removed, then case- and NFKC-folded, so a Unicode hyphen, `{sql-claim}`
 *   and `{.sql .claim}` count) must be exactly `` ```sql-claim `` at column 0
 *   and outside every other code block, or it is an error. That catches
 *   near-miss info strings, indented, tilde, blockquoted and list-item
 *   openers (on the marker line or in the item's content), and an opener
 *   swallowed by an earlier fence someone forgot to
 *   close. A plain fence whose first content line is `sql-claim` is an error
 *   too ("info string must be on the fence line"). A block with zero claims,
 *   an unclosed block, a line with no separator, and an expression the lexer
 *   below does not accept are errors as well, all naming file:line. Nothing
 *   in those shapes is skipped: a skipped claim is a check that silently
 *   covers nothing.
 * - A fence marker mid-sentence is prose, not an opener, so a paragraph may
 *   mention `` ```sql-claim `` in inline code without tripping the check.
 * - Not executed: a claim block in any file outside docs/ (the static check
 *   `scripts/check-sql-claim-docs.mjs` fails one in any tracked .md, so it
 *   cannot land silently), and an HTML `<pre>` block, which is not a claim
 *   block and is not detected.
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
 *    COMMIT, so a transactional side effect that escaped layers 1-3 does not
 *    persist. A session-level advisory lock is not transactional and does
 *    persist, until the claim connection ends (see the residual list below).
 * 5. **Unprivileged session.** The claim connection logs in as a role that
 *    `createClaimRole` makes for this run only (`wxyc_sql_claim_<unix
 *    seconds>_<16 hex>`): LOGIN, not a superuser, no
 *    CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS, no grants. The spec drops it
 *    in afterAll. Its password is random and reaches the server only as a
 *    client-computed SCRAM-SHA-256 verifier, so the cleartext is never in
 *    SQL text or the server log, and the DDL that carries the verifier runs
 *    with logging and activity tracking switched off (`createClaimRole` lists
 *    each sink closed and the ones a SET LOCAL cannot reach). Because
 *    the SESSION user is unprivileged, a claim cannot re-escalate:
 *    `set_config('role', …)`, `set_config('session_authorization', …)`,
 *    `SET ROLE` and `RESET ROLE` all fail or stay on the claim role. So a
 *    superuser-only function the lexer admitted by mistake is refused
 *    (`pg_read_file`, including through `query_to_xml`), and so is
 *    terminating a superuser's backend. A superuser session that merely
 *    `SET ROLE`s to an unprivileged role does not give this: the same
 *    expression can `set_config('role', <superuser>, true)` back (measured on
 *    18.6 in review of an earlier revision that did exactly that).
 *    The session is also pinned, both as startup parameters and again by
 *    `SET LOCAL`: `search_path=pg_catalog` (the only schema searched, so an
 *    unqualified application table does not resolve and an allowlisted
 *    function name resolves only among the built-ins), `statement_timeout`
 *    (a CPU- or sleep-bound expression is cancelled), and
 *    `standard_conforming_strings=on` (so a backslash inside `'…'` is
 *    literal, matching what the lexer assumes). `default_text_search_config`
 *    is pinned to `pg_catalog.simple` so a one-argument text-search call is
 *    deterministic regardless of the server's initdb locale.
 *
 * Layer 1 is still load-bearing on its own. The lexer never admits
 * `set_config`, `current_setting`, `SET`, `RESET`, `current_user`,
 * `session_user`, a `regrole` cast or any `pg_advisory_*` function, so no
 * claim can reach the role machinery or take a lock. Residual risk if the
 * lexer were bypassed anyway, as the claim role inside a read-only
 * transaction: `pg_sleep` runs (the timeout bounds it); `set_config` of an
 * ordinary setting runs (the rollback undoes it); `pg_terminate_backend`
 * works against another backend logged in as the same claim role (only this
 * run's own claim connections); and a session-level advisory lock
 * (`pg_advisory_lock`) survives the rollback and is held until the claim
 * connection ends in afterAll, so a colliding key used by the app or another
 * spec in the same run would block until then. Layers 2-5 are there so that
 * a lexer bug is not, by itself, a way to write to the database or to act
 * with the privileges of the user the suite connects as. Measured on PG 18.6
 * logged in as a claim role inside `BEGIN READ ONLY`: `set_config('role',
 * 'postgres', true)` fails with "permission denied to set role",
 * `set_config('session_authorization', 'postgres', true)` with "permission
 * denied to set session authorization", `query_to_xml('select
 * pg_read_file(…)', …)` with "permission denied for function pg_read_file",
 * `RESET ROLE` leaves `current_user` on the claim role, and
 * `pg_terminate_backend` on another backend of the same role returns true.
 *
 * A run that crashes before afterAll leaves its role behind: a LOGIN role
 * with no grants whose password nobody knows. The next run's
 * `dropStaleClaimRoles` drops any claim role over an hour old (by the
 * timestamp in its name) that has no session logged in as it.
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
 * ## Where it runs
 *
 * - `tests/integration/doc-sql-claims.spec.js` evaluates every claim against
 *   Postgres. It runs in CI's Integration-Tests job, which a docs-only PR
 *   reaches only because each claim-bearing doc is listed in
 *   `.github/workflows/test.yml`'s `tests` paths-filter. The list is explicit
 *   rather than `docs/**` by maintainer decision.
 * - `scripts/check-sql-claim-docs.mjs` (`npm run check:sql-claim-docs`, also
 *   a hard-fail pre-push line) needs no database. It parses every block,
 *   compares each doc's claim count with `tests/utils/sql-claim-counts.json`
 *   (the one copy of that map; the spec reads it too), checks that the
 *   paths-filter lists exactly the claim-bearing docs, and fails any
 *   sql-claim block in a tracked .md outside docs/. It runs in the
 *   unconditional `auth-tables-doc-drift` job, so a docs-only PR fails there
 *   for any of those. What remains is that a claim's VALUE is checked only
 *   where Integration-Tests runs, which the filter guarantees for listed
 *   docs.
 *
 * ## Version sensitivity
 *
 * Text-search output is stable across recent Postgres majors but not
 * guaranteed forever. If a claim starts failing after a Postgres upgrade, the
 * check is working: the document's claim stopped being true on the version we
 * now run. Fix the document (and any code that relied on the old behaviour);
 * do not delete the check.
 *
 * What a green run certifies is the CI Postgres major, 18 (`postgres:18.0-alpine`
 * in `.github/workflows/test.yml`). It does NOT certify production RDS, which
 * runs PostgreSQL 14.22, a documented and intentional skew (BS#1424, noted on
 * the Integration-Tests service in test.yml). A claim can pass here and be
 * false on production if 14 and 18 disagree. The claims in the docs today
 * were measured on 18.6 locally and pass on CI's 18.0; none was checked on 14.
 *
 * The role setup is version-sensitive in the other direction: a newer major
 * can add a logging parameter that ROLE_DDL_QUIET_SETTINGS does not switch
 * off. See the leftover list on `createClaimRole` when the suite moves majors.
 */

const { createHash, createHmac, pbkdf2Sync, randomBytes } = require('crypto');
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

/** Allowed words that may directly precede `(` without being read as a function call. */
const PREFIX_KEYWORDS = new Set(['and', 'or', 'not']);

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
      } else if (expr[after] === '(' && !PREFIX_KEYWORDS.has(word)) {
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

/** A CommonMark fence line: at most three spaces of indent (four is an indented code block). */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** The only accepted opener, byte for byte. */
const CLAIM_OPENER = '```sql-claim';

/**
 * The text after a fence marker when the marker is where a fence can start,
 * else null. "Where a fence can start" means after any leading whitespace
 * (any amount: a fence inside list-item content sits four or more spaces in)
 * and any run of blockquote (`>`) or list-item (`-`, `*`, `+`, `1.`, `1)`)
 * prefixes. A fence marker mid-sentence (inline code, prose naming a fence)
 * is not an opener.
 *
 * The prefixes are stripped one at a time in a loop, each step consuming at
 * least one character with a non-nested regex, so a line of thousands of `>`
 * scans in linear time. A single regex with a quantified group inside
 * another backtracks exponentially on such a line (measured in review: 41 s
 * for 30 `>`).
 */
function textAfterOpenerMarker(line) {
  let rest = line.replace(/^[ \t]+/, '');
  for (let m; (m = /^(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])/.exec(rest)) !== null;) {
    rest = rest.slice(m[0].length).replace(/^[ \t]+/, '');
  }
  const marker = /^(?:`{3,}|~{3,})/.exec(rest);
  return marker === null ? null : rest.slice(marker[0].length);
}

/**
 * True when a line looks like it is trying to open a sql-claim block: a fence
 * marker where a fence can start (see `textAfterOpenerMarker`), followed by
 * `sql` and then `claim` after folding (`foldInfo`), so a Unicode hyphen, a
 * zero-width character, `{sql-claim}` and `{.sql .claim}` all count. Every
 * such line must be exactly `CLAIM_OPENER`, at top level, or it is an error.
 */
function looksLikeClaimOpener(line) {
  const info = textAfterOpenerMarker(line);
  return info !== null && /sql[\s\S]*claim/.test(foldInfo(info));
}

/** Drop format characters (zero-width space/joiner, BOM, …), then fold case and compatibility forms. */
function foldInfo(text) {
  return text
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .toLowerCase();
}

/**
 * Parse every `sql-claim` block in a markdown document. See the module
 * header for the grammar. Strict by design: a line that looks like a claim
 * opener but is not consumed as one is an error, never a skip.
 * @param {string} text  markdown source
 * @param {string} file  label used in `file:line` locations
 * @returns {{ claims: {file:string,line:number,expr:string,expected:string}[], errors: {file:string,line:number,message:string}[] }}
 */
function parseSqlClaims(text, file) {
  const lines = text.split(/\r?\n/);
  const claims = [];
  const errors = [];
  const err = (line, message) => errors.push({ file, line, message });
  const consumed = new Set();
  const enclosing = new Map(); // claim-looking line index -> line number of the plain fence swallowing it

  let n = 0;
  while (n < lines.length) {
    const m = FENCE.exec(lines[n]);
    if (!m || (m[2][0] === '`' && m[3].includes('`'))) {
      n++;
      continue;
    }
    const marker = m[2];
    const isClaim = lines[n] === CLAIM_OPENER;
    const closes = (l) => {
      const c = FENCE.exec(l);
      return c !== null && c[2][0] === marker[0] && c[2].length >= marker.length && c[3].trim() === '';
    };
    let end = n + 1;
    while (end < lines.length && !closes(lines[end])) end++;
    if (isClaim) {
      for (let k = n; k <= end && k < lines.length; k++) consumed.add(k);
      if (end >= lines.length) err(n + 1, 'unclosed sql-claim block');
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
      if (end < lines.length && count === 0) err(n + 1, 'sql-claim block contains zero claims');
    } else {
      for (let k = n + 1; k < end; k++) if (!enclosing.has(k)) enclosing.set(k, n + 1);
      if (n + 1 < lines.length && foldInfo(lines[n + 1].trim()) === 'sql-claim') {
        err(n + 2, `info string must be on the fence line: open the block with exactly "${CLAIM_OPENER}"`);
      }
    }
    n = end + 1;
  }

  lines.forEach((line, k) => {
    if (consumed.has(k) || !looksLikeClaimOpener(line)) return;
    const where = enclosing.has(k)
      ? `it is inside the code block opened at line ${enclosing.get(k)} (is that fence unclosed?)`
      : `open a block with exactly "${CLAIM_OPENER}" at column 0, outside any blockquote, list or other code block`;
    err(k + 1, `malformed sql-claim fence ${JSON.stringify(line)}: ${where}`);
  });
  errors.sort((a, b) => a.line - b.line);
  return { claims, errors };
}

/**
 * True when `text` holds a sql-claim block, or anything the parser reports as
 * a malformed attempt at one. The parser is the single definition.
 */
function mentionsSqlClaim(text) {
  const { claims, errors } = parseSqlClaims(text, '');
  return claims.length > 0 || errors.length > 0;
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

/**
 * postgres.js options for the claim connection. `base` supplies host, port
 * and database; the connection logs in as the role `createClaimRole` made,
 * with the credentials it returned, never as `base.user`.
 */
function claimConnectionOptions(base, credentials) {
  return {
    ...base,
    user: credentials.user,
    password: credentials.password,
    max: 1,
    onnotice: () => {},
    connection: { ...SESSION_PARAMETERS },
  };
}

const ROLLBACK = Symbol('sql-claim rollback');

/** Every claim role's name starts with this; the rest is `<unix seconds>_<16 hex>`. */
const CLAIM_ROLE_PREFIX = 'wxyc_sql_claim_';
const CLAIM_ROLE_NAME = new RegExp(`^${CLAIM_ROLE_PREFIX}(\\d{10})_[0-9a-f]{16}$`);
/** A leftover role older than this, with no session logged in as it, is from a crashed run. */
const STALE_CLAIM_ROLE_SECONDS = 3600;

const SUPERUSER_REQUIRED =
  'doc-sql-claims: the integration DB user must be a superuser. createClaimRole checks pg_roles.rolsuper for ' +
  'current_user before it does anything else, because it creates a per-run LOGIN role for the claims on a ' +
  'connection where it first switches statement logging and activity tracking off, to keep the role DDL out of the ' +
  "server's records. " +
  'CI uses the postgres image superuser POSTGRES_USER.';

/**
 * What `createClaimRole` switches off, with SET LOCAL, before the CREATE ROLE
 * that carries the verifier. `[name, value as SQL]`, grouped by sink:
 *
 * - server log: the statement itself, the statement attached to an error,
 *   duration and sampled-duration logging, and the parse / rewritten / plan
 *   tree dumps (written at LOG level whatever
 *   log_statement says; the parse tree holds the PASSWORD string);
 * - `pg_stat_activity.query`, which any role with pg_read_all_stats can poll;
 * - `pg_stat_statements.query`. The extension's parameter is set whether or
 *   not the extension is loaded: Postgres accepts a dotted name it does not
 *   know as a placeholder.
 *
 * Every non-dotted name here must exist on each Postgres the suite runs on:
 * SET LOCAL on an unknown one raises and aborts the transaction.
 *
 * `log_transaction_sample_rate` is not here. Whether a transaction is sampled
 * is decided when it begins, so a SET LOCAL inside it comes too late:
 * `createClaimRole` sets that one at session level before BEGIN instead.
 */
const ROLE_DDL_QUIET_SETTINGS = [
  ['log_statement', "'none'"],
  ['log_min_error_statement', "'panic'"],
  ['log_min_duration_statement', '-1'],
  ['log_min_duration_sample', '-1'],
  ['track_activities', 'off'],
  ['pg_stat_statements.track', "'none'"],
  ['debug_print_parse', 'off'],
  ['debug_print_rewritten', 'off'],
  ['debug_print_plan', 'off'],
];
/** ROLE_DDL_QUIET_SETTINGS as one `;`-separated statement batch. */
const ROLE_DDL_QUIET_BATCH = ROLE_DDL_QUIET_SETTINGS.map(([name, value]) => `SET LOCAL ${name} = ${value}`).join('; ');

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 5802 / RFC 7677), in the form
 * Postgres stores in pg_authid. Postgres accepts a verifier in `PASSWORD '…'`
 * as-is, so the cleartext never appears in SQL text or the server log.
 */
function scramSha256Verifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  const b64 = (buf) => buf.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/**
 * Create this run's claim role and return `{ user, password }` for
 * `claimConnectionOptions` (layer 5). The name is unique per call, so
 * concurrent runs against one database never touch each other's role, and the
 * password (random, never reused) goes to the server only as a SCRAM verifier.
 *
 * Call `dropClaimRole` once every connection logged in as it has ended.
 *
 * The verifier is kept out of the server's records as well. On one reserved
 * connection, `log_transaction_sample_rate` is set to 0 for the session, and
 * then the CREATE ROLE runs in a transaction whose first statement is
 * ROLE_DDL_QUIET_BATCH. Together they close the server log,
 * `pg_stat_activity` and `pg_stat_statements` (see ROLE_DDL_QUIET_SETTINGS).
 * The batch has to stay a separate statement sent before the CREATE ROLE:
 * the server logs a message's text, and reports it to `pg_stat_activity`,
 * when the message arrives, before any SET inside it has run.
 *
 * Not closed, because a SET LOCAL here cannot close them:
 * - an extension that logs utility statements through its own hook under its
 *   own parameter (pgaudit is the usual one). The suite loads none, so a
 *   setting for one would be untested;
 * - `debug_print_raw_parse`, which does not exist on 18.x, so setting it
 *   would abort the transaction. Add it to ROLE_DDL_QUIET_SETTINGS when the
 *   suite moves to a major that has it.
 * In either case what would be recorded is a verifier for a random 192-bit
 * password on a grant-less role dropped seconds later, not the password.
 *
 * Needs a writable connection whose user is a superuser, checked up front so
 * the failure names the requirement (see SUPERUSER_REQUIRED).
 */
async function createClaimRole(sql) {
  const [{ rolsuper }] = await sql.unsafe('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (!rolsuper) throw new Error(SUPERUSER_REQUIRED);
  const user = `${CLAIM_ROLE_PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  // One reserved connection, because the session-level setting, the
  // transaction and the RESET must all land on the same backend.
  const conn = await sql.reserve();
  return runThenCleanUp(async () => {
    await conn.unsafe('SET log_transaction_sample_rate = 0');
    await conn.unsafe('BEGIN');
    try {
      await conn.unsafe(ROLE_DDL_QUIET_BATCH);
      await conn.unsafe(
        `CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${scramSha256Verifier(password)}'`
      );
      await conn.unsafe('COMMIT');
    } catch (e) {
      // The original failure is the one to report, whatever ROLLBACK does.
      await conn.unsafe('ROLLBACK').catch(() => {});
      throw e;
    }
    return { user, password };
  }, [() => conn.unsafe('RESET log_transaction_sample_rate'), () => conn.release()]);
}

/**
 * Run `body`, then every cleanup step in order, whether or not the body or an
 * earlier step failed. Rejects with the first failure: the body's if it
 * failed, otherwise the first failing step's. Resolves to the body's result.
 *
 * A `finally` holding two awaits does neither: a rejecting first await skips
 * the second, and either one replaces the error that actually failed the
 * test. Not specific to claims; it lives here because the claim spec's role
 * and connection cleanup is its only caller.
 */
async function runThenCleanUp(body, steps) {
  const failures = [];
  let result;
  for (const [i, run] of [body, ...steps].entries()) {
    try {
      const value = await run();
      if (i === 0) result = value;
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length > 0) throw failures[0];
  return result;
}

/** Drop a role `createClaimRole` made. Refuses any other name. */
async function dropClaimRole(sql, user) {
  if (!CLAIM_ROLE_NAME.test(user)) throw new Error(`dropClaimRole: ${user} is not a claim role name`);
  await sql.unsafe(`DROP ROLE IF EXISTS ${user}`);
}

/**
 * Drop claim roles a crashed run left behind: older than
 * STALE_CLAIM_ROLE_SECONDS by the timestamp in their name, and with no
 * session logged in as them. A live run's role is younger than that or has
 * its connection open, so it is never touched. Concurrent runs may race to
 * drop the same orphan; losing that race is not an error. Returns the stale
 * names found.
 */
async function dropStaleClaimRoles(sql, nowSeconds = Math.floor(Date.now() / 1000)) {
  const rows = await sql.unsafe(
    `SELECT r.rolname FROM pg_roles r
     WHERE r.rolname LIKE '${CLAIM_ROLE_PREFIX}%'
       AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usename = r.rolname)`
  );
  const stale = rows
    .map((r) => r.rolname)
    .filter((name) => {
      const m = CLAIM_ROLE_NAME.exec(name);
      return m !== null && nowSeconds - Number(m[1]) > STALE_CLAIM_ROLE_SECONDS;
    });
  for (const name of stale) {
    try {
      await dropClaimRole(sql, name);
    } catch (e) {
      // Another run's cleanup may drop the same orphan at the same moment.
      // That is fine; anything else is not.
      const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${name}'`);
      if (n !== 0) throw e;
    }
  }
  return stale;
}

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
  CLAIM_ROLE_PREFIX,
  ROLE_DDL_QUIET_BATCH,
  ClaimSyntaxError,
  assertSafeExpression,
  parseClaimLine,
  parseSqlClaims,
  mentionsSqlClaim,
  findMarkdownFiles,
  collectSqlClaims,
  claimConnectionOptions,
  createClaimRole,
  dropClaimRole,
  dropStaleClaimRoles,
  runThenCleanUp,
  scramSha256Verifier,
  evaluateClaim,
  evaluateWithoutLexicalCheck,
};
