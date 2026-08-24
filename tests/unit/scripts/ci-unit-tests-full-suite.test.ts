/**
 * Pin that CI's `unit-tests` job runs the WHOLE unit suite, never Jest's
 * affected-tests mode (BS#2249).
 *
 * Jest builds `--changedSince` / `--onlyChanged` selection from the module
 * dependency graph. A spec that reads a source file as text
 * (`fs.readFileSync`) rather than importing it has no edge to that file, so
 * changing the file never marks the spec as related and the spec does not run
 * on the PR that breaks it. This repo leans on that pattern heavily — ~52
 * specs under `tests/unit/` import nothing but `fs` and `path`, including 31
 * `tests/unit/database/schema.*` specs, 5 guards over
 * `shared/authentication/src/auth.definition.ts`, and this file.
 *
 * Measured when the mode was removed: a change to
 * `shared/database/src/schema.ts` selected 250 suites and only 3 of its 31
 * guards. That is how BS#2246 merged green while breaking 5 assertions in
 * `tests/unit/database/schema.fk-cascades.test.ts`, which is the spec that
 * exists to hold BS#2239's decision in place.
 *
 * The mode was also not buying time: `unit-tests` gates no other job
 * (`Integration-Tests` needs `[detect-changes, lint-and-typecheck]`) and runs
 * beside `lint-and-typecheck`, which is consistently about twice as long.
 *
 * Source-grep test (no docker, no PG) — same style as the adjacent
 * `lml-limiter-test-env.test.ts` and `ci-env-surface-parity.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');
const packageJsonPath = path.join(repoRoot, 'package.json');

const workflow = fs.readFileSync(workflowPath, 'utf-8');

/**
 * Slice the `unit-tests:` job out of the workflow: from its key to the next
 * top-level job key (two-space indent followed by a name and a colon).
 */
function extractUnitTestsJob(): string {
  const start = workflow.indexOf('\n  unit-tests:');
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('CI unit-tests job runs the full suite (BS#2249)', () => {
  const job = extractUnitTestsJob();

  it.each([
    ['--changedSince', 'selects by dependency graph; blind to text-reading specs'],
    ['--onlyChanged', 'same selection mechanism as --changedSince'],
    ['--findRelatedTests', 'same selection mechanism as --changedSince'],
    ['--passWithNoTests', 'only meaningful under selection; the full suite always has tests'],
  ])('does not use %s (%s)', (flag) => {
    expect(job).not.toContain(flag);
  });

  it('invokes the full-suite npm script', () => {
    expect(job).toContain('npm run test:unit:coverage');
  });

  it('does not branch its test command on the event type', () => {
    // The removed version ran affected tests on `pull_request` and the full
    // suite on `workflow_dispatch`, so the manual run was the only one that
    // could catch a text-reading regression -- one day late, via the nightly.
    expect(job).not.toMatch(/github\.event_name.*pull_request/);
  });
});

describe('the full-suite npm script really is unfiltered (BS#2249)', () => {
  const scripts = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).scripts as Record<string, string>;

  it.each(['test:unit', 'test:unit:coverage'])('%s carries no selection flag', (name) => {
    const script = scripts[name];
    expect(script).toBeDefined();
    expect(script).toMatch(/jest --config jest\.unit\.config\.ts/);
    expect(script).not.toMatch(/--changedSince|--onlyChanged|--findRelatedTests|--testPathPattern/);
  });
});
