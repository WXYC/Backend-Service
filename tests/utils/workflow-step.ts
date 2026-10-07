/**
 * Run a GitHub Actions `run:` step from Jest the way GitHub does: bash with
 * `-eo pipefail`, inputs only through `env:`. A `${{ ... }}` left in a script
 * body is pasted into the shell before it runs (script injection) and would
 * make bash fail here.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type Step = { name?: string; env?: Record<string, string>; run?: string; if?: string };
export type Job = { if?: unknown; needs?: unknown; permissions?: unknown; steps: Step[] };

/** Parse `.github/workflows/<file>`; `on` and any other keys stay untyped. */
export const loadWorkflow = (file: string) =>
  parseYaml(readFileSync(join(__dirname, '..', '..', '.github', 'workflows', file), 'utf8')) as {
    jobs: Record<string, Job>;
  } & Record<string, any>;

/** The named step of a job, or its first `run:` step when no name is given. */
export const findStep = (job: Job, name?: string) => {
  const found = name ? job.steps.find((s) => s.name === name) : job.steps.find((s) => s.run);
  if (!found?.run) throw new Error(`step "${name ?? '(first run step)'}" not found or has no run:`);
  return found as Step & { run: string };
};

/** The fragment of `run` from `fromMarker` up to (excluding) `toMarker`. */
export const sliceScript = (run: string, fromMarker: string, toMarker: string) => {
  const from = run.indexOf(fromMarker);
  const to = run.indexOf(toMarker);
  if (from === -1) throw new Error(`marker "${fromMarker}" not found`);
  if (to === -1) throw new Error(`marker "${toMarker}" not found`);
  return run.slice(from, to);
};

/** Values for the step's `env:` keys, looked up by their `${{ ... }}` expression; throws on an unmapped one. */
export const stepEnvFrom = (step: Step, expressions: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, expr]) => {
      const value = expressions[expr];
      if (value === undefined) throw new Error(`unexpected env expression ${key}: ${expr}`);
      return [key, value];
    })
  );

export const runBashScript = (
  script: string,
  { env = {}, cwd, pathPrepend }: { env?: Record<string, string>; cwd: string; pathPrepend?: string }
) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    env: { PATH: pathPrepend ? `${pathPrepend}:${process.env.PATH}` : process.env.PATH, ...env },
    encoding: 'utf8',
  });

/** A directory holding a jq-backed `yq` (not installed on dev machines); removed after the calling suite. Call at describe scope. */
export const makeYqShim = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yq-shim-'));
  writeFileSync(join(dir, 'yq'), '#!/bin/sh\nexec jq "$@"\n', { mode: 0o755 });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
