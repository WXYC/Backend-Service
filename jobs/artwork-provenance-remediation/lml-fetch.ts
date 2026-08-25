/**
 * LML lookup shim for the artwork-provenance-remediation drain (BS#2258).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the BS#887 shared
 * chokepoint) with this drain's `defaultLmlLimiter` injected, so the
 * `BACKFILL_LML_*` ceiling shared with the sibling drains applies and a
 * concurrent run of two jobs still adds up to one ceiling.
 *
 * **`budgetMs: null` is load-bearing, not a stylistic choice.** Class 5's
 * default sends `X-Caller-Budget-Ms`, which caps LML's effective search
 * budget at ~4s and arms its empty-state fast-degrade. For an ordinary
 * backfill that is the *desired* behavior — a hard-miss row should give up
 * fast and free the shared Discogs ceiling (see `policy.ts`'s per-class
 * empty-state decision). This drain is the case that decision carves out.
 * Its rows are precisely the ones whose covers LML could not resolve on the
 * first attempt: the cover lives under a different release id than the one
 * LML bound, so answering them means a cold cross-pressing resolution, which
 * measures 4-20s on prod. Under the 4s cap LML returns `degraded:
 * deadline_exceeded` with `artwork: null` — which this drain would score as
 * `no_match` and leave wrong. That is the same failure BS#1914 documented for
 * the enrichment-worker.
 *
 * The BS#2258 pilot that justified running this drain at all (120/120 rows
 * resolved to real release covers) was measured headerless. Sending a budget
 * header here would run the drain under conditions the pilot did not measure,
 * against the one class of row most likely to be hurt by it. `budgetMs: null`
 * is the BS#1914 suppression lever that reproduces the measured conditions.
 *
 * Safe because the pacing is elsewhere: `BACKFILL_LML_MAX_CONCURRENT=1` and
 * `BACKFILL_LML_RATE_PER_MIN=20` mean at most one in-flight request at a
 * pace far under saturation, and `TIMEOUT_MS` still bounds each call.
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

/**
 * 35_000 ms, the sibling drains' value: LML's 25.25 s per-item cascade
 * exhaustion cap (LML#370) plus ~10 s of headroom for queue contention with
 * the live backend. Override via `ARTWORK_PROVENANCE_TIMEOUT_MS`.
 */
const TIMEOUT_MS = envInt('ARTWORK_PROVENANCE_TIMEOUT_MS', 35_000);

export const lookupMetadata = (artist: string, album: string): Promise<LookupResponse> =>
  sharedLookupMetadata(artist, album, undefined, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    budgetMs: null,
    caller: 'artwork-provenance-remediation',
  });
