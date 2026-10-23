#!/usr/bin/env node
/**
 * Per-file copy-paste ratchet over jscpd (BS#3695).
 *
 * Nothing else stops a PR from adding copy-paste. This runs jscpd per scope
 * (`prod` = apps shared jobs; `tests` = tests) and compares each file's
 * duplicated-token count with `duplication-baseline.json`
 * (`{scopes: {prod: {files: {path: tokens}}, tests: {...}}}`). The unit is
 * duplicated tokens per file, summed across formats (jscpd splits .tsx and .js
 * files across formats). Clone lists are never baselined: they are located by
 * line ranges, so any edit above a clone moves it.
 *
 * Check (default): a file above its baseline, or absent from it with any
 * duplicated tokens, fails (exit 1) and the failure names the clone pairs
 * touching it. A file below its baseline passes with a notice. No baseline file
 * is exit 0 with a notice (the baseline lands separately, BS#3696).
 * `--update` rewrites the baseline but only lowers counts; a raise needs
 * `--allow-increase`. An unclean jscpd run (non-zero exit, missing or
 * unparseable report) is exit 2 and never writes a baseline.
 * `--report` prints `{tool, version, scopes: {<name>: totals}}`.
 *
 * jscpd is run through `npx --yes jscpd@<JSCPD_VERSION>`, never imported, so
 * this works in a tree with no node_modules. Keep JSCPD_VERSION equal to the
 * devDependency. Flags: `--scope <name>` limits any mode to one scope;
 * `--root <dir>` scans another tree; `--baseline <file>` overrides the path;
 * `--input <report.json>` (with `--exit-code <n>`) stands in for the jscpd run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const JSCPD_VERSION = '4.0.5';
export const SCOPES = { prod: ['apps', 'shared', 'jobs'], tests: ['tests'] };

const EMPTY = '{"statistics":{"formats":{}},"duplicates":[]}';

const fail = (code, message) => {
  console.error(`check-duplication: ${message}`);
  process.exit(code);
};

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
    return readFileSync(join(out, 'jscpd-report.json'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Duplicated tokens per file (summed across formats), clone pairs, and the totals. */
function summarize(reportText) {
  let report;
  try {
    report = JSON.parse(reportText);
    if (!report.statistics?.formats || !Array.isArray(report.duplicates)) throw new Error('unexpected shape');
  } catch (e) {
    fail(2, `the jscpd report is missing or unparseable: ${e.message}`);
  }
  const files = {};
  for (const format of Object.values(report.statistics.formats)) {
    for (const [file, s] of Object.entries(format.sources ?? {})) {
      if (s.duplicatedTokens > 0) files[file] = (files[file] ?? 0) + s.duplicatedTokens;
    }
  }
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

  const results = {};
  for (const name of names) {
    const dirs = SCOPES[name].filter((d) => existsSync(join(root, d)));
    const input = flag('--input');
    if (input && Number(flag('--exit-code') ?? 0) !== 0) fail(2, `jscpd exited with status ${flag('--exit-code')}`);
    results[name] =
      input || dirs.length ? summarize(input ? readFileSync(input, 'utf8') : runJscpd(root, dirs)) : summarize(EMPTY);
  }

  if (args.includes('--report')) {
    const scopes = Object.fromEntries(names.map((n) => [n, results[n].totals]));
    console.log(JSON.stringify({ tool: 'jscpd', version: JSCPD_VERSION, scopes }, null, 2));
    return;
  }

  let baseline = { scopes: {} };
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') fail(2, `could not read the baseline: ${e.message}`);
    if (!args.includes('--update')) {
      console.log(`check-duplication: no baseline at ${baselinePath}; nothing to compare (exit 0).`);
      return;
    }
  }
  const recorded = (name) => baseline.scopes?.[name]?.files ?? {};

  if (args.includes('--update')) {
    const raised = names.flatMap((n) =>
      Object.entries(results[n].files)
        .filter(([file, tokens]) => tokens > (recorded(n)[file] ?? 0))
        .map(([file, tokens]) => `  ${n}: ${file}: ${tokens} tokens, baseline ${recorded(n)[file] ?? 0}`)
    );
    if (raised.length > 0 && !args.includes('--allow-increase')) {
      fail(
        1,
        `--update only lowers counts, and these files rose or are new. Nothing was written.\n${raised.join('\n')}\nFix the duplication, or pass --allow-increase if a reviewer will look at the raise.`
      );
    }
    const scopes = { ...baseline.scopes };
    for (const n of names) scopes[n] = { files: sortKeys(results[n].files) };
    writeFileSync(baselinePath, JSON.stringify({ scopes }, null, 2) + '\n');
    console.log(`Baseline rewritten for ${names.join(', ')}.`);
    return;
  }

  let failed = false;
  for (const n of names) {
    for (const [file, tokens] of Object.entries(results[n].files)) {
      const base = recorded(n)[file] ?? 0;
      if (tokens > base) {
        failed = true;
        console.error(`${n}: ${file} has ${tokens} duplicated tokens, baseline ${base}. Clone pairs:`);
        console.error(clonePairsTouching(file, results[n].pairs).join('\n'));
      }
    }
    for (const [file, base] of Object.entries(recorded(n))) {
      const now = results[n].files[file] ?? 0;
      if (now < base)
        console.log(`notice: ${n}: ${file} fell from ${base} to ${now} duplicated tokens; run --update to lock it in.`);
    }
  }
  if (failed) process.exit(1);
  console.log('check-duplication: no file above its duplication baseline.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
