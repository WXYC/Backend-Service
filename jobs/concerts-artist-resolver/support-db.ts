/**
 * DB I/O for the support resolve arm (support.ts) of
 * jobs/concerts-artist-resolver's four-step run (BS#1760).
 *
 * `loadSupportCandidates` mirrors `loadCandidates` in query.ts (the
 * headliner arm) in spirit — a strict/alias-eligible candidate scan — but
 * over `concert_performers` joined to `concerts`, with a narrower tribute
 * guard. Per the BS#1760 issue's locked decision, the guard here excludes
 * ONLY on the raw performer name (`cp.raw_name !~* '\mtribute'`) and
 * deliberately does NOT inherit the headliner arm's additional
 * `title !~* '\mtribute'` exclusion — the concert title frames the
 * HEADLINER slot, and a support act billed at a tribute show is a real
 * opener, not a mislabeled honoree.
 *
 * `writeSupportArtistId` mirrors `writeArtistId` in writer.ts — a single
 * fill-NULLs-only UPDATE — targeting `concert_performers.artist_id`
 * instead of `concerts.headlining_artist_id`, and touching no other
 * column: this Phase-B pure-SQL arm stamps no attempt-at marker (that
 * binds only the future Phase-D LML arm per docs/migrations.md).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, concertPerformers } from '@wxyc/database';

import type { SupportCandidate } from './support.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERT_PERFORMERS_TABLE = sql.raw(`"${SCHEMA}"."concert_performers"`);
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);

/**
 * Mirrors the identical helper in query.ts / targets.ts / sync-db.ts —
 * fail LOUD on an unrecognized `db.execute()` result shape rather than
 * silently degrade to a healthy-looking zero-work no-op.
 */
const describeShape = (result: unknown): string => {
  if (result === null) return 'null';
  if (result === undefined) return 'undefined';
  if (typeof result !== 'object') return typeof result;
  return `object{${Object.keys(result).join(',')}}`;
};

const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`concerts-artist-resolver.support: unrecognized db.execute() result shape: ${describeShape(result)}`);
};

/**
 * Volume: bounded by the small upcoming-concert window and
 * `SUPPORT_MAX_COUNT` (32) acts per concert — full-set-in-memory is fine
 * at this scale, same call as the headliner arm's `loadCandidates`.
 */
export const loadSupportCandidates = async (): Promise<SupportCandidate[]> => {
  const result: unknown = await db.execute(sql`
    SELECT cp."id", cp."raw_name"
    FROM ${CONCERT_PERFORMERS_TABLE} cp
    JOIN ${CONCERTS_TABLE} c ON c."id" = cp."concert_id"
    WHERE cp."role" = 'support'
      AND cp."artist_id" IS NULL
      AND cp."removed_at" IS NULL
      AND cp."raw_name" !~* '\\mtribute'
      AND c."removed_at" IS NULL
      AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
    ORDER BY cp."id" ASC
  `);
  return unwrapRows<SupportCandidate>(result);
};

export const writeSupportArtistId = async (performerId: number, artistId: number): Promise<{ written: boolean }> => {
  const updated = await db
    .update(concertPerformers)
    .set({ artist_id: artistId })
    .where(and(eq(concertPerformers.id, performerId), isNull(concertPerformers.artist_id)))
    .returning({ id: concertPerformers.id });
  return { written: updated.length === 1 };
};
