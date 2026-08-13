/**
 * Date-window resolution for jobs/flowsheet-april-gap-import (BS#2119).
 *
 * The cohort spans two sub-populations that are NOT equally safe to import:
 * 399 rows across 15 shows, 2026-04-16 -> 2026-04-20 (the closed #351 residue
 * — the bug that dropped them was fixed forward on 2026-04-20 and nothing
 * still produces this shape), and 4 rows across 3 shows, 2026-08-09 ->
 * 2026-08-11 (post-Phase-3 residue whose provenance is ambiguous: an id
 * present upstream and absent in Backend is EITHER a failed insert-webhook
 * — import is correct — OR a successful DJ delete whose delete-mirror failed
 * — import resurrects a deletion; see `apps/backend/middleware/legacy/
 * flowsheet.mirror.ts`'s `deleteEntry`). The mechanism below handles either
 * population — it is a plain date-window fetch, nothing April-specific — but
 * the DEFAULT window covers only the unambiguous April cohort. Widening it
 * to reach the August rows is a deliberate per-row provenance decision left
 * to a human operator (see the job README and BS#1543), not something this
 * job's default should do silently.
 *
 * Reuses jobs/flowsheet-etl/transform.ts's `parseMySQLDatetime` (imported
 * from the sibling job's tree per the Dockerfile.flowsheet-april-gap-import
 * COPY, the same cross-job reuse `concerts-artist-lml-resolver` uses for
 * `isCleanHeadliner`) so a window boundary parses with the same Eastern
 * wall-clock DST handling tubafrenzy's own epoch-ms columns implicitly use.
 */
import { parseMySQLDatetime } from '../flowsheet-etl/transform.js';

/** Eastern wall-clock, inclusive start of the #351 residue window. */
export const DEFAULT_WINDOW_START = '2026-04-16 00:00:00';
/** Eastern wall-clock, EXCLUSIVE end — covers through the end of 2026-04-20. */
export const DEFAULT_WINDOW_END = '2026-04-21 00:00:00';

export type Window = { startMs: number; endMs: number };

export const resolveWindow = (
  startRaw: string | undefined = process.env.GAP_IMPORT_WINDOW_START,
  endRaw: string | undefined = process.env.GAP_IMPORT_WINDOW_END
): Window => {
  const startStr = startRaw && startRaw.trim() !== '' ? startRaw : DEFAULT_WINDOW_START;
  const endStr = endRaw && endRaw.trim() !== '' ? endRaw : DEFAULT_WINDOW_END;

  const start = parseMySQLDatetime(startStr);
  if (!start) {
    throw new Error(
      `Invalid GAP_IMPORT_WINDOW_START=${JSON.stringify(startStr)}: expected a MySQL-style ` +
        `'YYYY-MM-DD HH:MM:SS' datetime (interpreted as Eastern wall clock, matching tubafrenzy).`
    );
  }
  const end = parseMySQLDatetime(endStr);
  if (!end) {
    throw new Error(
      `Invalid GAP_IMPORT_WINDOW_END=${JSON.stringify(endStr)}: expected a MySQL-style ` +
        `'YYYY-MM-DD HH:MM:SS' datetime (interpreted as Eastern wall clock, matching tubafrenzy).`
    );
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error(`GAP_IMPORT_WINDOW_END (${endStr}) must be after GAP_IMPORT_WINDOW_START (${startStr}).`);
  }

  return { startMs: start.getTime(), endMs: end.getTime() };
};
