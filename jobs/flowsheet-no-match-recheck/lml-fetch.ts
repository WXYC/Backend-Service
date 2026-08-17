/**
 * LML lookup helper for jobs/flowsheet-no-match-recheck (BS#2176).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint) via the same `(artist, album, track)`
 * shape `jobs/flowsheet-metadata-backfill` uses — this job re-asks the
 * identical question the live worker originally asked, just later.
 *
 * `extractTrustedArtwork` gates every match through the track-context trust
 * predicate (`isTrustedLmlTrackContextMatch`, BS#1359) before treating a
 * response as resolvable — the exact chokepoint
 * `apps/enrichment-worker/enrich.ts#extractArtwork` uses, so a same-artist
 * substitution (`fallback`/`alternative`/`song_as_artist`) is never
 * auto-persisted here either. This closes one of the three sibling
 * un-gated `extractArtwork`-shaped paths BS#1959 tracks, by making sure
 * this NEW path was gated from day one.
 *
 * `no_match` vs `trust_rejected` (BS#1516): a `no_match` means LML found no
 * candidate at all (or a trusted search_type with no artwork among its
 * results — the BS#961 compilation edge case); `trust_rejected` means LML
 * found a candidate but its `search_type` isn't trustworthy for a
 * track-context write.
 *
 * A cascade-timeout body (`timeout: true`) and a breaker-open/shed degraded
 * response with no usable answer (`degraded_reason: 'upstream_unavailable'`
 * or a shed `outcome`, BS#1995 Arm 3) are both treated as TRANSIENT — thrown
 * so the caller leaves the row's retry marker untouched. This job exists to
 * fix rows wrongly frozen at a permanent no-match; writing a fresh false
 * no-match from an unanswered LML call would be self-defeating.
 */

import {
  lookupMetadata as sharedLookupMetadata,
  isTrustedLmlTrackContextMatch,
  shedReasonOf,
  type DiscogsMatchResult,
  type GatedLookupResponse,
  type LookupResponse,
} from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';
import type { Candidate, LookupOutcome } from './orchestrate.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

// Mirrors flowsheet-metadata-backfill's post-LML#370 tuning: a generous
// per-call budget so a cold, hard-to-resolve release still gets LML's full
// cascade on retry, rather than aborting into a manufactured timeout body.
const TIMEOUT_MS = envInt('FLOWSHEET_NO_MATCH_RECHECK_LML_PER_CALL_TIMEOUT_MS', 35_000);

export const extractTrustedArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
  if (!isTrustedLmlTrackContextMatch(response)) return null;
  // Walk `results` in order rather than reading only `results[0].artwork` —
  // an accepted `compilation` response can pair each `library_item` with
  // its own independently-resolved artwork, so the first entry's `artwork`
  // may be null while a later entry carries it (BS#961).
  for (const result of response.results ?? []) {
    if (result.artwork) return result.artwork;
  }
  return null;
};

const isUnansweredDegraded = (response: LookupResponse, artwork: DiscogsMatchResult | null): boolean => {
  const isShed =
    response.degraded_reason === 'upstream_unavailable' || shedReasonOf(response as GatedLookupResponse) !== undefined;
  return isShed && artwork === null;
};

export const lookupNoMatchRecheck = async (candidate: Candidate): Promise<LookupOutcome> => {
  const response = await sharedLookupMetadata(
    candidate.artist_name,
    candidate.album_title ?? undefined,
    candidate.track_title ?? undefined,
    {
      limiter: defaultLmlLimiter,
      timeoutMs: TIMEOUT_MS,
      caller: 'flowsheet-no-match-recheck',
      discogsUnavailable: candidate.discogs_unavailable,
    }
  );

  if (response.timeout) {
    throw new Error('LML lookup returned a timeout body; treating as transient so the row stays retryable');
  }

  const artwork = extractTrustedArtwork(response);

  if (isUnansweredDegraded(response, artwork)) {
    throw new Error(
      'LML lookup was degraded with no usable answer (breaker-open / shed); treating as transient so the row stays retryable'
    );
  }

  if (artwork) return { kind: 'resolved', artwork };

  if (
    response.search_type === 'direct' ||
    response.search_type === 'compilation' ||
    response.search_type === undefined
  ) {
    // A trusted search_type with no artwork in any result (BS#961 edge
    // case) is a genuine no-match, same as an absent search_type.
    return { kind: 'no_match' };
  }
  if (response.search_type === 'none') {
    return { kind: 'no_match' };
  }
  // fallback | alternative | song_as_artist: LML found a candidate but it's
  // a same-artist substitution, not track-confirmed (BS#1516).
  return { kind: 'trust_rejected', searchType: response.search_type };
};
