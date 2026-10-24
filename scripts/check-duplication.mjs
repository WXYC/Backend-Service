#!/usr/bin/env node
/**
 * Per-file copy-paste ratchet over jscpd (BS#3695).
 *
 * Nothing else stops a PR from adding copy-paste. This runs jscpd per scope
 * (`prod` = apps shared jobs; `tests` = tests) and compares each file's
 * duplicated-line count with `duplication-baseline.json`, shaped
 * `{scopes: {prod: {files: {path: lines}}, tests: {files: {path: lines}}}}`
 * (lines, not tokens). The unit is duplicated lines per file: the union of the
 * file's clone ranges across all formats, so a line counts once however many
 * clones cover it. Only the `firstFile` span is trusted: jscpd 4.0.5 can write a
 * `secondFile` end taken from a third file's stored frame (wrong, even past EOF), so
 * a clone's second range is `secondFile.start` plus the first span, clamped to that file's
 * length on disk (under the scan root). A reformat that changes a cloned block's line span (a
 * Prettier rewrap) can raise a file's count; the failure says how to accept it.
 * jscpd's own per-file token counts are not used: it reports a family of N identical copies
 * as a star (the first-read copy gets (N-1)x, the others 1x), so deleting the
 * hub copy would raise another file. Clone lists are never baselined: they are
 * located by line ranges, so any edit above a clone moves it.
 *
 * Check (default): a file above its baseline, or absent from it with any
 * duplicated lines, fails (exit 1) and the failure names the clone pairs
 * touching it. A file below its baseline passes with a notice. No baseline file
 * is exit 0 with a notice (the baseline lands separately, BS#3696).
 * `--update` rewrites the baseline but only lowers counts; a raise needs
 * `--allow-increase`, except the first `--update` with no baseline file. An unclean jscpd run (non-zero exit, missing or
 * unparseable report) is exit 2 and never writes a baseline.
 * `--report` prints `{tool, version, scopes: {<name>: totals}}`, jscpd's
 * scope-level token and line totals.
 *
 * jscpd is run through `npx --yes jscpd@<JSCPD_VERSION>`, never imported, so
 * this works in a tree with no node_modules. Keep JSCPD_VERSION equal to the
 * devDependency. Flags: `--scope <name>` limits any mode to one scope;
 * `--root <dir>` scans another tree; `--baseline <file>` overrides the path;
 * `--input <report.json>` (with `--exit-code <n>`) stands in for the jscpd run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JSCPD_VERSION = '4.0.5';
export const SCOPES = { prod: ['apps', 'shared', 'jobs'], tests: ['tests'] };

const EMPTY = '{"statistics":{"formats":{}},"duplicates":[]}';

class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/** Throws rather than exiting, so `finally` blocks (the temp output folder) run. */
const fail = (code, message) => {
  throw new Fail(code, message);
};

function readReport(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fail(2, `no jscpd report at ${file} (jscpd wrote none: no scannable file?)`);
  }
}

