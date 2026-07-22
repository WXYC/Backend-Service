/**
 * Thin LML shim for streaming-url-upgrade (BS#1672).
 *
 * Shim over @wxyc/lml-client.lookupMetadata with `extended: true` — the
 * job re-runs the same full `/api/v1/lookup` (artist + album + song,
 * extended) path the enrichment worker used when it persisted the search
 * URL, so the re-query has the same shot at a verified link. Response-level
 * dedup lives in the orchestrator's URL cache (keyed on artist+album+track),
 * not here.
 *
 * Timeout: UPGRADE_LML_PER_CALL_TIMEOUT_MS, default 35 s — clears LML#370's
 * 25.25 s per-item cascade-exhaustion cap plus headroom, so a legitimately
 * slow resolve is not cut off and miscounted as lml_error. Reads the env var
 * at module load; see README note on env-var timing.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';
import { envInt } from './env.js';
import { defaultLmlLimiter } from './lml-limiter.js';

const TIMEOUT_MS = envInt('UPGRADE_LML_PER_CALL_TIMEOUT_MS', 35_000, 'lml-fetch');

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LookupResponse> =>
  sharedLookupMetadata(artist, album, track, {
    extended: true,
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'streaming-url-upgrade',
  });
