/**
 * Backfill orchestrator for B-2.2.
 *
 * Iterates flowsheet rows where `album_id` is NULL (and the row has artist +
 * album text), calls LML, looks up library rows by `canonical_entity_id`,
 * and stamps the linkage when exactly one library row matches.
 *
 * Resumability:
 *   - Across runs: linked rows fall out of the WHERE filter
 *     (`album_id IS NULL` no longer matches them). review / no_match /
 *     no_library_match / error rows stay in the pool and get retried on the
 *     next sweep — that's the issue's "leave for review queue if persistent"
 *     contract. There is no persistent cursor; the WHERE filter alone makes
 *     restarts cheap.
 *   - Within a single run: id-cursor pagination (`id > $lastId`) keeps the
 *     SELECT bounded as the run progresses. Order is `id ASC` (oldest
 *     first) so the long-tail backlog drains in chronological order.
 *
 * The row-eligibility filter unions the two unlinked buckets:
 *   - `legacy_release_id IS NULL`              — never had a tubafrenzy ID.
 *   - `legacy_link_attempted_at IS NOT NULL`   — broken-FK residual stamped
 *                                                by B-0.5's recovery job.
 *
 * The `lookup` function is injected so tests can drive the orchestration
 * without standing up an LML stub. Production wires it to the HTTP fetch in
 * `lml-fetch.ts`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import type { LmlLookupResponse } from './lml-types.js';
import { resolveLmlSignal } from './resolve.js';

const JOB_NAME = 'flowsheet-lml-link-backfill';

export const BATCH_SIZE = 500;

/**
 * Default inter-call delay between LML lookups, in ms. Sized so a single
 * sweep stays well below LML's effective rate budget; raise via the opts knob
 * if LML's deployed rate limit tightens. Tests override to 0.
 */
export const THROTTLE_MS = 100;

export type FlowsheetRow = {
  id: number;
  artist_name: string | null;
  album_title: string | null;
};

export type LookupFn = (artist: string, album?: string) => Promise<LmlLookupResponse>;

export type ProcessStatus = 'linked' | 'multi_match' | 'no_library_match' | 'review' | 'no_match' | 'error';

export type Totals = {
  scanned: number;
  linked: number;
  multi_match: number;
  no_library_match: number;
  review: number;
  no_match: number;
  error: number;
};

export type RunResult = { totals: Totals };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stamp the four linkage columns on a flowsheet row. The
 * `album_id IS NULL` guard keeps a concurrent linker (forward-path B-2.1 or
 * review queue B-3.1) from overwriting an in-flight link.
 */
export const applyLink = async (args: {
  flowsheetId: number;
  libraryId: number;
  confidence: number;
}): Promise<void> => {
  await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet"
    SET "album_id" = ${args.libraryId},
        "linkage_source" = 'lml_high_confidence',
        "linkage_confidence" = ${args.confidence},
        "linked_at" = now()
    WHERE "id" = ${args.flowsheetId}
      AND "album_id" IS NULL
  `);
};

/**
 * Look up the library rows whose `canonical_entity_id` equals the LML-derived
 * entity id. Returns 0, 1, or N ids; the caller branches on count.
 */
export const findLibraryByCanonicalEntity = async (canonicalEntityId: string): Promise<number[]> => {
  const rows = (await db.execute(sql`
    SELECT "id"
    FROM "wxyc_schema"."library"
    WHERE "canonical_entity_id" = ${canonicalEntityId}
  `)) as unknown as Array<{ id: number }>;
  return (rows ?? []).map((r) => r.id);
};

/**
 * Drive a single flowsheet row through lookup → resolve → library-lookup →
 * apply. Returns the outcome. Errors are logged and consumed; they do not
 * bubble up so a single bad row cannot abort the run.
 */
export const processRow = async (row: FlowsheetRow, deps: { lookup: LookupFn }): Promise<ProcessStatus> => {
  const artist = row.artist_name ?? '';
  const album = row.album_title ?? undefined;

  if (!artist || !album) {
    return 'no_match';
  }

  let response: LmlLookupResponse;
  try {
    response = await deps.lookup(artist, album);
  } catch (error) {
    console.warn(`[${JOB_NAME}] LML lookup failed for flowsheet.id=${row.id}:`, (error as Error).message);
    return 'error';
  }

  const signal = resolveLmlSignal(response);
  if (signal.status === 'review') return 'review';
  if (signal.status === 'no_match') return 'no_match';

  const libraryIds = await findLibraryByCanonicalEntity(signal.canonical_entity_id);
  if (libraryIds.length === 0) return 'no_library_match';
  if (libraryIds.length > 1) return 'multi_match';

  await applyLink({
    flowsheetId: row.id,
    libraryId: libraryIds[0],
    confidence: signal.confidence,
  });
  return 'linked';
};

/**
 * Read the next batch of unlinked flowsheet rows. The id-cursor predicate
 * keeps the SELECT bounded as the run progresses; combined with the
 * unlinked-row filters, it makes restarts cheap (no persistent cursor needed).
 *
 * The `(legacy_release_id IS NULL OR legacy_link_attempted_at IS NOT NULL)`
 * union pulls in both the never-had-FK rows (~889K) and the B-0.5 broken-FK
 * residuals stamped by `jobs/broken-fk-recovery`.
 */
const loadBatch = async (afterId: number, batchSize: number): Promise<FlowsheetRow[]> => {
  const rows = (await db.execute(sql`
    SELECT "id", "artist_name", "album_title"
    FROM "wxyc_schema"."flowsheet"
    WHERE "album_id" IS NULL
      AND "entry_type" = 'track'
      AND "artist_name" IS NOT NULL
      AND "album_title" IS NOT NULL
      AND ("legacy_release_id" IS NULL OR "legacy_link_attempted_at" IS NOT NULL)
      AND "id" > ${afterId}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as FlowsheetRow[];
  return rows ?? [];
};

const formatTotals = (totals: Totals): string =>
  `scanned=${totals.scanned} linked=${totals.linked} multi_match=${totals.multi_match} ` +
  `no_library_match=${totals.no_library_match} review=${totals.review} ` +
  `no_match=${totals.no_match} error=${totals.error}`;

export const runBackfill = async (opts: {
  lookup: LookupFn;
  batchSize?: number;
  throttleMs?: number;
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;

  console.log(`[${JOB_NAME}] Starting. batchSize=${batchSize} throttleMs=${throttleMs}`);

  const totals: Totals = {
    scanned: 0,
    linked: 0,
    multi_match: 0,
    no_library_match: 0,
    review: 0,
    no_match: 0,
    error: 0,
  };
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
