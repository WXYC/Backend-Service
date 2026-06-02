/**
 * LML lookup shim for the flowsheet-artwork-repair drain (BS#1209).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared chokepoint from
 * BS#887) with this drain's `defaultLmlLimiter` injected so the BACKFILL_LML_*
 * env-var ceiling applies — same env vars as `flowsheet-metadata-backfill`,
 * cooperative pacing across both jobs.
 *
 * Per-call timeout default 35_000 ms — same value as the sibling drain
 * (`jobs/flowsheet-metadata-backfill/lml-fetch.ts`), sized to clear LML's
 * 25.25 s per-item cascade-exhaustion cap (LML#370) plus ~10 s of headroom
 * for queue contention with the live backend + ROM + the sibling drain.
 * Override via `BACKFILL_ARTWORK_REPAIR_TIMEOUT_MS`.
 *
 * Drives both the free-form and linked phases — the `track` parameter is
 * provided for free-form (which has flowsheet.track_title) and omitted
 * for linked (album-level lookup, no track context).
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_ARTWORK_REPAIR_TIMEOUT_MS', 35_000);

export const lookupMetadata = (artist: string, album?: string, track?: string): Promise<LookupResponse> =>
  sharedLookupMetadata(artist, album, track, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'flowsheet-artwork-repair',
  });