function runJscpd(root, dirs) {
  const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
  try {
    const run = spawnSync(
      'npx',
      [
        '--yes',
        `jscpd@${JSCPD_VERSION}`,
        ...dirs,
        ...['--min-tokens', '50', '--gitignore', '--silent', '--reporters', 'json', '--output', out],
        ...['--format', 'typescript,tsx,javascript,jsx'],
        ...['--ignore', '**/*.d.ts,**/generated/**,**/migrations/**,**/*.snap'],
        // jscpd's defaults (1,000 lines, 100 KB) silently skip the largest files.
        ...['--max-lines', '10000000', '--max-size', '1gb'],
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
    if (run.error || run.status !== 0) {
      fail(2, `jscpd did not run cleanly (status ${run.status}, ${run.error?.message ?? run.stderr.trim()})`);
    }
    return readReport(join(out, 'jscpd-report.json'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Duplicated lines per file (union of its clone ranges), clone pairs, and the totals. */
function summarize(reportText, root) {
  let report;
  try {
    report = JSON.parse(reportText);
    if (!report.statistics?.formats || !Array.isArray(report.duplicates)) throw new Error('unexpected shape');
  } catch (e) {
    fail(2, `the jscpd report is missing or unparseable: ${e.message}`);
  }
  const lengths = {};
  const lengthOf = (name) =>
    (lengths[name] ??= (() => {
      try {
        return readFileSync(join(root, name), 'utf8').replace(/\n$/, '').split('\n').length;
      } catch {
        return Infinity; // a canned report may name files that are not on disk
      }
    })());
  const covered = {};
  for (const { firstFile: a, secondFile: b } of report.duplicates) {
    for (const [name, start, end] of [
      [a.name, a.start, a.end],
      [b.name, b.start, Math.min(b.start + (a.end - a.start), lengthOf(b.name))],
    ]) {
      const lines = (covered[name] ??= new Set());
      for (let line = start; line <= end; line++) lines.add(line);
    }
  }
  const files = Object.fromEntries(Object.entries(covered).map(([file, lines]) => [file, lines.size]));
  const t = report.statistics.total ?? {};
  const totals = {
    duplicatedTokens: t.duplicatedTokens ?? 0,
    duplicatedLines: t.duplicatedLines ?? 0,
    totalTokens: t.tokens ?? 0,
    totalLines: t.lines ?? 0,
    percentage: t.percentage ?? 0,
  };
  return { files, totals, pairs: report.duplicates };
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

function clonePairsTouching(file, pairs) {
  const where = (f) => `${f.name}:${f.start}-${f.end}`;
  return pairs
    .filter((p) => p.firstFile.name === file || p.secondFile.name === file)
    .map((p) => `    ${where(p.firstFile)} <-> ${where(p.secondFile)}`);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const root = flag('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const baselinePath = flag('--baseline') ?? join(root, 'duplication-baseline.json');
  const only = flag('--scope');
  if (only && !SCOPES[only]) fail(2, `unknown scope "${only}" (expected ${Object.keys(SCOPES).join(' or ')})`);
  const names = only ? [only] : Object.keys(SCOPES);

  // Look for the baseline before the slow jscpd run, so the no-baseline path skips it.
  let baseline = { scopes: {} };
  let fresh = false; // no baseline file yet: nothing to ratchet against
  if (!args.includes('--report')) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') fail(2, `could not read the baseline: ${e.message}`);
      if (!args.includes('--update')) {
        console.log(`check-duplication: no baseline at ${baselinePath}; nothing to compare (exit 0).`);
        return 0;
      }
      fresh = true;
    }
  }
  const recorded = (name) => baseline.scopes?.[name]?.files ?? {};

  const results = {};
  for (const name of names) {
    const dirs = SCOPES[name].filter((d) => existsSync(join(root, d)));
    const input = flag('--input');
    if (input && Number(flag('--exit-code') ?? 0) !== 0) fail(2, `jscpd exited with status ${flag('--exit-code')}`);
    results[name] =
      input || dirs.length ? summarize(input ? readReport(input) : runJscpd(root, dirs), root) : summarize(EMPTY, root);
  }

  if (args.includes('--report')) {
    const scopes = Object.fromEntries(names.map((n) => [n, results[n].totals]));
    console.log(JSON.stringify({ tool: 'jscpd', version: JSCPD_VERSION, scopes }, null, 2));
    return 0;
  }

  if (args.includes('--update')) {
    const raised = names.flatMap((n) =>
      Object.entries(results[n].files)
        .filter(([file, lines]) => lines > (recorded(n)[file] ?? 0))
        .map(([file, lines]) => `  ${n}: ${file}: ${lines} lines, baseline ${recorded(n)[file] ?? 0}`)
    );
    if (raised.length > 0 && !fresh && !args.includes('--allow-increase')) {
      fail(
        1,
        `--update only lowers counts, and these files rose or are new. Nothing was written.\n${raised.join('\n')}\nFix the duplication, or pass --allow-increase if a reviewer will look at the raise.`
      );
    }
    const scopes = { ...baseline.scopes };
    for (const n of names) scopes[n] = { files: sortKeys(results[n].files) };
    writeFileSync(baselinePath, JSON.stringify({ scopes }, null, 2) + '\n');
    console.log(`Baseline rewritten for ${names.join(', ')}.`);
    return 0;
  }

  let failed = false;
  for (const n of names) {
    for (const [file, lines] of Object.entries(results[n].files)) {
      const base = recorded(n)[file] ?? 0;
      if (lines > base) {
        failed = true;
        console.error(`${n}: ${file} has ${lines} duplicated lines, baseline ${base}. Clone pairs:`);
        console.error(clonePairsTouching(file, results[n].pairs).join('\n'));
      }
    }
    for (const [file, base] of Object.entries(recorded(n))) {
      const now = results[n].files[file] ?? 0;
      if (now < base)
        console.log(`notice: ${n}: ${file} fell from ${base} to ${now} duplicated lines; run --update to lock it in.`);
    }
  }
  if (failed) {
    const scope = only ? ` --scope ${only}` : '';
    console.error(
      `If the rise comes only from a reformat (a Prettier rewrap, say), accept it with: node scripts/check-duplication.mjs${scope} --update --allow-increase`
    );
  } else {
    console.log('check-duplication: no file above its duplication baseline.');
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    console.error(`check-duplication: ${e.message}`);
    process.exitCode = e.code;
  }
}
