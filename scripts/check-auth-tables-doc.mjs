#!/usr/bin/env node
/**
 * Static check: the "Auth tables" one-liner in `CLAUDE.md` matches the set of
 * `auth_*` tables declared as `pgTable('auth_...', ...)` in
 * `shared/database/src/schema.ts` (BS#1573).
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
 *   - Schema: regex `pgTable\(\s*'(auth_[a-z0-9_]+)'` for every declaration.
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
 *   1 — sets differ, sentinels missing/duplicated/inverted, schema has zero
 *       auth_* tables, or one of the required files is missing
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer cwd as repo root (so tests can point at a temp tree); fall back to
// the script's parent dir when cwd doesn't have the expected layout.
const REPO_ROOT_CWD = process.cwd();
const SCRIPT_REPO_ROOT = resolve(__dirname, '..');

const SCHEMA_REL = 'shared/database/src/schema.ts';
const DOC_REL = 'CLAUDE.md';
const SENTINEL_BEGIN = '<!-- auth-tables-list:begin -->';
const SENTINEL_END = '<!-- auth-tables-list:end -->';

// pgTable('auth_<name>', ...) — the string literal is the DB table name and
// is what the CLAUDE.md list enumerates. The JS export symbol (which may
// differ, e.g. `oauthConsent` -> 'auth_oauth_consent') is not what we compare.
//
// Character class matches [A-Za-z0-9_] to catch camelCased tables (e.g.
// `auth_UserV2`), and quote class includes backticks to catch template-literal
// args (`pgTable(\`auth_new\`, ...)`. Mirrors the shape in
// `scripts/schema-shape-report.mjs`.
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

function fileExists(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function pickRepoRoot() {
  const layoutMatches = (root) => fileExists(join(root, SCHEMA_REL)) && fileExists(join(root, DOC_REL));
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

function extractSchemaTables(source) {
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

function extractDocBlock(source) {
  const beginCount = countOccurrences(source, SENTINEL_BEGIN);
  const endCount = countOccurrences(source, SENTINEL_END);
  if (beginCount === 0 || endCount === 0) {
    return { ok: false, reason: 'missing' };
  }
  if (beginCount > 1 || endCount > 1) {
    return { ok: false, reason: 'duplicate', beginCount, endCount };
  }
  const begin = source.indexOf(SENTINEL_BEGIN);
  const end = source.indexOf(SENTINEL_END);
  if (end < begin) {
    return { ok: false, reason: 'inverted' };
  }
  const bodyStart = begin + SENTINEL_BEGIN.length;
  const body = source.slice(bodyStart, end);
  const lineNo = source.slice(0, begin).split('\n').length;
  return { ok: true, body, lineNo };
}

function extractDocTables(body) {
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

function main(repoRoot) {
  const schemaPath = join(repoRoot, SCHEMA_REL);
  const docPath = join(repoRoot, DOC_REL);

  if (!fileExists(schemaPath)) {
    console.error(`check-auth-tables-doc: cannot find ${SCHEMA_REL} (looked in ${repoRoot})`);
    return 1;
  }
  if (!fileExists(docPath)) {
    console.error(`check-auth-tables-doc: cannot find ${DOC_REL} (looked in ${repoRoot})`);
    return 1;
  }

  const schemaSource = readFileSync(schemaPath, 'utf8');
  const docSource = readFileSync(docPath, 'utf8');

  const { tables: schemaTables, lineByTable: schemaLineByTable } = extractSchemaTables(schemaSource);

  // F3: hard-fail if the schema regex found zero tables. This repo will
  // always have at least `auth_user`. A zero-match usually means the regex
  // is broken (renamed import, quote-style change) or the schema file
  // moved. Without this guard, an empty schema set silently matches an
  // empty doc set — the exact BS#1571 failure shape.
  if (schemaTables.size === 0) {
    console.error(
      `check-auth-tables-doc: found zero auth_* pgTable(...) declarations in ${SCHEMA_REL}.\n` +
        `       this repo always has at least auth_user; a zero match probably means:\n` +
        `         - the schema file was moved or split (SCHEMA_REL is hard-coded)\n` +
        `         - pgTable was renamed at the import site (e.g. \`import { pgTable as pt }\`)\n` +
        `         - the file was drained without landing new tables somewhere else\n` +
        `       failing loudly rather than silently agreeing with an empty doc set.`
    );
    return 1;
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
      // switch wasn't updated. Throw with the raw reason so the caller sees
      // exactly what the parser reported, rather than a silently mislabelled
      // "missing sentinel" message that sends operators looking for the wrong
      // thing (R3-3).
      throw new Error(`check-auth-tables-doc: unrecognized block failure reason: ${JSON.stringify(block.reason)}`);
    }
    return 1;
  }

  const docTables = extractDocTables(block.body);

  const missingInDoc = [...schemaTables].filter((t) => !docTables.has(t)).sort();
  const extraInDoc = [...docTables].filter((t) => !schemaTables.has(t)).sort();

  if (missingInDoc.length === 0 && extraInDoc.length === 0) {
    console.log(
      `PASS: ${schemaTables.size} auth_* table(s) in ${SCHEMA_REL} match the CLAUDE.md sentinel-fenced list.`
    );
    return 0;
  }

  console.error('');
  console.error(`FAIL: the auth-tables list in ${DOC_REL} has drifted from ${SCHEMA_REL}.`);
  console.error(`      (fix by editing the sentinel-fenced line in ${DOC_REL}:${block.lineNo})`);
  console.error('');
  if (missingInDoc.length > 0) {
    console.error(`  missing from ${DOC_REL} (declared in schema but not documented):`);
    for (const t of missingInDoc) {
      const ln = schemaLineByTable.get(t);
      console.error(`    - ${t}   (${SCHEMA_REL}:${ln})`);
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
  return 1;
}

import { realpathSync } from 'node:fs';
const invokedDirectly = (() => {
  try {
    return realpathSync(resolve(process.argv[1] ?? '')) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(pickRepoRoot()));
}

export { extractSchemaTables, extractDocBlock, extractDocTables, main };
