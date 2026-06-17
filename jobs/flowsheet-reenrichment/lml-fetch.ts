/**
 * Thin LML shim for flowsheet-reenrichment (BS#1433).
 *
 * Shim over @wxyc/lml-client.lookupMetadata. No dedup cache: this is a
 * one-shot drain of specific enriched_no_match rows, not the recurring
 * cron whose ~1.96M rows see (artist, album) repeats at 1.74×. cacheHit is
 * always false; the type carries `boolean` (not the literal `false`) so a
 * future cache addition isn't a type-narrowing surprise.
 *
 * Timeout: BACKFILL_LML_PER_CALL_TIMEOUT_MS, default 35 s — clears
 * LML#370's 25.25 s per-item cascade-exhaustion cap plus headroom. Reads
 * the env var (review-round-2) so operators can tune without rebuilding.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';
import { defaultLmlLimiter } from './lml-limiter.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Number(raw) — not parseInt — so partial-parse strings like "35000banana"
  // surface as NaN and get rejected instead of silently coercing to 35000.
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive integer); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000);

export type LookupResult = { response: LookupResponse; cacheHit: boolean };

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LookupResult> => {
  const response = await sharedLookupMetadata(artist, album, track, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'flowsheet-reenrichment',
  });
  return { response, cacheHit: false };
};
