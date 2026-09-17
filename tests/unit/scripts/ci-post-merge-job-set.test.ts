/**
 * Pin the set of `test.yml` jobs that run on push to `main` (BS#2570).
 *
 * # The failure this guards against
 *
 * `test.yml` gained a `push: branches: [main]` trigger so that a merge
 * leaving the suite red is reported against `main` within minutes, instead
 * of surfacing on the next contributor's PR as a failure on a line they
 * never touched (2026-09-17: #2541 and #2546 were each green alone and red
 * together, and `main` sat broken for 2h26m).
 *
 * The post-merge run is deliberately scoped to `detect-changes` ->
 * `unit-tests`. That scoping is expressed as a NEGATIVE guard -- every other
 * job carries `github.event_name != 'push'` -- which has an unwanted
 * default: a job added later with no guard runs post-merge, silently, and
 * whoever adds it has no reason to notice. `migrate-dryrun` restores a real
 * RDS snapshot per run, so "silently, on every merge" is not a free mistake.
 *
 * This spec is the affirmative half. The allowlist below is the decision;
 * the workflow is checked against it. Adding a job to `test.yml` fails here
 * until someone writes down which side of the line it belongs on.
 *
 * # Why text, not a YAML parse
 *
 * Neither `yaml` nor `js-yaml` is a declared dependency, and adding one for
 * a spec would move `package-lock.json` -- which rekeys the `node_modules`
 * cache for every job in every workflow (BS#2256). The sibling workflow
 * guards (`ci-unit-tests-full-suite`, `ci-node-modules-cache`,
 * `latest-tag-fetch`, `deploy-timeouts`) all read the YAML as text for the
 * same reason, and they rely on the same indentation invariant this file
 * does: a job key sits at two spaces, and every line of a job's own body is
 * indented four or more.
 *
 * Reading workflow YAML as text means Jest's dependency graph has no edge
 * from `test.yml` to this spec, so `detect-changes`'s `src` filter globbing
 * `.github/workflows/**` is what triggers the job that runs it. Narrowing
 * that glob back to individual files re-opens the hole (BS#1807, BS#2256,
 * BS#2267).
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');
const workflow = fs.readFileSync(workflowPath, 'utf-8');

/**
 * The decision this spec exists to hold. `detect-changes` computes the paths
 * filter every other job gates on; `unit-tests` is the ~1m45s job that would
 * have caught the 2026-09-17 collision. Everything else is PR-only -- see
 * the `on.push` comment in `test.yml` for what the rest of the matrix costs
 * and where that cost is charged.
 *
 * Changing this set is a real decision, not a test fix.
 */
const POST_MERGE_JOBS = ['detect-changes', 'unit-tests'];

/** The exact guard each PR-only job must carry. */
const PUSH_GUARD = "github.event_name != 'push'";

/** Status-check functions. GitHub's implicit `success()` over `needs` is
 *  inserted ONLY when a job's `if` contains none of these. */
const STATUS_FUNCTIONS = ['success()', 'failure()', 'cancelled()', 'always()'];

function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

interface Job {
  name: string;
  /** The job's own body, comments stripped. Steps included. */
  body: string;
  /** The job-level `if:` value, or null when the job has none. */
  condition: string | null;
}

/**
 * Split the `jobs:` mapping into one entry per job.
 *
 * Starts after the `jobs:` key so the two-space keys in `on:` and
 * `permissions:` can't be mistaken for job names, and ends each job at the
 * next two-space-indented line -- a job key or the comment block that
 * introduces the next job.
 */
function jobsOf(source: string): Job[] {
  const jobsStart = source.indexOf('\njobs:\n');
  if (jobsStart === -1) throw new Error(`No \`jobs:\` mapping in ${workflowPath}`);
  const lines = source.slice(jobsStart + '\njobs:\n'.length).split('\n');

  const jobs: Job[] = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    const key = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (key) {
      if (current) jobs.push(finish(current));
      current = { name: key[1], lines: [] };
      continue;
    }
    // A two-space comment introduces the NEXT job; it ends the current one.
    if (/^ {2}#/.test(line)) {
      if (current) jobs.push(finish(current));
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) jobs.push(finish(current));
  return jobs;
}

function finish(job: { name: string; lines: string[] }): Job {
  const body = withoutComments(job.lines.join('\n'));
  // Job-level keys sit at four spaces; step-level `if:` sits at eight.
  const conditions = body.split('\n').filter((line) => /^ {4}if:/.test(line));
  if (conditions.length > 1) {
    throw new Error(`Job \`${job.name}\` has ${conditions.length} job-level \`if:\` lines`);
  }
  const condition = conditions.length === 1 ? conditions[0].replace(/^ {4}if:\s*/, '').trim() : null;
  return { name: job.name, body, condition };
}

