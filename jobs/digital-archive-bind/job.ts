/**
 * One-shot CLI entrypoint (BS#2319): inventory the AzuraCast DigitalOcean
 * Space, group + match files into albums, and write `digital_asset`
 * (`needs_review`) + `digital_asset_file` candidate rows for human review.
 * Dry-run by default; `--apply` writes.
 *
 * Four modes, mutually exclusive:
 *   (no flags)                the inventory/match dry run -- reports what
 *                              WOULD be written, writes nothing.
 *   --apply                   the same run, for real.
 *   --apply --rebind-keys F   the same run, and object keys listed in file
 *                              F re-open their slot even if it's `rejected`
 *                              (the merge.ts collision-DELETE recovery path;
 *                              never overrides a `bound` slot).
 *   --export <path>           write every `needs_review` asset to a review
 *                              CSV. No inventory scan, no S3 access.
 *   --import <path>           read a reviewed CSV back and flip exactly the
 *                              rows marked `bound`/`rejected`. No inventory
 *                              scan, no S3 access.
 */

import { readFileSync, writeFileSync } from 'fs';
import { captureError, closeLogger, initLogger, log } from './logger.js';
import { runInventoryAndBind, closeDatabase } from './orchestrate.js';
import { formatSummary } from './report.js';
import { exportReviewCsv, importReviewCsv } from './csv.js';
import { applyReviewDecisions } from './write.js';
import { loadNeedsReviewRows } from './review.js';

const JOB_NAME = 'digital-archive-bind';

const flagValue = (name: string): string | undefined => {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const hasFlag = (name: string): boolean => process.argv.slice(2).includes(name);

const loadRebindKeys = (path: string): Set<string> => {
  const text = readFileSync(path, 'utf8');
  const keys = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return new Set(keys);
};

const runExport = async (outPath: string): Promise<void> => {
  const rows = await loadNeedsReviewRows();
  writeFileSync(outPath, exportReviewCsv(rows));
  log('info', 'export', `wrote ${rows.length} needs_review row(s) to ${outPath}`, { rows: rows.length, path: outPath });
};

const runImport = async (inPath: string): Promise<void> => {
  const text = readFileSync(inPath, 'utf8');
  const decisions = importReviewCsv(text);
  const result = await applyReviewDecisions(decisions);
  log('info', 'import', `applied ${result.rowsUpdated} decision(s) from ${inPath}`, {
    bound_attempted: result.boundAttempted,
    rejected_attempted: result.rejectedAttempted,
    rows_updated: result.rowsUpdated,
    path: inPath,
  });
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const exportPath = flagValue('--export');
    const importPath = flagValue('--import');

    if (exportPath) {
      await runExport(exportPath);
      return;
    }
    if (importPath) {
      await runImport(importPath);
      return;
    }

    const apply = hasFlag('--apply');
    const rebindKeysPath = flagValue('--rebind-keys');
    const rebindKeys = rebindKeysPath ? loadRebindKeys(rebindKeysPath) : new Set<string>();

    log('info', 'init', `${JOB_NAME} initialized`, { apply, rebind_keys_count: rebindKeys.size });

    const summary = await runInventoryAndBind({ apply, rebindKeys });
    const text = formatSummary(summary);
    console.log(text);
    log('info', apply ? 'apply' : 'dry_run', `${JOB_NAME} finished`, {
      files_seen: summary.filesSeen,
      albums_grouped: summary.albumsGrouped,
      matched_exact: summary.matchedExact,
      matched_fuzzy: summary.matchedFuzzy,
      ambiguous: summary.ambiguous,
      unmatched: summary.unmatched,
      inserted: summary.inserted,
      reopened: summary.reopened,
      rejected_blocked: summary.rejectedBlocked.length,
      bound_drift: summary.boundDrift.length,
      same_run_collision: summary.sameRunCollision.length,
    });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabase();
    await closeLogger();
  }
};

// Guard the auto-invoke so the unit suite's module load doesn't fire a
// stray run against the mocked DB. Mirrors `jobs/artwork-provenance-remediation/job.ts`.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
