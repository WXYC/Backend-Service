#!/usr/bin/env node
/**
 * Static check: the "Auth tables" one-liner in `CLAUDE.md` matches the set of
 * `auth_*` tables declared as `pgTable('auth_...', ...)` under
 * `shared/database/src/**` (BS#1573).
 *
 * Why this exists: in the ~30 days before it was written, the doc list rotted
 * twice in silence.
 *
 *   - June 2026: ADR 0008 (QR device authorization) added `auth_device_code`
 *     in migration `0110_qr-device-auth.sql`. The CLAUDE.md line was never
 *     updated. No test caught it.
 *   - July 2026 (BS#1571): the better-auth `oidcProvider` plugin's three
 *     tables (`auth_oauth_application`, `auth_oauth_access_token`,
 *     `auth_oauth_consent`) were missing from `@wxyc/database` entirely. The
 *     doc line looked "consistent" only because both sides were missing them.
 *     BS#1572 landed the tables and updated the doc; this check exists so the
 *     next such incident can't hide behind matching absences.
 *
 * The Better-Auth `oidcProvider` plugin's `modelName` mapping produces
 * DB-table names that differ from the JS export name (DB `auth_oauth_consent`
 * vs export `oauthConsent`). The doc lists DB names, so this script extracts
 * the string-literal argument to `pgTable(...)`, not the JS symbol.
 *
 * Scope: `auth_*` tables only. Domain tables (`wxyc_*`, `user_activity`,
 * `anonymous_devices`, flowsheet-related, etc.) have their own doc list and
 * their own drift risk — keeping this check tightly scoped avoids coupling it
 * to unrelated schema growth.
 *
 * Detection strategy:
 *   - Schema: walk every `.ts` file under `shared/database/src/` (excluding
 *     `migrations/`) and regex `pgTable\(\s*'(auth_[…]+)'` for every
 *     declaration. Walking a directory instead of a single hard-coded path
 *     survives a future split of `schema.ts` into `schema/auth.ts`,
 *     `schema/domain.ts`, etc. (BS#1581) — the check keeps working with no
 *     config file to remember to update.
 *   - Doc: locate the fenced block between `<!-- auth-tables-list:begin -->`
 *     and `<!-- auth-tables-list:end -->`; extract every backtick-quoted
 *     `auth_*` token from the body.
 *   - Diff the two sets. Any symmetric difference is a failure.
 *
 * No auto-fix by design. The doc line encodes intent (why a table was added,
 * ADR references, plugin substrate context) that a mechanical writer would
 * lose. Fail with a readable diff; a human updates the doc.
 *
 * Exit codes:
 *   0 — sets match
 *   2 — sentinel/config error (missing/duplicate/inverted sentinels in
 *       CLAUDE.md, or one of the required paths is missing)
 *   3 — schema and doc disagree (drift)
 *   4 — schema regex found zero auth_* tables (probably a moved/renamed file
 *       or a broken import; the repo always has at least `auth_user`)
 *
 * The exit-code split (BS#1583) lets a CI operator distinguish "the check is
 * broken" (2 or 4 — inspect the script/schema layout) from "someone forgot
 * to update the doc" (3 — edit CLAUDE.md). Historically both mapped to 1.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer cwd as repo root (so tests can point at a temp tree); fall back to
// the script's parent dir when cwd doesn't have the expected layout.
const REPO_ROOT_CWD = process.cwd();
const SCRIPT_REPO_ROOT = resolve(__dirname, '..');

// Directory to scan for schema declarations. Everything under this dir with
// a `.ts` extension is candidate source; `migrations/` is skipped explicitly
// (SQL only, no pgTable calls). Was a single hard-coded file until BS#1581 —
// switched to a directory walk so a future split of `schema.ts` into
// `schema/auth.ts`, `schema/domain.ts`, etc. keeps working without a config
// file to remember to update.
const SCHEMA_ROOT_REL = 'shared/database/src';
const SCHEMA_SKIP_DIRS = new Set(['migrations', 'legacy', 'types']);
const DOC_REL = 'CLAUDE.md';
const SENTINEL_BEGIN = '<!-- auth-tables-list:begin -->';
const SENTINEL_END = '<!-- auth-tables-list:end -->';

// Exit-code taxonomy (BS#1583). Named constants so switch-arms and tests
// don't hand-write literals.
export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_DRIFT = 3;
export const EXIT_ZERO_TABLES = 4;

// pgTable('auth_<name>', ...) — the string literal is the DB table name and
// is what the CLAUDE.md list enumerates. The JS export symbol (which may
// differ, e.g. `oauthConsent` -> 'auth_oauth_consent') is not what we compare.
//
// Character class matches [A-Za-z0-9_] to catch camelCased tables (e.g.
// `auth_UserV2`), and quote class includes backticks to catch template-literal
// args (`pgTable(\`auth_new\`, ...)`. Mirrors the shape in
// `scripts/schema-shape-report.mjs` (search for `pgTable` there — line
// numbers drift; the name is stable).
const PG_TABLE_RE = /pgTable\(\s*['"`](auth_[A-Za-z0-9_]+)['"`]/g;

// Backtick-quoted `auth_<name>` token inside the sentinel-fenced doc block.
// Same char-class extension as PG_TABLE_RE to stay symmetric.
const DOC_TOKEN_RE = /`(auth_[A-Za-z0-9_]+)`/g;

// Strip JS/TS line and block comments before regex extraction. A
// commented-out `// pgTable('auth_legacy', ...)` is not a declared table.
// Not a full JS parser — no template-literal or string tracking — but the
// schema file has no `//` or `/*` sequences inside strings today, and the
// worst case (over-strip) still fails safely on the diff step.
function stripJsComments(source) {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Strip HTML comments from a markdown body. A backticked `auth_*` inside
// `<!-- ... -->` is a TODO or prose note, not a claim about a real table.
function stripHtmlComments(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

// Strip triple-backtick fenced code blocks from a markdown body. Prevents a
// documentation example that happens to embed the sentinel comment (or a
// bogus `auth_*` token) from being counted as either a real sentinel or a
// real doc claim. Handles both ``` and ```lang forms (R4-6).
function stripFencedCodeBlocks(source) {
  return source.replace(/```[\s\S]*?```/g, '');
}

function fileExists(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function dirExists(abs) {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function pickRepoRoot() {
  // A repo root is one that has both the schema dir and CLAUDE.md at the
  // expected paths. Nothing else is required — the walk below discovers
  // whatever .ts files live inside.
  const layoutMatches = (root) => dirExists(join(root, SCHEMA_ROOT_REL)) && fileExists(join(root, DOC_REL));
  if (layoutMatches(REPO_ROOT_CWD)) return REPO_ROOT_CWD;
  // R3-5: when the test harness pins us to a temp root, don't silently fall
  // back to the real script-parent repo. A test that deletes one of the
  // required files to exercise the "cannot find <file>" path would otherwise
  // see a green run against the real repo — the exact silent-bypass class
  // this whole PR was written to close. Real callers (pre-push, CI) invoke
  // from the repo root; the fallback exists only for developers running the
  // script from a random cwd.
  if (process.env.AUTH_TABLES_DOC_FORCE_CWD === '1') return REPO_ROOT_CWD;
  if (layoutMatches(SCRIPT_REPO_ROOT)) return SCRIPT_REPO_ROOT;
  // Return cwd anyway so the missing-file error is reported against the
  // caller's expected root, not a surprising fallback path.
  return REPO_ROOT_CWD;
}

/**
 * Recursively collect every `.ts` file under `root`, skipping directory
 * names in SCHEMA_SKIP_DIRS. Returns absolute paths.
 */
function collectSchemaFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SCHEMA_SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

export function extractSchemaTables(source) {
  // Strip comments first so commented-out `pgTable(...)` calls (or
  // pseudo-declarations inside `/* ... */` block comments) don't inflate
  // the schema set. Line numbers below are computed from the stripped
  // source; a commented decl that's re-added later moves to its post-strip
  // line, but the error just points at the wrong line — the diff is still
  // correct.
  const stripped = stripJsComments(source);
  const tables = new Set();
  const lineByTable = new Map();
  PG_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = PG_TABLE_RE.exec(stripped)) !== null) {
    const name = m[1];
    tables.add(name);
    if (!lineByTable.has(name)) {
      const lineNo = stripped.slice(0, m.index).split('\n').length;
      lineByTable.set(name, lineNo);
    }
  }
  return { tables, lineByTable };
}

/**
 * Walk `schemaRoot` for `.ts` files and merge every `pgTable('auth_…')`
 * declaration into a single set. The value stored in `lineByTable` is
 * `{ relPath, lineNo }` so the drift-report can point at the exact file
 * that declares each table (relevant once schema.ts gets split — BS#1581).
 */
function extractSchemaTablesFromTree(schemaRoot, repoRoot) {
  const files = collectSchemaFiles(schemaRoot);
  const tables = new Set();
  const lineByTable = new Map();
  for (const abs of files) {
    const source = readFileSync(abs, 'utf8');
    const { tables: fileTables, lineByTable: fileLines } = extractSchemaTables(source);
    for (const t of fileTables) tables.add(t);
    for (const [t, lineNo] of fileLines) {
      if (!lineByTable.has(t)) {
        // Relative to the repo root so error messages stay copy-pasteable
        // regardless of where the check was invoked from.
        const relPath = abs.startsWith(repoRoot + '/') ? abs.slice(repoRoot.length + 1) : abs;
        lineByTable.set(t, { relPath, lineNo });
      }
    }
  }
  return { tables, lineByTable };
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`. Used to
 * assert exactly one begin/end sentinel — a duplicated sentinel silently
 * redefines the fenced block otherwise (F6).
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

export function extractDocBlock(source) {
  // Strip fenced code blocks first so a documentation example that embeds
  // the sentinel (```md ... <!-- auth-tables-list:begin --> ... ```) doesn't
  // inflate the sentinel count and trip the duplicate branch (R4-6).
  const stripped = stripFencedCodeBlocks(source);
  const beginCount = countOccurrences(stripped, SENTINEL_BEGIN);
  const endCount = countOccurrences(stripped, SENTINEL_END);
  if (beginCount === 0 || endCount === 0) {
    return { ok: false, reason: 'missing' };
  }
  if (beginCount > 1 || endCount > 1) {
    return { ok: false, reason: 'duplicate', beginCount, endCount };
  }
  const begin = stripped.indexOf(SENTINEL_BEGIN);
  const end = stripped.indexOf(SENTINEL_END);
  if (end < begin) {
    return { ok: false, reason: 'inverted' };
  }
  const bodyStart = begin + SENTINEL_BEGIN.length;
  const body = stripped.slice(bodyStart, end);
  const lineNo = stripped.slice(0, begin).split('\n').length;
  return { ok: true, body, lineNo };
}

export function extractDocTables(body) {
  // Strip HTML comments so a TODO like
  // `<!-- also list \`auth_ghost\` once BS#9999 lands -->` doesn't get
  // parsed as a real doc claim (F4).
  const stripped = stripHtmlComments(body);
  const tables = new Set();
  DOC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = DOC_TOKEN_RE.exec(stripped)) !== null) {
    tables.add(m[1]);
  }
  return tables;
}

