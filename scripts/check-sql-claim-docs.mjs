#!/usr/bin/env node
/**
 * Static check for ```sql-claim blocks in docs/ (WXYC/Backend-Service#2737).
 * It needs no database and no dependencies, so it runs in the unconditional
 * `auth-tables-doc-drift` CI job, the one job a docs-only PR cannot skip.
 *
 * It checks two things:
 *
 *   1. Every sql-claim block under docs/ parses. This is the same parser
 *      tests/integration/doc-sql-claims.spec.js uses
 *      (tests/utils/sql-claims.js), including its lexical allowlist. The
 *      claims are not evaluated here; that needs Postgres and happens in the
 *      spec.
 *   2. The `tests` paths-filter in .github/workflows/test.yml lists exactly
 *      the docs that hold a sql-claim opener (or anything that looks like
 *      one). The filter is what makes a docs-only edit to a claim run
 *      Integration-Tests, where the claim is actually executed. The list is
 *      explicit rather than `docs/**` by maintainer decision, so ordinary docs
 *      PRs do not pay for the Postgres job.
 *
 * Because this runs on every PR, a docs-only PR that adds a doc's FIRST block
 * without listing it fails here, in that PR, instead of merging an unexecuted
 * claim.
 *
 * Usage: node scripts/check-sql-claim-docs.mjs [repoRoot]
 * repoRoot defaults to this checkout. The unit test passes a fixture tree.
 */
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

const problems = [];

const { claims, errors } = collectSqlClaims(docsDir, rel);
for (const e of errors) problems.push(`${e.file}:${e.line}  ${e.message}`);

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

if (problems.length > 0) {
  console.error(`sql-claim docs check failed (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const files = new Set(claims.map((c) => c.file));
console.log(
  `sql-claim docs OK: ${claims.length} claims in ${files.size} docs parse, and the CI filter lists exactly those docs.`
);
