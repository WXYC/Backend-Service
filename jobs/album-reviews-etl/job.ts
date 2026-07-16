/**
 * Entry point for the album-reviews-etl job (album-reviews-sheet-sync
 * plan / ADR 0011).
 *
 * Nightly pull of the "Album Review Responses" Google Form spreadsheet
 * (Sheets REST v4, service-account JWT, spreadsheets.readonly) into the
 * `album_review_submissions` archive table, keyed on `source_key` so
 * re-runs UPSERT in place — the first production run ingests the entire
 * ~1.6k-row history; every night after is drift-repair. Rows are never
 * deleted, and the post-write link pass FKs `album_id` only on singleton
 * library matches, never overwriting.
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json (`50 4 * * *` UTC = 00:50 EDT / 23:50 EST, between the
 * 04:45 freetext resolve and the 05:00 venue scraper). Container runs to
 * completion. No cooperative pause: the job writes only
 * `album_review_submissions` (never flowsheet-adjacent), ~1.6k rows max,
 * off-peak.
 *
 * Required env: `ALBUM_REVIEWS_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON_B64`
 * (+ optional `ALBUM_REVIEWS_SHEET_RANGE`, `DRY_RUN`) — see
 * docs/env-vars.md.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runEtl, resolveDryRun } from './orchestrate.js';
import {
  createSheetsRequest,
  fetchSheetRows,
  resolveServiceAccountCredentials,
  resolveSheetId,
  resolveSheetRange,
} from './fetch.js';
import { upsertSubmission } from './writer.js';
import { linkSubmissions } from './link.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'album-reviews-etl';

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    // Fail-fast env resolution before any network or DB touch.
    const sheetId = resolveSheetId();
    const range = resolveSheetRange();
    const credentials = resolveServiceAccountCredentials();
    const dryRun = resolveDryRun();
    log('info', 'init', `${JOB_NAME} initialized`, { sheet_id: sheetId, range, dry_run: dryRun });

    const request = createSheetsRequest(credentials);

    // Run guards (empty sheet, zero valid rows, majority-invalid, zero
    // writes) live in runEtl so orchestrate.test.ts can exercise them — a
    // thrown guard lands in the catch below and exits non-zero.
    await runEtl({
      fetchRows: () => fetchSheetRows(sheetId, range, request),
      upsertSubmission,
      linkPass: () => linkSubmissions(),
      dryRun,
    });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
