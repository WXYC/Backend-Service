/**
 * Orchestrator for album-critic-reviews-etl (BS#1830).
 *
 * Run shape:
 *   1. Fetch the manifest (already gunzipped to text by the caller) and
 *      parse it line-by-line. Malformed/incomplete lines are counted as
 *      `invalid`, never thrown.
 *   2. Guard: zero parsed items -> throw (empty or wholesale-invalid
 *      manifest is a source regression, not a successful run).
 *   3. Match every parsed item to a linked `library.id` (exact match +
 *      decoration-strip fallback, `match.ts`). Guard: zero matched -> throw
 *      (evaluated regardless of DRY_RUN — a resolver regression or a
 *      corpus gone stale against the library must not hide behind a dry
 *      run).
 *   4. Dedup to one review per album by source preference (`dedup.ts`).
 *      Tally `matched_by_source` from the winners — the coverage-per-source
 *      breakdown the issue's acceptance criteria call for.
 *   5. Anti-join against already-seeded `(album_id, source_url)` pairs
 *      BEFORE any LLM call (`antijoin.ts`) — Haiku extraction is
 *      nondeterministic, so re-extracting an existing row would churn the
 *      UPSERT and re-spend tokens for nothing.
 *   6. DRY_RUN stops here: emits the locked-schema JSON report line on
 *      stdout and returns, having made zero LLM calls and zero writes.
 *   7. Steady state (no new items after the anti-join): logs a distinct
 *      `nothing_new` line so a healthy no-op weekly run reads as "checked,
 *      nothing to do" in logs, not silently indistinguishable from a run
 *      that skipped work.
 *   8. Extract + build + write each new item. A single item's LLM call
 *      throwing is caught and counted (`llm_errors`) — one poisoned article
 *      must not wedge the run. A clean extraction that isn't a usable
 *      review (`buildRow` returns null) is counted (`rejected`), never
 *      thrown.
 *   9. Guard: new items existed but zero were written -> throw (wholesale
 *      extraction/write regression must not report a green run).
 *
 * Dependencies are injected so unit tests drive the orchestrator without
 * network, DB, or the Anthropic SDK; `job.ts` wires the real
 * implementations.
 */
import { parseManifestLines, type CorpusItem } from './manifest.js';
import { dedupeByAlbum, type MatchedItem } from './dedup.js';
import { buildRow, type Extraction } from './extract.js';
import type { UpsertOutcome } from './writer.js';
import { log, captureError } from './logger.js';

const JOB_NAME = 'album-critic-reviews-etl';

export type FetchManifestFn = () => Promise<string>;
export type MatchItemFn = (item: CorpusItem) => Promise<number | null>;
export type LoadExistingPairsFn = (albumIds: number[]) => Promise<Set<string>>;
export type ExtractFn = (item: CorpusItem) => Promise<Extraction>;
export type UpsertRowFn = (row: NonNullable<ReturnType<typeof buildRow>>) => Promise<UpsertOutcome>;

export interface Totals {
  /** Total attempted manifest lines (parsed + invalid); blank lines are not counted. */
  fetched: number;
  parsed: number;
  invalid: number;
  /** Distinct albums matched, post-dedup. */
  matched: number;
  matched_by_source: Record<string, number>;
  already_present: number;
  /** New items reaching (or, in DRY_RUN, that WOULD reach) extraction. */
  would_extract: number;
  extracted: number;
  rejected: number;
  llm_errors: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** written = inserted + updated + unchanged. */
  written: number;
}

const emptyTotals = (): Totals => ({
  fetched: 0,
  parsed: 0,
  invalid: 0,
  matched: 0,
  matched_by_source: {},
  already_present: 0,
  would_extract: 0,
  extracted: 0,
  rejected: 0,
  llm_errors: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  written: 0,
});

