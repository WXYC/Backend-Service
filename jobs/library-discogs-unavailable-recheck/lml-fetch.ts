/**
 * LML lookup helper for jobs/library-discogs-unavailable-recheck (BS#1283 /
 * epic #1280 sub-issue 3).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint introduced in BS#887) and injects:
 *   - `forceLookup: true` (BS#1293's `LookupOptions.forceLookup`) so the
 *     runtime `discogsUnavailable` gate is bypassed — this job's entire job
 *     is to re-ask LML about a release the runtime path would otherwise
 *     skip. Explicit per-call flag, not a caller-side handshake that flips
 *     `discogsUnavailable` itself (the parent issue's self-review flagged
 *     that shape as refactor-fragile).
 *   - this job's own `defaultLmlLimiter` (job-scoped
 *     LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_* env vars) so this surface's
 *     accounting is separate and tunable from every other cron's.
 *   - a per-call abort budget (`LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_LML_
 *     TIMEOUT_MS`, default 8000 ms), matching the sibling backfill jobs'
 *     posture of a tight fast-fail budget for a batch/backfill caller.
 *
 * Returns a discriminated `LookupOutcome` (`orchestrate.ts`): `match` (a
 * Discogs release id plus the raw LML `artwork.confidence` score) or
 * `no_match`. The 0.95 confidence floor is NOT applied here — see
 * `orchestrate.ts`'s module doc for why that check lives in the orchestrator.
 *
 * Deliberately does NOT gate on `search_type` the way
 * `jobs/rotation-release-id-backfill` does (BS#1516's `direct`-only trust
 * gate) — the parent issue's spec is a flat confidence-score floor with no
 * search_type condition, and adding one here would be an un-requested
 * tightening beyond BS#1283's scope.
 */

import { lookupMetadata as sharedLookupMetadata } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';
import type { LookupOutcome } from './orchestrate.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_LML_TIMEOUT_MS', 8000);

export const lookupRecheck = async (artist: string, album: string): Promise<LookupOutcome> => {
  const response = await sharedLookupMetadata(artist, album, undefined, {
    forceLookup: true,
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'library-discogs-unavailable-recheck',
  });
  // Distinguish a transient LML timeout body (`{timeout:true, results:[]}`,
  // e.g. LML#370 cascade-exhaustion) from a definitive no-match. Throw so the
  // orchestrator counts it as `lml_error` and leaves `last_discogs_recheck_at`
  // untouched (retryable the next run) instead of stamping a row behind the
  // 7-day recheck window on a response LML never actually finished resolving.
  if (response.timeout) {
    throw new Error('LML lookup returned a timeout body; treating as transient so the row stays retryable');
  }

  const top = response.results?.[0];
  const releaseId = top?.artwork?.release_id;
  // `release_id: 0` is the BS#1185 streaming-only sentinel — not a linkable
  // Discogs release. This recheck's whole purpose is to find a real release
  // id to persist on `rotation.discogs_release_id`, so the sentinel is not a
  // match here (unlike the release-id backfill, which persists it and lets
  // the orchestrator's sentinel counter own the rejection).
  if (typeof releaseId !== 'number' || releaseId <= 0) {
    return { kind: 'no_match' };
  }

  const rawConfidence = top?.artwork?.confidence;
  const confidence = typeof rawConfidence === 'number' ? rawConfidence : 0;
  return { kind: 'match', releaseId, confidence };
};