const jobs = jobsOf(workflow);

describe('post-merge job set (BS#2570)', () => {
  it('parses every job out of test.yml', () => {
    // A splitter that silently found nothing would make every assertion
    // below vacuously pass, so pin the shape it produced.
    expect(jobs.length).toBeGreaterThanOrEqual(6);
    expect(jobs.map((j) => j.name)).toEqual(
      expect.arrayContaining([
        ...POST_MERGE_JOBS,
        'lint-and-typecheck',
        'auth-tables-doc-drift',
        'Integration-Tests',
        'migrate-dryrun',
      ])
    );
    // Every job must have a body; an empty one means the split misfired.
    for (const job of jobs) expect(job.body).toContain('runs-on:');
  });

  it('runs exactly the allowlisted jobs on push to main', () => {
    const postMerge = jobs.filter((j) => j.condition === null || !j.condition.includes(PUSH_GUARD)).map((j) => j.name);
    // If this fails on a job you just added, decide deliberately: add the
    // `github.event_name != 'push'` guard to keep it PR-only, or add it to
    // POST_MERGE_JOBS and accept its cost on every merge to `main`.
    expect(postMerge.sort()).toEqual([...POST_MERGE_JOBS].sort());
  });

  it('scopes the push trigger to main', () => {
    // A push trigger on every branch would run this matrix on every branch
    // push as well as on the PR, doubling every contributor's CI.
    const triggers = withoutComments(workflow.slice(0, workflow.indexOf('\njobs:\n')));
    expect(triggers).toMatch(/\n {2}push:\n {4}branches:\n {6}- main\n/);
  });
});

describe('jobs a skipped dependency cannot stop need an explicit push guard (BS#2570)', () => {
  /**
   * GitHub inserts an implicit `success()` over `needs` only when a job's
   * `if` contains no status-check function. `Integration-Tests` uses
   * `!failure() && !cancelled()`, which a SKIPPED dependency satisfies just
   * as well as a successful one -- so its `lint-and-typecheck` need going
   * skipped on push would not have stopped it, and it would have started its
   * Postgres service container on every merge. (Its steps are individually
   * gated on `env.RUN_TESTS`, but `services:` containers start before any
   * step runs, so the job-level guard is the only thing that prevents it.)
   *
   * Any future job written in that form has the same property. This is the
   * check that catches the next one.
   */
  const statusFunctionJobs = jobs.filter(
    (j) => j.condition !== null && STATUS_FUNCTIONS.some((fn) => j.condition.includes(fn))
  );

  it('finds the jobs written in that form', () => {
    expect(statusFunctionJobs.map((j) => j.name)).toEqual(['Integration-Tests']);
  });

  it.each(POST_MERGE_JOBS)('%s does not rely on a status-check function', (name) => {
    // The allowlisted jobs must keep the implicit-success() form, so a
    // failed `detect-changes` stops them instead of being shrugged off.
    const job = jobs.find((j) => j.name === name);
    expect(job).toBeDefined();
    for (const fn of STATUS_FUNCTIONS) expect(job.condition ?? '').not.toContain(fn);
  });

  it('guards every status-function job against push', () => {
    for (const job of statusFunctionJobs) {
      expect(job.condition).toContain(PUSH_GUARD);
    }
  });
});

describe('push-triggered jobs never dereference a pull_request context (BS#2570)', () => {
  /**
   * `github.event.pull_request.*` is null on a `push` event, so a step that
   * reads it fails the run. Every such reference in `test.yml` today lives in
   * `migrate-dryrun`, which is PR-only twice over: the job-level push guard,
   * plus a `github.event_name == 'pull_request'` condition on each step that
   * reads the context. This keeps that true for whatever runs post-merge.
   */
  it.each(POST_MERGE_JOBS)('%s reads no PR-only context', (name) => {
    const job = jobs.find((j) => j.name === name);
    expect(job).toBeDefined();
    expect(job.body).not.toContain('github.event.pull_request');
    expect(job.body).not.toContain('github.head_ref');
    expect(job.body).not.toContain('github.base_ref');
  });

  it('the probe can see a real reference', () => {
    // Control: without this, the assertions above pass just as well against
    // a splitter that returned empty bodies.
    const dryrun = jobs.find((j) => j.name === 'migrate-dryrun');
    expect(dryrun?.body).toContain('github.event.pull_request');
  });
});