export interface RunOptions {
  fetchManifest: FetchManifestFn;
  matchItem: MatchItemFn;
  loadExistingPairs: LoadExistingPairsFn;
  extract: ExtractFn;
  upsertRow: UpsertRowFn;
  /** Resolved from DRY_RUN by job.ts; injectable for tests. */
  dryRun?: boolean;
}

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

  log('info', 'started', `${JOB_NAME} starting`, { dry_run: dryRun });

  // 1. Fetch + parse.
  const raw = await opts.fetchManifest();
  const { items, invalid } = parseManifestLines(raw);
  totals.parsed = items.length;
  totals.invalid = invalid;
  totals.fetched = items.length + invalid;

  // 2. Guard: zero parsed.
  if (totals.parsed === 0) {
    throw new Error(
      `manifest yielded 0 parsed items (fetched=${totals.fetched}, invalid=${totals.invalid}) — ` +
        'treating an empty or wholesale-invalid manifest as a source regression, not a successful run'
    );
  }

  // 3. Match.
  const matched: MatchedItem[] = [];
  for (const item of items) {
    const albumId = await opts.matchItem(item);
    if (albumId !== null) matched.push({ item, albumId });
  }

  // Guard: zero matched. Evaluated regardless of DRY_RUN.
  if (matched.length === 0) {
    throw new Error(
      `0 of ${totals.parsed} parsed items matched a linked library album — ` +
        'treating as a resolver regression or a corpus gone stale against the library, not a successful run'
    );
  }

  // 4. Dedup + per-source tally.
  const deduped = dedupeByAlbum(matched);
  totals.matched = deduped.length;
  for (const winner of deduped) {
    totals.matched_by_source[winner.item.source] = (totals.matched_by_source[winner.item.source] ?? 0) + 1;
  }

  // 5. Anti-join.
  const existing = await opts.loadExistingPairs(deduped.map((d) => d.albumId));
  const newItems = deduped.filter((d) => !existing.has(`${d.albumId}:${d.item.sourceUrl}`));
  totals.already_present = deduped.length - newItems.length;
  totals.would_extract = newItems.length;

  // 6. DRY_RUN stops here.
  if (dryRun) {
    const report = {
      job: JOB_NAME,
      dry_run: true,
      fetched: totals.fetched,
      parsed: totals.parsed,
      invalid: totals.invalid,
      matched: totals.matched,
      matched_by_source: totals.matched_by_source,
      already_present: totals.already_present,
      would_extract: totals.would_extract,
    };
    process.stdout.write(JSON.stringify(report) + '\n');
    log('info', 'finished', `${JOB_NAME} dry run done (no LLM calls, no writes)`, { ...totals });
    return totals;
  }

  // 7. Steady state.
  if (newItems.length === 0) {
    log('info', 'nothing_new', `${JOB_NAME}: everything matched is already present; nothing new to extract`, {
      matched: totals.matched,
      already_present: totals.already_present,
    });
    log('info', 'finished', `${JOB_NAME} done`, { ...totals });
    return totals;
  }

  // 8. Extract + build + write.
  for (const newItem of newItems) {
    let extraction: Extraction;
    try {
      extraction = await opts.extract(newItem.item);
    } catch (error) {
      totals.llm_errors += 1;
      log('warn', 'llm_error', `Haiku extraction failed for ${newItem.item.sourceUrl}`, {
        source_url: newItem.item.sourceUrl,
        error_message: (error as Error).message,
      });
      captureError(error, 'llm_error', { source_url: newItem.item.sourceUrl });
      continue;
    }

    const row = buildRow(newItem.item, newItem.albumId, extraction);
    if (row === null) {
      totals.rejected += 1;
      continue;
    }

    totals.extracted += 1;
    const outcome = await opts.upsertRow(row);
    if (outcome.inserted) totals.inserted += 1;
    else if (outcome.updated) totals.updated += 1;
    else totals.unchanged += 1;
  }
  totals.written = totals.inserted + totals.updated + totals.unchanged;

  // 9. Guard: new items existed but zero were written.
  if (totals.written === 0) {
    throw new Error(
      `${newItems.length} new items reached extraction but 0 were written ` +
        `(rejected=${totals.rejected}, llm_errors=${totals.llm_errors}) — ` +
        'treating as a wholesale extraction/write regression, not a successful run'
    );
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return totals;
};
