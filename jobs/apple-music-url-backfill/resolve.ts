/**
 * Write-side of the apple-music-url-backfill remediation (BS#1631).
 *
 * Backend-Service persisted LML's first-lookup `apple_music_url` nulls
 * verbatim (transient 4s Apple-probe timeouts under the 06:00 UTC backfill
 * flood, plus LML#706's eventually-consistent streaming post-process that
 * returns null on the first lookup) and never re-queries — BS#1192
 * deliberately synthesizes no Apple fallback, so the null became permanent.
 * With the LML-side forward fix (LML#782) deployed, a re-query resolves
 * many of them; this module applies what the re-query returns.
 *
 * Two invariants, both load-bearing:
 *
 *   1. Fill-only: the UPDATE sets `apple_music_url` and NOTHING else
 *      (plus the `updated_at` bump on album_metadata — the writer
 *      convention from apps/enrichment-worker/enrich.ts; flowsheet's
 *      BEFORE UPDATE trigger `bump_flowsheet_updated_at` owns its own
 *      stamp, migration 0084). The row's other metadata columns were
 *      written by a real enrichment pass and are not this job's to touch.
 *
 *   2. Never-overwrite, enforced in SQL: the WHERE carries
 *      `apple_music_url IS NULL` so a URL that appeared between the
 *      orchestrator's SELECT and this UPDATE (enrichment worker, a
 *      parallel run, manual fix) matches 0 rows instead of being
 *      clobbered. The 0-row outcome is reported as 'skipped_non_null'
 *      so the operator can distinguish "I filled it" from "someone else
 *      already had".
 *
 * Errors propagate — the orchestrator's catch arm counts them as
 * 'db_error' and continues.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';

export type ApplyTarget = 'album_metadata' | 'flowsheet';
export type ApplyOutcome = 'resolved' | 'skipped_non_null';

/**
 * Read the Apple Music URL off the top-1 lookup result's artwork block.
 *
 * Top-1 only — mirroring what the enrichment worker persisted from the
 * original lookup; a URL on a lower-ranked (different-release) result is
 * not evidence about THIS row's release. Empty string coerces to null so
 * a degenerate LML response can never write a blank into the column.
 */
export const extractAppleMusicUrl = (response: LookupResponse): string | null => {
  const url = response.results?.[0]?.artwork?.apple_music_url;
  return url ? url : null;
};

/**
 * Fill `apple_music_url` on a single still-null row. `id` is
 * `album_metadata.album_id` or `flowsheet.id` per `target`.
 */
export const applyUpdate = async (target: ApplyTarget, id: number, url: string): Promise<ApplyOutcome> => {
  const updated =
    target === 'album_metadata'
      ? await db
          .update(album_metadata)
          .set({ apple_music_url: url, updated_at: sql`NOW()` })
          .where(and(eq(album_metadata.album_id, id), isNull(album_metadata.apple_music_url)))
          .returning({ id: album_metadata.album_id })
      : await db
          .update(flowsheet)
          .set({ apple_music_url: url })
          .where(and(eq(flowsheet.id, id), isNull(flowsheet.apple_music_url)))
          .returning({ id: flowsheet.id });

  return updated.length === 0 ? 'skipped_non_null' : 'resolved';
};
