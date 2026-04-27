/**
 * Backfill orchestrator for B-1.2.
 *
 * Iterates `library` rows where the canonical entity is unresolved, calls LML
 * for each one, and stamps the result via `applyResolution`. Designed to be
 * resumable and failure-tolerant:
 *
 *   - The WHERE filter is `canonical_entity_id IS NULL AND
 *     canonical_entity_resolved_at IS NULL`. Auto-accepted rows have both;
 *     review-flagged rows have only resolved_at; no_match / error rows have
 *     neither, so they roll forward on the next sweep.
 *   - Within a single run, batches paginate by `id` (last-id cursor). Across
 *     runs, the WHERE filter is what restarts — the cursor doesn't need to
 *     persist.
 *   - One LML failure is logged and counted; the loop continues.
 *
 * The `lookup` function is injected so tests can drive the orchestration
 * without standing up an LML stub. Production wires it to the HTTP fetch in
 * `lml-fetch.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import type { LmlLookupResponse } from './lml-types.js';
import { resolveCanonicalEntity, type Resolution } from './resolve.js';

const JOB_NAME = 'library-canonical-entity-backfill';

export const BATCH_SIZE = 500;

/**
 * Default inter-call delay between LML lookups, in ms. Sized so a single
 * sweep stays well below LML's effective rate budget; raise via the env knob
 * if LML's deployed rate limit tightens. Tests override to 0.
 */
export const THROTTLE_MS = 100;

export type LibraryRow = {
  id: number;
  artist_name: string | null;
  album_title: string | null;
};

export type LookupFn = (artist: string, album?: string) => Promise<LmlLookupResponse>;

export type Totals = {
  scanned: number;
  auto_accept: number;
  review: number;
  no_match: number;
  error: number;
};

export type RunResult = {
  totals: Totals;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Apply a Resolution to a single library row.
 *
 *   - auto_accept → write all three columns. The id is what powers B-2's
 *     flowsheet → library join; the confidence supports retroactive review;
 *     resolved_at supports retry policy and audit.
 *   - review → stamp resolved_at only. canonical_entity_id stays NULL so the
 *     B-3.1 review queue (`canonical_entity_id IS NULL AND
 *     canonical_entity_resolved_at IS NOT NULL`) finds it.
 *   - no_match → no UPDATE. Leaving both columns NULL keeps the row in the
 *     retry pool for the next sweep.
 */
export const applyResolution = async (libraryId: number, resolution: Resolution): Promise<void> => {
  if (resolution.status === 'auto_accept') {
    await db.execute(sql`
      UPDATE "wxyc_schema"."library"
      SET "canonical_entity_id" = ${resolution.canonical_entity_id},
          "canonical_entity_confidence" = ${resolution.confidence},
          "canonical_entity_resolved_at" = now()
      WHERE "id" = ${libraryId}
        AND "canonical_entity_id" IS NULL
    `);
    return;
  }

  if (resolution.status === 'review') {
    await db.execute(sql`
      UPDATE "wxyc_schema"."library"
      SET "canonical_entity_resolved_at" = now()
      WHERE "id" = ${libraryId}
        AND "canonical_entity_id" IS NULL
        AND "canonical_entity_resolved_at" IS NULL
    `);
    return;
  }

  // no_match: intentional no-op so the row stays in the retry pool.
};

/**
 * Drive a single row through lookup → resolve → apply. The result is the
 * outcome status (or 'error' when LML threw). Errors are logged and consumed;
 * they do not bubble up so a single bad row cannot abort the run.
 */
export const processRow = async (
  row: LibraryRow,
  deps: { lookup: LookupFn }
): Promise<'auto_accept' | 'review' | 'no_match' | 'error'> => {
  const artist = row.artist_name ?? '';
  const album = row.album_title ?? undefined;

  if (!artist) {
    // No artist text to query — counts as no_match. The library shouldn't
    // contain rows with NULL artist_name after Epic A.2's backfill, but we
    // don't want to send "" to LML if one slipped through.
    return 'no_match';
  }

  let response: LmlLookupResponse;
  try {
    response = await deps.lookup(artist, album);
  } catch (error) {
    console.warn(`[${JOB_NAME}] LML lookup failed for library.id=${row.id}:`, (error as Error).message);
    return 'error';
  }

  const resolution = resolveCanonicalEntity(response);
  await applyResolution(row.id, resolution);
  return resolution.status;
};

/**
 * Read the next batch of unresolved library rows. The id-cursor predicate
 * keeps the SELECT bounded as the run progresses; combined with the
 * canonical_entity_id IS NULL filter, it also makes restarts cheap.
 */
const loadBatch = async (afterId: number, batchSize: number): Promise<LibraryRow[]> => {
  const rows = (await db.execute(sql`
    SELECT "id", "artist_name", "album_title"
    FROM "wxyc_schema"."library"
    WHERE "canonical_entity_id" IS NULL
      AND "canonical_entity_resolved_at" IS NULL
      AND "id" > ${afterId}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as LibraryRow[];
  return rows ?? [];
};

const formatTotals = (totals: Totals): string =>
  `scanned=${totals.scanned} auto_accept=${totals.auto_accept} review=${totals.review} ` +
  `no_match=${totals.no_match} error=${totals.error}`;

export const runBackfill = async (opts: {
  lookup: LookupFn;
  batchSize?: number;
  throttleMs?: number;
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;

  console.log(`[${JOB_NAME}] Starting. batchSize=${batchSize} throttleMs=${throttleMs}`);

  const totals: Totals = { scanned: 0, auto_accept: 0, review: 0, no_match: 0, error: 0 };
  let lastId = 0;
  let batchIndex = 0;

  while (true) {
    const rows = await loadBatch(lastId, batchSize);
    if (rows.length === 0) break;

    batchIndex += 1;
    for (const row of rows) {
      const status = await processRow(row, { lookup: opts.lookup });
      totals.scanned += 1;
      totals[status] += 1;
      lastId = row.id;
      if (throttleMs > 0) await sleep(throttleMs);
    }

    console.log(`[${JOB_NAME}] batch ${batchIndex} done | ${formatTotals(totals)}`);
  }

  console.log(`[${JOB_NAME}] Done. ${formatTotals(totals)}`);
  return { totals };
};
