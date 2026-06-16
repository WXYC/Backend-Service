/**
 * Thin LML shim for flowsheet-reenrichment (BS#1433).
 *
 * 5-line shim over @wxyc/lml-client.lookupMetadata. No dedup cache needed:
 * this is a one-shot drain of specific enriched_no_match rows, not the
 * recurring cron that processes ~1.96M rows where (artist, album) repeats
 * at 1.74×. The cacheHit field is always false; the orchestrator's throttle
 * logic branches on it, so the field must be present on the return type.
 *
 * Timeout sized at 35 s to clear LML#370's 25.25 s per-item cascade-
 * exhaustion cap plus headroom. Matches the sibling cron's setting.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';
import { defaultLmlLimiter } from './lml-limiter.js';

export type LookupResult = { response: LookupResponse; cacheHit: false };

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LookupResult> => {
  const response = await sharedLookupMetadata(artist, album, track, {
    limiter: defaultLmlLimiter,
    timeoutMs: 35_000,
    caller: 'flowsheet-reenrichment',
  });
  return { response, cacheHit: false };
};
