/**
 * Pin that BOTH CI environments disable the LML client's process-wide rate
 * limiter (BS#955):
 *
 *   1. `dev_env/docker-compose.yml` — for `npm run ci:testmock` (local
 *      docker-based CI repro).
 *   2. `.github/workflows/test.yml` `Start services` env block — for actual
 *      GitHub Actions CI, which runs the backend as a host node process and
 *      does NOT load env from docker-compose.
 *
 * These two surfaces drift independently; the local repro is a docker stack
 * and the production CI is host processes with inline workflow env. Both
 * need to override or the integration suite regresses.
 *
 * Why: G4 (PR #948 / BS#906) added a module-level `Semaphore(5)` +
 * `TokenBucket(50/min)` to `apps/backend/services/lml/lml.client.ts` as a
 * prod safety net mirroring LML's Discogs ceilings. In integration tests
 * (`--runInBand`), the bucket persists across spec files. The full
 * integration suite triggers > 50 fire-and-forget `/lookup` calls during
 * earlier suites, draining the bucket; by the time `metadata-lml.spec.js`
 * runs, every call waits ~1200 ms for a token and the proxy test times out
 * at 30 s.
 *
 * The unit-test author for G4 already set `LML_CLIENT_RATE_PER_MIN: '60000'`
 * in the unit harness with the comment "effectively no rate cap in tests"
 * (see `tests/unit/services/lml.client.test.ts:792`). This test pins the
 * same convention into both CI environments so the next limiter env var
 * (or a future tweak to G4's defaults) can't silently regress the suite.
 *
 * Source-grep test (no docker, no PG) — same style as the adjacent
 * `init-db-clone-gate.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const composePath = path.join(repoRoot, 'dev_env/docker-compose.yml');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');

describe('LML client limiter env vars (BS#955)', () => {
  describe('dev_env/docker-compose.yml ci backend (local ci:testmock)', () => {
    const backendBlock = extractServiceBlock('backend');

    it('sets LML_CLIENT_MAX_CONCURRENT to a high value (test override)', () => {
      // Default in lml.client.ts is 5 (mirrors LML's discogs_max_concurrent).
      // Local CI needs an effectively-unlimited override so the integration
      // suite, which serializes hundreds of LML calls under --runInBand,
      // never queues.
      const captured = backendBlock.match(/LML_CLIENT_MAX_CONCURRENT=(\d+)/)?.[1];
      expect(captured).toBeDefined();
      expect(Number(captured)).toBeGreaterThanOrEqual(1000);
    });

    it('sets LML_CLIENT_RATE_PER_MIN to a high value (test override)', () => {
      // Default in lml.client.ts is 50/min (mirrors LML's discogs_rate_limit).
      // Local CI needs >= 10000/min so the TokenBucket cannot drain across
      // the full integration suite. Matches the unit-test convention at
      // tests/unit/services/lml.client.test.ts:792-793.
      const captured = backendBlock.match(/LML_CLIENT_RATE_PER_MIN=(\d+)/)?.[1];
      expect(captured).toBeDefined();
      expect(Number(captured)).toBeGreaterThanOrEqual(10000);
    });
  });

  describe('.github/workflows/test.yml Start services env (GHA CI)', () => {
    // GHA's Start-services step has its own inline `env:` block that's the
    // sole source of env vars for the host node processes. docker-compose is
    // never touched on that path.
    const startServicesBlock = extractStartServicesEnv();

    it('sets LML_CLIENT_MAX_CONCURRENT to a high value (test override)', () => {
      // String form expected ('10000') because the workflow env block is YAML
      // — explicit quoting prevents YAML's number-typing from producing a
      // value the loader handles differently than the compose-file path.
      const captured = startServicesBlock.match(/LML_CLIENT_MAX_CONCURRENT:\s*['"]?(\d+)['"]?/)?.[1];
      expect(captured).toBeDefined();
      expect(Number(captured)).toBeGreaterThanOrEqual(1000);
    });

    it('sets LML_CLIENT_RATE_PER_MIN to a high value (test override)', () => {
      const captured = startServicesBlock.match(/LML_CLIENT_RATE_PER_MIN:\s*['"]?(\d+)['"]?/)?.[1];
      expect(captured).toBeDefined();
      expect(Number(captured)).toBeGreaterThanOrEqual(10000);
    });
  });
});

/**
 * Extract a single docker-compose service block by its name. Matches the
 * `^  <name>:` line and everything up to (but not including) the next
 * top-level service header (`^  <ident>:`). Throws if the service isn't
 * found — silent fall-through to '' would let positive-match assertions
 * trivially fail without surfacing the typo or layout drift.
 *
 * The end-of-file anchor `(?![\s\S])` covers the case where the matched
 * service is the last block in the file; without it the lookahead
 * `(?=^\s{2}\w)` would fail and the match would return null.
 */
function extractServiceBlock(name: string): string {
  const compose = fs.readFileSync(composePath, 'utf-8');
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(`^\\s{2}${escaped}:[\\s\\S]*?(?=^\\s{2}\\w|(?![\\s\\S]))`, 'm');
  const block = compose.match(pattern)?.[0];
  if (!block) {
    throw new Error(`docker-compose service block not found: ${name}`);
  }
  return block;
}

/**
 * Extract the `env:` block of the `Start services` step from the integration
 * test workflow. Anchors on the step `name:` line and slices up to the `run:`
 * key — the env keys themselves live in between. Throws if either anchor
 * isn't found so a workflow rename surfaces immediately.
 */
function extractStartServicesEnv(): string {
  const workflow = fs.readFileSync(workflowPath, 'utf-8');
  const startIdx = workflow.indexOf('- name: Start services');
  if (startIdx === -1) {
    throw new Error('workflow step `Start services` not found in test.yml');
  }
  const stepSlice = workflow.slice(startIdx);
  const runIdx = stepSlice.indexOf('\n        run:');
  if (runIdx === -1) {
    throw new Error('workflow step `Start services` has no `run:` key');
  }
  return stepSlice.slice(0, runIdx);
}
