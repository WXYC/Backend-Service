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
 *   0 — sets match, or sets match with a warning about non-standard tokens
 *   1 — sets differ, sentinels missing, or one of the required files is
 *       missing
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
const PG_TABLE_RE = /pgTable\(\s*['"](auth_[a-z0-9_]+)['"]/g;

// Backtick-quoted `auth_<name>` token inside the sentinel-fenced doc block.
const DOC_TOKEN_RE = /`(auth_[a-z0-9_]+)`/g;

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
  if (layoutMatches(SCRIPT_REPO_ROOT)) return SCRIPT_REPO_ROOT;
  // Return cwd anyway so the missing-file error is reported against the
  // caller's expected root, not a surprising fallback path.
  return REPO_ROOT_CWD;
}

function extractSchemaTables(source) {
  const tables = new Set();
  const lineByTable = new Map();
  PG_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = PG_TABLE_RE.exec(source)) !== null) {
    const name = m[1];
    tables.add(name);
    if (!lineByTable.has(name)) {
      const lineNo = source.slice(0, m.index).split('\n').length;
      lineByTable.set(name, lineNo);
    }
  }
  return { tables, lineByTable };
}

function extractDocBlock(source) {
  const begin = source.indexOf(SENTINEL_BEGIN);
  const end = source.indexOf(SENTINEL_END);
  if (begin < 0 || end < 0 || end < begin) {
    return { ok: false };
  }
  const bodyStart = begin + SENTINEL_BEGIN.length;
  const body = source.slice(bodyStart, end);
  const lineNo = source.slice(0, begin).split('\n').length;
  return { ok: true, body, lineNo };
}

function extractDocTables(body) {
  const tables = new Set();
  DOC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = DOC_TOKEN_RE.exec(body)) !== null) {
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

  const block = extractDocBlock(docSource);
  if (!block.ok) {
    console.error(
      `check-auth-tables-doc: missing sentinel comments in ${DOC_REL}.\n` +
        `       expected the auth-tables line to be fenced between\n` +
        `         ${SENTINEL_BEGIN}\n` +
        `         ...\n` +
        `         ${SENTINEL_END}\n` +
        `       see BS#1573 for why the sentinels are load-bearing.`
    );
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
