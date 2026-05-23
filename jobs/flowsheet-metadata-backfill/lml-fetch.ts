/**
 * Backfill-side LML lookup helper for the historical metadata drain
 * (#638 / #641).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint introduced in BS#887) and injects:
 *   - the backfill's own `defaultLmlLimiter` so this surface gets its stricter
 *     BACKFILL_LML_* rate ceiling instead of the runtime path's
 *     LML_CLIENT_* defaults (BS#995 / BS#994), and
 *   - a tighter per-call abort budget (`BACKFILL_LML_PER_CALL_TIMEOUT_MS`,
 *     default 8000 ms) so cold-tail rows that LML can't resolve quickly
 *     don't hold one of LML's serialized Discogs fan-out slots for the
 *     runtime path's 30 s (BS#994 follow-up, retro 2026-05-23). Rows that
 *     exceed the budget stay `metadata_attempt_at IS NULL` and are
 *     retried on the next pass when LML's cache is warmer / once LML#338
 *     lands. Pattern mirrors BS#992's per-caller timeout for the rotation
 *     picker.
 *
 * The third parameter is named `track` (not `song`) to match the orchestrator's
 * `EnrichRow.track_title` field. It's plumbed through to LML's `body.song` by
 * the shared client — `@wxyc/lml-client` exhaustively tests the wire shape
 * (#888 regression), so this shim doesn't repeat that assertion.
 */

import { lookupMetadata as sharedLookupMetadata, type LookupResponse } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Number(raw) (not parseInt) so partial-parse strings like "8000banana"
  // surface as NaN and get rejected instead of silently coercing.
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 8000);

export const lookupMetadata = (artist: string, album?: string, track?: string): Promise<LookupResponse> =>
  sharedLookupMetadata(artist, album, track, { limiter: defaultLmlLimiter, timeoutMs: TIMEOUT_MS });
