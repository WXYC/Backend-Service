/**
 * Source-grep tests for `dev_env/format-pg-error.mjs`. The helper is invoked
 * by `dev_env/init-db.mjs` (and, separately, the #726 dry-run script) when a
 * migration fails. Its job is to dump the diagnostic Postgres error fields
 * (`code`, `severity`, `where`, etc.) to stderr so the deploy log carries
 * enough to act on — the failure mode that prompted #725.
 *
 * The behavioural test (does the helper actually run and format a real
 * postgres-js error?) lives at integration time via `npm run ci:testmock`.
 * This file source-greps the artifact so a future PR cannot silently shrink
 * the field set or detach the catch block from the helper.
 *
 * The test mirrors `init-db-historical-replaced.test.ts`'s approach: regex
 * the source rather than dynamic-import the .mjs, since ts-jest's transform
 * pattern doesn't cover .mjs and we don't want to widen it just for this.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const helperPath = path.join(repoRoot, 'dev_env/format-pg-error.mjs');
const initDbPath = path.join(repoRoot, 'dev_env/init-db.mjs');

const helperSource = fs.readFileSync(helperPath, 'utf-8');
const initDbSource = fs.readFileSync(initDbPath, 'utf-8');

describe('format-pg-error.mjs', () => {
  it('exports formatPgError', () => {
    expect(helperSource).toMatch(/export\s+function\s+formatPgError\s*\(/);
  });

  it('FIELD_ORDER includes the diagnostic fields postgres-js exposes', () => {
    // These are the fields that materially help an operator distinguish one
    // PG failure from another — see plan 725-surface-migrate-errors.md and
    // the postgres-js error documentation.
    const required = [
      'code',
      'severity',
      'message',
      'detail',
      'hint',
      'where',
      'schema',
      'table',
      'column',
      'constraint',
    ];
    const blockMatch = helperSource.match(/FIELD_ORDER\s*=\s*\[([\s\S]*?)\];/);
    if (!blockMatch) throw new Error('FIELD_ORDER literal not found');
    const declared = Array.from(blockMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    for (const field of required) {
      expect(declared).toContain(field);
    }
  });

  it('emits a leading fence so the failure block stands out in mixed log output', () => {
    expect(helperSource).toMatch(/=== drizzle:migrate failed ===/);
  });

  it('walks the cause chain so DrizzleQueryError-wrapped PG errors surface their fields', () => {
    // drizzle-orm wraps thrown PG errors in `DrizzleQueryError`, putting the
    // original PostgresError under `.cause`. Without chain-walking, the
    // helper would only see the wrapper's generic "Failed query: ..." text
    // and miss `severity`, `code`, `where` — defeating the entire point of
    // #725. Source-grep for the cause traversal.
    expect(helperSource).toMatch(/findPgErrorInChain|\.cause/);
  });
});

describe('init-db.mjs uses format-pg-error', () => {
  it('imports formatPgError from the helper module', () => {
    expect(initDbSource).toMatch(/import\s*\{\s*formatPgError\s*\}\s*from\s*['"]\.\/format-pg-error\.mjs['"]/);
  });

  it('runMigrations passes the caught error to formatPgError', () => {
    // Source-grep guard against a future refactor that silently drops the
    // formatter call (regressing back to the bare `error.message` log that
    // wedged run 25337297761).
    expect(initDbSource).toMatch(/formatPgError\s*\(\s*error\s*\)/);
  });

  it('runMigrations uses programmatic migrate(), not exec(npm run drizzle:migrate)', () => {
    // The whole point of #725 is to stop shelling out to drizzle-kit so the
    // CLI's spinner can't eat the Postgres ERROR text.
    expect(initDbSource).toMatch(/import\s*\{\s*migrate\s*\}\s*from\s*['"]drizzle-orm\/postgres-js\/migrator['"]/);
    expect(initDbSource).not.toMatch(/execAsync\(\s*['"]npm run drizzle:migrate['"]/);
  });
});