export function main(repoRoot) {
  const schemaRoot = join(repoRoot, SCHEMA_ROOT_REL);
  const docPath = join(repoRoot, DOC_REL);

  if (!dirExists(schemaRoot)) {
    console.error(`check-auth-tables-doc: cannot find ${SCHEMA_ROOT_REL} (looked in ${repoRoot})`);
    return EXIT_CONFIG;
  }
  if (!fileExists(docPath)) {
    console.error(`check-auth-tables-doc: cannot find ${DOC_REL} (looked in ${repoRoot})`);
    return EXIT_CONFIG;
  }

  const docSource = readFileSync(docPath, 'utf8');

  const { tables: schemaTables, lineByTable: schemaLineByTable } = extractSchemaTablesFromTree(schemaRoot, repoRoot);

  // F3: hard-fail if the schema regex found zero tables. This repo will
  // always have at least `auth_user`. A zero-match usually means the regex
  // is broken (renamed import, quote-style change) or the whole schema
  // tree moved. Without this guard, an empty schema set silently matches
  // an empty doc set — the exact BS#1571 failure shape.
  if (schemaTables.size === 0) {
    console.error(
      `check-auth-tables-doc: found zero auth_* pgTable(...) declarations under ${SCHEMA_ROOT_REL}.\n` +
        `       this repo always has at least auth_user; a zero match probably means:\n` +
        `         - the schema tree was moved or renamed (SCHEMA_ROOT_REL is hard-coded)\n` +
        `         - pgTable was renamed at the import site (e.g. \`import { pgTable as pt }\`)\n` +
        `         - every schema file was drained without landing new tables somewhere else\n` +
        `       failing loudly rather than silently agreeing with an empty doc set.`
    );
    return EXIT_ZERO_TABLES;
  }

  const block = extractDocBlock(docSource);
  if (!block.ok) {
    if (block.reason === 'duplicate') {
      console.error(
        `check-auth-tables-doc: duplicate sentinel comments in ${DOC_REL} ` +
          `(begin ×${block.beginCount}, end ×${block.endCount}).\n` +
          `       exactly one of each is required. a duplicate begin sentinel silently\n` +
          `       redefines the fenced block — the parser slices from the first begin\n` +
          `       to the first end and drops the rest. remove the extra sentinels.`
      );
    } else if (block.reason === 'inverted') {
      console.error(
        `check-auth-tables-doc: inverted sentinel comments in ${DOC_REL} ` +
          `(end appears before begin).\n` +
          `       the end sentinel must follow the begin sentinel. this usually means\n` +
          `       one of the two was pasted in the wrong order during an edit. reorder\n` +
          `       so the block reads:\n` +
          `         ${SENTINEL_BEGIN}\n` +
          `         ...\n` +
          `         ${SENTINEL_END}`
      );
    } else if (block.reason === 'missing') {
      console.error(
        `check-auth-tables-doc: missing sentinel comments in ${DOC_REL}.\n` +
          `       expected the auth-tables line to be fenced between\n` +
          `         ${SENTINEL_BEGIN}\n` +
          `         ...\n` +
          `         ${SENTINEL_END}\n` +
          `       see BS#1573 for why the sentinels are load-bearing.`
      );
    } else {
      // Defensive: a new `reason` value was added to extractDocBlock but this
      // switch wasn't updated. Print a clean error + exit rather than a raw
      // Node stack trace so the failure UX matches every other branch above
      // (R4-8). The stack still names the file for anyone who wants it via
      // `node --stack-trace-limit`.
      console.error(
        `check-auth-tables-doc: unrecognized block failure reason: ${JSON.stringify(block.reason)}.\n` +
          `       this is a bug — extractDocBlock returned a reason the CLI switch\n` +
          `       doesn't handle. add a branch above or remove the unhandled reason\n` +
          `       from extractDocBlock.`
      );
    }
    return EXIT_CONFIG;
  }

  const docTables = extractDocTables(block.body);

  const missingInDoc = [...schemaTables].filter((t) => !docTables.has(t)).sort();
  const extraInDoc = [...docTables].filter((t) => !schemaTables.has(t)).sort();

  if (missingInDoc.length === 0 && extraInDoc.length === 0) {
    console.log(
      `PASS: ${schemaTables.size} auth_* table(s) under ${SCHEMA_ROOT_REL} match the CLAUDE.md sentinel-fenced list.`
    );
    return EXIT_OK;
  }

  console.error('');
  console.error(`FAIL: the auth-tables list in ${DOC_REL} has drifted from ${SCHEMA_ROOT_REL}.`);
  console.error(`      (fix by editing the sentinel-fenced line in ${DOC_REL}:${block.lineNo})`);
  console.error('');
  if (missingInDoc.length > 0) {
    console.error(`  missing from ${DOC_REL} (declared in schema but not documented):`);
    for (const t of missingInDoc) {
      const loc = schemaLineByTable.get(t);
      console.error(`    - ${t}   (${loc.relPath}:${loc.lineNo})`);
    }
    console.error('');
  }
  if (extraInDoc.length > 0) {
    console.error(`  extra in ${DOC_REL} (documented but not declared as a pgTable in schema):`);
    for (const t of extraInDoc) {
      console.error(`    - ${t}`);
    }
    console.error('');
  }
  console.error(`  BS#1573 for the rationale; BS#1571 / BS#1572 for the incidents that motivated the check.`);
  return EXIT_DRIFT;
}

if (isInvokedDirectly(import.meta.url)) {
  process.exit(main(pickRepoRoot()));
}
