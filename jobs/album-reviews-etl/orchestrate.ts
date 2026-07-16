/**
 * Orchestrator for album-reviews-etl.
 *
 * Run shape:
 *   1. Fetch the whole tab (header row + data rows, right-padded).
 *   2. Resolve column indexes from the header row — a missing REQUIRED
 *      header throws (contract break with the sheet, run fails loudly).
 *   3. Map every data row FIRST (pure, no writes): validity filter
 *      (artist + album non-empty — drops the formula-residue junk row),
 *      fallback source keys warn-logged, normalization anomalies
 *      warn-logged with per-class Sentry dedup.
 *   4. Run guards, BEFORE any write: zero valid rows, or more than half
 *      the fetched rows invalid, throw — a ~1.6k-row live archive is
 *      never empty, and a majority-invalid sheet is a source regression
 *      the writes must not launder into a green cron run.
 *   5. UPSERT each valid row (per-row errors are caught, counted in the
 *      log, and deduped into Sentry — one bad row never wedges the run);
 *      then the guard: valid rows present but ZERO written throws (the
 *      donor's wholesale-write-regression guard).
 *   6. Library link pass over the still-unlinked rows.
 *
 * DRY_RUN (donor-standard resolver, `true|1`) stops after step 4, emits
 * the locked-schema JSON report line on stdout (schema documented in the
 * job README — treat as an interface, do not add keys casually), and
 * returns the mapping counters with every write counter at 0.
 *
 * Dependencies are injected so unit tests drive the orchestrator without
 * network or DB; production wires them in `job.ts`.
 */

import { mapRow, resolveHeaderIndexes, type SubmissionContent } from './map.js';
import type { UpsertOutcome } from './writer.js';
import type { LinkTotals } from './link.js';
import { captureError, captureWarning, log } from './logger.js';

const JOB_NAME = 'album-reviews-etl';

export type FetchRowsFn = () => Promise<string[][]>;
export type UpsertFn = (content: SubmissionContent) => Promise<UpsertOutcome>;
export type LinkPassFn = () => Promise<LinkTotals>;

export type Totals = {
  /** Data rows in the sheet (header row excluded). */
  fetched: number;
  /** Rows passing the artist+album validity rule. */
  valid: number;
  /** Rows dropped by the validity rule (counted + logged, never thrown). */
  skipped_invalid: number;
  /** Valid rows keyed via the `nots:` fallback (missing/unparseable timestamp). */
  fallback_keys: number;
  inserted: number;
  updated: number;
  /** setWhere-suppressed no-op upserts — the idempotent-nightly signal. */
  unchanged: number;
  linked: number;
  link_ambiguous: number;
  link_unmatched: number;
};

const emptyTotals = (): Totals => ({
  fetched: 0,
  valid: 0,
  skipped_invalid: 0,
  fallback_keys: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  linked: 0,
  link_ambiguous: 0,
  link_unmatched: 0,
});

export type RunOptions = {
  fetchRows: FetchRowsFn;
  upsertSubmission: UpsertFn;
  linkPass: LinkPassFn;
  /** Resolved from DRY_RUN by job.ts; injectable for tests. */
  dryRun?: boolean;
};

/** Donor-standard DRY_RUN resolver: locked truthy set `true|1`
 *  (case-insensitive); everything else — including `yes` — is false. */
export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

