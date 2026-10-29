import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/test.yml');

/**
 * The `src` filter's entries from `.github/workflows/test.yml`'s `detect-changes` job, comment lines dropped.
 * `lint-and-typecheck` and `unit-tests` run only when that filter matches, so a guard test pins the entry
 * for the file it reads: a PR that edits only that file must still run the test, or both jobs report
 * `skipped`, which branch protection accepts as passing (BS#1807, BS#2256).
 */
export const srcFilter = (): string[] => {
  const lines = fs
    .readFileSync(WORKFLOW, 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^\s*src:\s*$/.test(line));
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*- '([^']+)'\s*$/.exec(line);
    if (!match) {
      break;
    }
    entries.push(match[1]);
  }
  return entries;
};
