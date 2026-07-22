/**
 * Thin LML shim for apple-music-url-backfill (BS#1631).
 *
 * Shim over @wxyc/lml-client.lookupMetadata with `extended: true` — the
 * issue's contract is a full `/api/v1/lookup` (artist + album + song,
 * extended) so the re-query walks the same path the enrichment worker
 * used when it persisted the null. Response-level dedup lives in the
 * orchestrator's URL cache (keyed on artist+album+track per BS#1192 —
 * apple_music_url is track-aware), not here.
 *
 * Timeout: BACKFILL_LML_PER_CALL_TIMEOUT_MS, default 35 s — clears
 * LML#370's 25.25 s per-item cascade-exhaustion cap plus headroom. Reads
 * the env var at module load; see README note on env-var timing.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';
import { envInt } from './env.js';
import { defaultLmlLimiter } from './lml-limiter.js';

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000, 'lml-fetch');

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LookupResponse> =>
  sharedLookupMetadata(artist, album, track, {
    extended: true,
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'apple-music-url-backfill',
  });