export const runEtl = async (opts: RunOptions): Promise<Totals> => {
  const totals = emptyTotals();
  const dryRun = opts.dryRun ?? false;

  // Sentry dedup: capture each distinct (step, message-class) once per
  // run; the counters + per-row log lines carry the volume. Digits are
  // normalized out of the key (row indexes, timestamps in messages) so N
  // same-class anomalies are one Sentry event, not a quota flood.
  const capturedKeys = new Set<string>();
  const warnOnce = (message: string, step: string, extra: Record<string, unknown> = {}): void => {
    const key = `${step}:${message.replace(/\d+/g, '#')}`;
    if (capturedKeys.has(key)) return;
    capturedKeys.add(key);
    captureWarning(message, step, extra);
  };
  const captureOnce = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
    const key = `${step}:${(error as Error).message.replace(/\d+/g, '#')}`;
    if (capturedKeys.has(key)) return;
    capturedKeys.add(key);
    captureError(error, step, extra);
  };

  log('info', 'started', `${JOB_NAME} starting`, { dry_run: dryRun });

  // 1. Fetch. An empty body (not even a header row) is a source
  // regression (wrong tab name, wiped sheet), never a successful run.
  const rows = await opts.fetchRows();
  if (rows.length === 0) {
    throw new Error(
      'sheet returned an empty response (no header row) — wrong ALBUM_REVIEWS_SHEET_RANGE or a wiped tab; ' +
        'treating as a source regression, not a successful run'
    );
  }

  // 2. Header contract. Throws on a missing required header.
  const headers = resolveHeaderIndexes(rows[0]);

  // 3. Map everything BEFORE any write.
  const dataRows = rows.slice(1);
  totals.fetched = dataRows.length;
  const mapped: Array<{ content: SubmissionContent; rowIndex: number }> = [];
  for (const [index, dataRow] of dataRows.entries()) {
    // Sheet row number for log attribution: +2 (1-based + header row).
    const sheetRow = index + 2;
    const result = mapRow(dataRow, headers);
    if (result.kind === 'invalid') {
      totals.skipped_invalid += 1;
      log('warn', 'row_invalid', `skipping sheet row ${sheetRow}: ${result.reason}`, { sheet_row: sheetRow });
      continue;
    }
    totals.valid += 1;
    if (result.fallback_key) {
      totals.fallback_keys += 1;
      log(
        'warn',
        'fallback_key',
        `sheet row ${sheetRow} has no parseable timestamp; keyed ${result.content.source_key}`,
        {
          sheet_row: sheetRow,
          source_key: result.content.source_key,
        }
      );
      warnOnce(
        `${JOB_NAME}: row keyed via the nots: fallback (missing/unparseable form timestamp) — an edited reviewer string on such a row mints a new row`,
        'fallback_key',
        { source_key: result.content.source_key }
      );
    }
    for (const warning of result.warnings) {
      log('warn', 'normalization_anomaly', `sheet row ${sheetRow}: ${warning}`, { sheet_row: sheetRow });
      warnOnce(`${JOB_NAME}: ${warning}`, 'normalization_anomaly');
    }
    mapped.push({ content: result.content, rowIndex: sheetRow });
  }

  // 4. Run guards — BEFORE any write, so a drifted sheet can't half-write.
  if (totals.valid === 0) {
    throw new Error(
      `no valid rows mapped (fetched=${totals.fetched}, skipped_invalid=${totals.skipped_invalid}) — ` +
        'a ~1.6k-row live archive is never empty; treating as a source regression'
    );
  }
  if (totals.skipped_invalid * 2 > totals.fetched) {
    throw new Error(
      `${totals.skipped_invalid} of ${totals.fetched} fetched rows invalid (>50%) — ` +
        'wholesale sheet drift (header/shape change); refusing to write'
    );
  }

  if (dryRun) {
    // Locked report schema — documented in the job README; consumers may
    // parse this line, so keys are an interface.
    const report = {
      job: JOB_NAME,
      dry_run: true,
      fetched: totals.fetched,
      valid: totals.valid,
      skipped_invalid: totals.skipped_invalid,
      fallback_keys: totals.fallback_keys,
      would_write: totals.valid,
    };
    process.stdout.write(JSON.stringify(report) + '\n');
    log('info', 'finished', `${JOB_NAME} dry run done (no writes)`, { ...totals });
    return totals;
  }

  // 5. UPSERT each valid row. Per-row errors are caught + counted in the
  // log; one poisoned row must not wedge the nightly mirror.
  let upsertErrors = 0;
  for (const { content, rowIndex } of mapped) {
    try {
      const outcome = await opts.upsertSubmission(content);
      if (outcome.inserted) totals.inserted += 1;
      else if (outcome.updated) totals.updated += 1;
      else totals.unchanged += 1;
    } catch (error) {
      upsertErrors += 1;
      log('warn', 'upsert_error', `failed to upsert sheet row ${rowIndex}`, {
        sheet_row: rowIndex,
        source_key: content.source_key,
        error_message: (error as Error).message,
      });
      captureOnce(error, 'upsert_error', { source_key: content.source_key });
    }
  }
  const written = totals.inserted + totals.updated + totals.unchanged;
  if (written === 0) {
    throw new Error(
      `${totals.valid} valid rows mapped but 0 written (upsert_errors=${upsertErrors}) — ` +
        'wholesale write regression; aborting with non-zero exit'
    );
  }

  // 6. Link pass (its own errors propagate: the archive rows are already
  // safely upserted, and a broken link pass must fail the cron loudly).
  const linkTotals = await opts.linkPass();
  totals.linked = linkTotals.linked;
  totals.link_ambiguous = linkTotals.link_ambiguous;
  totals.link_unmatched = linkTotals.link_unmatched;

  log('info', 'finished', `${JOB_NAME} done`, { ...totals, upsert_errors: upsertErrors });
  return totals;
};
