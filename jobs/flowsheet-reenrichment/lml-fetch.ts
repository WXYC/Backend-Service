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
 * the env var at module load; see README note on env-var timing.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';
import { envInt } from './env.js';
import { defaultLmlLimiter } from './lml-limiter.js';

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000, 'lml-fetch');

export type LookupResult = { response: LookupResponse; cacheHit: boolean };

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LookupResult> => {
  const response = await sharedLookupMetadata(artist, album, track, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'flowsheet-reenrichment',
  });
  return { response, cacheHit: false };
};
