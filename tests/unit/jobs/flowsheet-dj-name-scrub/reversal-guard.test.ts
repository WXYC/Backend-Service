/**
 * Guard: the two jobs that would REVERSE the BS#2281 scrub must not be
 * buildable or runnable, and must say so in their own source.
 *
 * `jobs/flowsheet-dj-name-scrub` deliberately CREATES `dj_name IS NULL` rows —
 * the PII-nulled `dj_join`/`dj_leave` markers whose guest handle is not
 * recoverable, and the orphan rows with no shows chain to recompute from. Two
 * one-shot jobs exist whose entire purpose is filling exactly those NULLs from
 * the shows join:
 *
 *   - `jobs/legacy-dj-name-remediation/job.ts:306-307` — `entry_type IN (...)
 *     AND f.dj_name IS NULL`
 *   - `jobs/flowsheet-dj-name-backfill` — `WHERE dj_name IS NULL`
 *
 * Running either after the scrub silently re-attributes those rows to the
 * PRIMARY DJ and undoes the privacy fix. The risk is not hypothetical and it
 * is not decreasing: BS#2281's own analysis frames BS#1393 as
 * "under-remediated", which is exactly the reading that would prompt a
 * well-intentioned operator to re-run the older job.
 *
 * The chosen guard is removal of the deploy path rather than a runtime
 * refusal inside `main()`. That is deliberate and it is the STRONGER of the
 * two: `.github/workflows/deploy-base.yml:454` builds `Dockerfile.${target}`
 * from the repo root, so with no Dockerfile the image cannot be produced at
 * all — an operator gets a build failure instead of a container that runs and
 * then declines. A runtime refusal would additionally have had to live in
 * `main()`, which both jobs invoke at module scope; their existing unit suites
 * import those modules, and a `process.exitCode = 1` set during import
 * poisons the whole Jest run even when every test passes (measured, not
 * assumed).
 *
 * The job source, its run history, and the migration-chain documentation that
 * cites `flowsheet-dj-name-backfill` as the canonical precondition-guard
 * pattern (`docs/migrations.md`, `docs/backfill-precondition-assertions.md`)
 * all stay intact. Only the ability to deploy is withdrawn.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../../..');

const REVERSING_JOBS = [
  {
    name: 'legacy-dj-name-remediation',
    dockerfile: 'Dockerfile.legacy-dj-name-remediation',
    source: 'jobs/legacy-dj-name-remediation/job.ts',
  },
  {
    name: 'flowsheet-dj-name-backfill',
    dockerfile: 'Dockerfile.flowsheet-dj-name-backfill',
    source: 'jobs/flowsheet-dj-name-backfill/job.ts',
  },
] as const;

describe.each(REVERSING_JOBS)('$name cannot be deployed', ({ dockerfile, source }) => {
  it('has no root Dockerfile, so `Manual Build & Deploy` cannot produce an image', () => {
    expect(existsSync(join(REPO_ROOT, dockerfile))).toBe(false);
  });

  it('has no docker:build script — it pointed at the Dockerfile removed above, and left in place would fail with a confusing file-not-found instead of the refusal message', () => {
    const pkgPath = join(REPO_ROOT, source.replace(/job\.ts$/, 'package.json'));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts).not.toHaveProperty('docker:build');
  });

  it('refuses at runtime, so an image already in ECR cannot do damage either', () => {
    // Dockerfile removal stops a NEW build; it does nothing about an image
    // already pushed, or a `dist/` built on the box. Both of these jobs have
    // been built and run before, so that gap is real.
    const text = readFileSync(join(REPO_ROOT, source), 'utf8');
    expect(text).toMatch(/supersededRefusalMessage/);
    expect(text).toMatch(/process\.exitCode = 1/);
  });

  it('warns in its own docblock that running it reverses the BS#2281 scrub', () => {
    const text = readFileSync(join(REPO_ROOT, source), 'utf8');
    // The warning must be in the first docblock — the part anyone reading the
    // file, or considering restoring the Dockerfile, sees first.
    const firstBlock = text.slice(0, text.indexOf('*/') + 2);
    expect(firstBlock).toMatch(/BS#2281/);
    expect(firstBlock).toMatch(/DO NOT RUN/);
    expect(firstBlock).toMatch(/flowsheet-dj-name-scrub/);
  });
});

describe('the scrub job documents the reversal hazard for operators', () => {
  it('names both reversing jobs in its README', () => {
    const readme = readFileSync(join(REPO_ROOT, 'jobs/flowsheet-dj-name-scrub/README.md'), 'utf8');
    expect(readme).toMatch(/legacy-dj-name-remediation/);
    expect(readme).toMatch(/flowsheet-dj-name-backfill/);
  });
});

describe('the refusal has no override', () => {
  // `jobs/flowsheet-etl` offers LEGACY_ETL_ALLOW_BACKWARDS_WRITE because it is
  // retained for a genuine future maintenance window. These two are not: the
  // 0053 -> backfill -> 0054 chain has been applied and verified, and BS#1393's
  // remediation ran. There is no legitimate re-run, so there is no door.
  it.each(REVERSING_JOBS)('$name has no opt-in env var', ({ name }) => {
    const guard = readFileSync(join(REPO_ROOT, `jobs/${name}/superseded-guard.ts`), 'utf8');
    const code = guard.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.env/);
  });
});
