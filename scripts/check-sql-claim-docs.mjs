#!/usr/bin/env node
/**
 * Static check for ```sql-claim blocks (WXYC/Backend-Service#2737). It needs
 * no database and no dependencies, so it runs in the unconditional
 * `auth-tables-doc-drift` CI job, the one job a docs-only PR cannot skip,
 * and as `npm run check:sql-claim-docs` in the pre-push hook.
 *
 * It checks four things:
 *
 *   1. Every sql-claim block under docs/ parses. This is the same parser
 *      tests/integration/doc-sql-claims.spec.js uses
 *      (tests/utils/sql-claims.js), including its lexical allowlist. The
 *      claims are not evaluated here; that needs Postgres and happens in the
 *      spec.
 *   2. Each doc's claim count equals tests/utils/sql-claim-counts.json
 *      exactly, and that map names no other doc. Demoting a block to a plain
 *      ```sql fence is legitimate markdown the parser cannot flag, so the
 *      count is what notices. The map lives under tests/, so a PR that edits
 *      it also triggers Integration-Tests. The spec reads the same map.
 *   3. The `tests` paths-filter in .github/workflows/test.yml lists exactly
 *      the docs that hold a sql-claim block (or a malformed attempt at one).
 *      The filter is what makes a docs-only edit to a claim run
 *      Integration-Tests, where the claim is executed. The list is explicit
 *      rather than `docs/**` by maintainer decision, so ordinary docs PRs do
 *      not pay for the Postgres job.
 *   4. No tracked .md file outside docs/ holds a sql-claim block. Only docs/
 *      is executed, so a block anywhere else would render like a checked
 *      claim and never run. The parser's own fixtures
 *      (tests/fixtures/sql-claims/) are the one exemption.
 *
 * Usage: node scripts/check-sql-claim-docs.mjs [repoRoot]
 * repoRoot defaults to this checkout and must be a git work tree (check 4
 * reads `git ls-files`). The unit test passes a fixture tree it `git init`s.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collectSqlClaims, findMarkdownFiles, mentionsSqlClaim } = require('../tests/utils/sql-claims.js');

const root = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).split(sep).join('/');
const docsDir = join(root, 'docs');
const workflowPath = join(root, '.github', 'workflows', 'test.yml');
const countsPath = join(root, 'tests', 'utils', 'sql-claim-counts.json');
const FIXTURE_DIR = 'tests/fixtures/sql-claims/';

const problems = [];

// 1. Every block under docs/ parses.
const { claims, errors } = collectSqlClaims(docsDir, rel);
for (const e of errors) problems.push(`${e.file}:${e.line}  ${e.message}`);

// 2. Exact per-doc claim counts.
const expectedCounts = JSON.parse(readFileSync(countsPath, 'utf8'));
const actualCounts = {};
for (const c of claims) actualCounts[c.file] = (actualCounts[c.file] || 0) + 1;
for (const doc of new Set([...Object.keys(expectedCounts), ...Object.keys(actualCounts)])) {
  const expected = expectedCounts[doc] ?? 0;
  const actual = actualCounts[doc] ?? 0;
  if (expected !== actual) {
    problems.push(
      `${doc} holds ${actual} claim(s) but ${rel(countsPath)} expects ${expected}; update the map in the same change (a block demoted to a plain fence is the usual cause)`
    );
  }
}

// 3. The paths-filter lists exactly the claim-bearing docs.
const workflow = readFileSync(workflowPath, 'utf8');
const start = workflow.indexOf('\n            tests:\n');
const end = workflow.indexOf('\n            db-init:\n', start);
if (start < 0 || end < 0) {
  problems.push(
    `${rel(workflowPath)}: could not find the paths-filter \`tests:\` .. \`db-init:\` block; update this script`
  );
} else {
  const listed = new Set(
    [...workflow.slice(start, end).matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]).filter((p) => p.startsWith('docs/'))
  );
  const claimDocs = new Set(
    findMarkdownFiles(docsDir)
      .filter((p) => mentionsSqlClaim(readFileSync(p, 'utf8')))
      .map(rel)
  );
  for (const doc of claimDocs) {
    if (!listed.has(doc)) {
      problems.push(
        `${doc} holds a sql-claim block but is not in ${rel(workflowPath)}'s \`tests\` paths-filter, so a docs-only edit to it would skip Integration-Tests`
      );
    }
  }
  for (const doc of listed) {
    if (!claimDocs.has(doc)) {
      problems.push(`${rel(workflowPath)}'s \`tests\` paths-filter lists ${doc}, which holds no sql-claim block`);
    }
  }
}

// 4. No sql-claim block in a tracked .md outside docs/.
const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((p) => p !== '' && !p.startsWith('docs/') && !p.startsWith(FIXTURE_DIR));
for (const file of tracked) {
  if (mentionsSqlClaim(readFileSync(join(root, file), 'utf8'))) {
    problems.push(
      `${file} holds a sql-claim block outside docs/; only docs/ is executed, so move the claim under docs/ (or make it prose)`
    );
  }
}

if (problems.length > 0) {
  console.error(`sql-claim docs check failed (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const files = new Set(claims.map((c) => c.file));
console.log(
  `sql-claim docs OK: ${claims.length} claims in ${files.size} docs parse and match ${rel(countsPath)}, the CI filter lists exactly those docs, and no tracked .md outside docs/ holds a block.`
);
