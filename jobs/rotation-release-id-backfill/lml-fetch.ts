/**
 * Backfill-side LML lookup helper for jobs/rotation-release-id-backfill
 * (BS#1029).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint introduced in BS#887) and injects:
 *   - the backfill's own `defaultLmlLimiter` so this surface gets its
 *     stricter BACKFILL_LML_* rate ceiling instead of the runtime path's
 *     LML_CLIENT_* defaults (BS#995 / BS#994), and
 *   - a tighter per-call abort budget (`BACKFILL_LML_PER_CALL_TIMEOUT_MS`,
 *     default 8000 ms) so cold-tail rows that LML can't resolve quickly
 *     don't hold one of LML's serialized Discogs fan-out slots for the
 *     runtime path's 30 s (BS#994 / BS#1017).
 *
 * Returns the resolved Discogs release id (or null when LML found no
 * Discogs match). Mirrors the runtime tier-3 path's extraction at
 * `apps/backend/services/library.service.ts:492` so the SAME entity is
 * persisted whether the resolution happened at runtime or offline.
 */

import { lookupMetadata as sharedLookupMetadata } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 8000);

export const lookupReleaseId = async (artist: string, album: string): Promise<number | null> => {
  const response = await sharedLookupMetadata(artist, album, undefined, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
  });
  return response.results?.[0]?.artwork?.release_id ?? null;
};
