/**
 * Pin the explicit env-var gate on `loadCloneFixture()` in
 * `dev_env/init-db.mjs`.
 *
 * Why: the seed-clone.sql file is committed to the repo (~14 MB pg_dump),
 * so `existsSync(...)` finds it on every checkout — including in CI's
 * `node dev_env/init-db.mjs` invocation. The docker-compose mount-only
 * gate documented in the original commit (BS#947) only works when
 * docker-compose is the entry point; CI's bare-Node call bypasses it.
 *
 * Fix (BS#951): require an explicit `LOAD_CLONE_FIXTURE=true` env var.
 * The dev-profile `db-init` container in docker-compose.yml sets it;
 * CI never does, so the bare-Node invocation correctly skips the clone
 * and `seed_db.sql`'s small fixed-ID fixture remains in effect.
 *
 * This is a source-grep test (no PG, no docker) — same style as the
 * adjacent `init-db-historical-replaced.test.ts`. The behavioural
 * coverage is the next CI green-after-this-PR run plus
 * `npm run db:start` continuing to pull in the clone locally.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const initDbPath = path.join(repoRoot, 'dev_env/init-db.mjs');
const composePath = path.join(repoRoot, 'dev_env/docker-compose.yml');

describe('init-db.mjs loadCloneFixture env-var gate (BS#951)', () => {
  const initDbSource = fs.readFileSync(initDbPath, 'utf-8');

  it('gates loadCloneFixture on LOAD_CLONE_FIXTURE === "true" before existsSync', () => {
    // The gate must come BEFORE the existsSync — otherwise the CI runner
    // (where the .sql file is checked into the repo) still loads the
    // clone. Asserting the env-var check appears in the source pins the
    // gate against future refactors that might re-order the file-check
    // back to first place.
    expect(initDbSource).toMatch(/process\.env\.LOAD_CLONE_FIXTURE/);
    expect(initDbSource).toMatch(/LOAD_CLONE_FIXTURE\s*!==\s*['"]true['"]/);
  });

  it('docker-compose dev-profile db-init service sets LOAD_CLONE_FIXTURE=true', () => {
    // The fix is symmetric: CI must skip the clone, but `npm run db:start`
    // (which goes through docker-compose --profile dev) must keep loading
    // it. Pin that the dev-profile db-init container has the env var set.
    const dbInitBlock = extractServiceBlock('db-init');
    expect(dbInitBlock).toMatch(/LOAD_CLONE_FIXTURE.*=.*true/i);
  });

  it('does NOT set LOAD_CLONE_FIXTURE for ci-db-init or e2e-db-init', () => {
    expect(extractServiceBlock('ci-db-init')).not.toMatch(/LOAD_CLONE_FIXTURE/);
    expect(extractServiceBlock('e2e-db-init')).not.toMatch(/LOAD_CLONE_FIXTURE/);
  });
});

/**
 * Extract a single docker-compose service block by its name. Matches the
 * `^  <name>:` line and everything up to (but not including) the next
 * top-level service header (`^  <ident>:`). Empty string if the service
 * isn't found — callers assert on the content to fail loudly.
 */
function extractServiceBlock(name: string): string {
  const compose = fs.readFileSync(composePath, 'utf-8');
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(`^\\s{2}${escaped}:[\\s\\S]*?(?=^\\s{2}\\w)`, 'm');
  return compose.match(pattern)?.[0] ?? '';
}
