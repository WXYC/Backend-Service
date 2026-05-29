/**
 * LML lookup shim for the BS#1209 drain. Delegates to
 * `@wxyc/lml-client.lookupMetadata` with this drain's `defaultLmlLimiter`
 * injected.
 *
 * Per-call timeout default 35_000 ms — sized to clear LML#370's 25.25 s
 * per-item cascade-exhaustion cap plus ~10 s of queue-contention headroom.
 * Shares the env var with `flowsheet-metadata-backfill` so an operator
 * tightening one job's per-call budget tightens both — same cooperative-
 * pacing pattern as BACKFILL_LML_RATE_PER_MIN.
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

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000);

export const lookupMetadata = (artist: string, album?: string, track?: string): Promise<LookupResponse> =>
  sharedLookupMetadata(artist, album, track, { limiter: defaultLmlLimiter, timeoutMs: TIMEOUT_MS });
