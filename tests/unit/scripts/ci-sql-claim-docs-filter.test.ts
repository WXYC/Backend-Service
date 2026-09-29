/**
 * Every doc holding a ```sql-claim block must trigger Integration-Tests
 * (BS#2737).
 *
 * `tests/integration/doc-sql-claims.spec.js` executes those blocks, but
 * `detect-changes` in `.github/workflows/test.yml` runs the integration job
 * only when an `apps`/`jobs`/`shared`/`db-init`/`tests` path changes. A
 * docs-only PR that edits a claim — the exact change that can make one false
 * — would otherwise skip the job, and branch protection accepts a skipped
 * required check as passing. The `tests` filter therefore enumerates each
 * claim-bearing doc, and this test keeps that list equal to the set of docs
 * that actually hold a block.
 *
 * Residual gap, stated so nobody mistakes this for complete: a docs-only PR
 * that adds the FIRST sql-claim block to a doc not yet listed runs neither
 * this unit test nor the integration spec in CI. The next PR that runs the
 * unit suite fails here and names the doc.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findMarkdownFiles } from '../../utils/sql-claims';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'test.yml');

// Broader than the parser's accepted fence on purpose: a near-miss fence
// (`sql-claims`, indented, tilde) is a parse error in the spec, and the doc
// holding it must still trigger the job that reports that error.
const CLAIM_FENCE = /^\s*(`{3,}|~{3,})\s*sql[-_ ]?claim/im;

/** The quoted paths under `tests:` in the paths-filter block. */
function testsFilterPaths(workflow: string): string[] {
  const start = workflow.indexOf('\n            tests:\n');
  const end = workflow.indexOf('\n            db-init:\n', start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not find the \`tests:\` .. \`db-init:\` filter block in ${WORKFLOW}; update this test.`);
  }
  return [...workflow.slice(start, end).matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
}

describe('test.yml `tests` filter covers every doc with a sql-claim block', () => {
  const listed = testsFilterPaths(fs.readFileSync(WORKFLOW, 'utf8'));
  const listedDocs = listed.filter((p) => p.startsWith('docs/')).sort();
  const claimDocs = findMarkdownFiles(path.join(REPO_ROOT, 'docs'))
    .filter((p: string) => CLAIM_FENCE.test(fs.readFileSync(p, 'utf8')))
    .map((p: string) => path.relative(REPO_ROOT, p).split(path.sep).join('/'))
    .sort();

  it('finds at least one claim-bearing doc (the walk is not vacuous)', () => {
    expect(claimDocs.length).toBeGreaterThan(0);
  });

  it('lists exactly the docs that hold a sql-claim block', () => {
    expect(listedDocs).toEqual(claimDocs);
  });
});
