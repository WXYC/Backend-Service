/**
 * One batch of the re-ask (BS#3145): one bulk LML call for admitted rows, one verdict each, and the guarded write for
 * each writing verdict. Its own module because `job.ts` belongs to the options slice (BS#3144). A failed bulk call
 * leaves every album `indeterminate` and carried; a write that throws is `write_failed` and carried, and the batch
 * goes on. With `write: null` (`--preview`, BS#3150) it asks and decides the same way and writes nothing.
 */

import { bulkLookupMetadata, type BulkLookupItem, type BulkLookupResultItem } from '@wxyc/lml-client';
import type { ReaskCandidate as CohortRow } from './cohort.js';
import { decideReask, type ReaskCandidate, type Verdict } from './decide.js';
import type { ManifestEntry } from './inputs.js';
import { captureError, log } from './logger.js';
import { writeAlbum } from './write.js';

/**
 * A cohort row and the manifest entry `admit` asked it on (`ask: true` only). Admission checked that the entry graded
 * this row's own releases, so `toCandidate` takes the ids from the entry, where they are never null.
 */
export interface AdmittedRow {
  row: CohortRow;
  entry: ManifestEntry;
}

/** The join: decide's view of an admitted row. A `pin_removed` entry's `pin_release_id` is the removed release. */
export const toCandidate = ({ row, entry }: AdmittedRow): ReaskCandidate => {
  const base = { legacy_release_id: row.legacy_release_id, artist_name: row.artist_name, album_title: row.album_title };
  return row.reason === 'pin_mismatch'
    ? { ...base, reason: 'pin_mismatch', pin_release_id: entry.pin_release_id }
    : {
        ...base,
        reason: 'pin_removed',
        stored_release_id: entry.stored_release_id,
        expected_release_id: entry.expected_release_id,
      };
};

/** One counter per verdict, plus what the writes did. An absent counter is zero. */
export type BatchTotals = Partial<
  Record<Verdict['kind'] | 'written' | 'skipped_raced' | 'write_failed' | 'artist_cleared' | 'unexpected_index', number>
>;

/** One album's answer and verdict, in batch order. `item` is undefined when LML gave no slot for it. */
export interface DecidedRow {
  admitted: AdmittedRow;
  item: BulkLookupResultItem | undefined;
  verdict: Verdict;
}

export interface BatchResult {
  totals: BatchTotals;
  /** Asked again next run: LML gave no usable answer, or the write threw. */
  carriedAlbumIds: number[];
  decided: DecidedRow[];
}

export interface BatchOptions {
  /** What every write is stamped with; null writes nothing (`--preview`). */
  write: { runId: string; pinExportSha256: string } | null;
  timeoutMs: number;
}

const errorMessage = (err: unknown): string => {
  // Drizzle's own message is the statement and its parameters; what the database said is on `.cause`.
  const reason = (err as { cause?: unknown } | null)?.cause ?? err;
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
};

/**
 * `allowReleaseResolutionFallback: true` is the point of the job (decision 5): without it LML skips the pin
 * prefetch and every answer is the matcher's pick. `budgetMs: null` sends no budget header (BS#2978).
 */
const ask = async (batch: AdmittedRow[], timeoutMs: number): Promise<BulkLookupResultItem[] | undefined> => {
  const items: BulkLookupItem[] = batch.map(({ row }) => ({
    artist: row.artist_name,
    album: row.album_title,
    raw_message: `${row.artist_name} - ${row.album_title}`,
    extended: true,
  }));
  try {
    const response: { results?: unknown } | null = await bulkLookupMetadata(items, {
      caller: 'album-metadata-reask',
      allowReleaseResolutionFallback: true,
      budgetMs: null,
      timeoutMs,
    });
    if (!Array.isArray(response?.results)) throw new Error('LML bulk response carried no results array');
    return response.results as BulkLookupResultItem[];
  } catch (err) {
    const extra = { size: batch.length, first_album_id: batch[0]?.row.album_id ?? null };
    log('warn', 'lml_batch_failed', 'no usable bulk response; whole batch left unwritten', {
      ...extra,
      error_message: errorMessage(err),
    });
    captureError(err, 'lml_batch_failed', extra);
    return undefined;
  }
};

export const runBatch = async (batch: AdmittedRow[], options: BatchOptions): Promise<BatchResult> => {
  const result: BatchResult = { totals: {}, carriedAlbumIds: [], decided: [] };
  if (batch.length === 0) return result;
  const count = (key: keyof BatchTotals): void => {
    result.totals[key] = (result.totals[key] ?? 0) + 1;
  };
  const results = await ask(batch, options.timeoutMs);

  for (const [position, admitted] of batch.entries()) {
    const { row, entry } = admitted;
    const item = results?.[position];
    const verdict = decideReask(toCandidate(admitted), item, position);
    result.decided.push({ admitted, item, verdict });
    count(verdict.kind);
    if (verdict.kind === 'indeterminate') {
      result.carriedAlbumIds.push(row.album_id);
      // An LML contract break (BS#1088): alerted, as in the bio fill, not only counted.
      if (verdict.unexpectedIndex) {
        count('unexpected_index');
        captureError(new Error('bulk result out of input order'), 'unexpected_index', { album_id: row.album_id });
      }
    }
    // Only `rebind`, `rebind_unpinned` and `clear` carry a payload. Every other verdict names its album, so a
    // listed verdict (`pin_not_bound`, `matcher_agrees_with_removed`, ...) can be traced without a re-run.
    if (!('payload' in verdict)) {
      log('info', 'not_written', `${verdict.kind} for album_id=${row.album_id}`, {
        album_id: row.album_id,
        legacy_release_id: row.legacy_release_id,
        verdict: verdict.kind,
        status: item?.status ?? null,
        degraded_reason: item?.lookup?.degraded_reason ?? null,
        got_index: item?.index ?? null,
      });
      continue;
    }
    if (options.write === null) {
      continue;
    }

    try {
      const outcome = await writeAlbum({
        run_id: options.write.runId,
        pin_export_sha256: options.write.pinExportSha256,
        row,
        tier: entry.tier,
        verdict,
      });
      count(outcome.written ? 'written' : 'skipped_raced');
      if (outcome.written && outcome.artist_cleared) count('artist_cleared');
    } catch (err) {
      count('write_failed');
      result.carriedAlbumIds.push(row.album_id);
      log('warn', 'write_failed', `album write threw for album_id=${row.album_id}; not written`, {
        album_id: row.album_id,
        error_message: errorMessage(err),
      });
      captureError(err, 'write_failed', { album_id: row.album_id });
    }
  }
  return result;
};
