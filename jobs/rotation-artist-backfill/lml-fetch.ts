/**
 * LML release + artist fetch helpers for jobs/rotation-artist-backfill
 * (BS#1361).
 *
 * Wraps `@wxyc/lml-client`'s `getRelease` / `getArtistDetails` in this
 * job's stricter `defaultLmlLimiter` (BACKFILL_LML_*). The lml-client's
 * own `lmlFetch` chokepoint does NOT thread either endpoint through a
 * limiter today — its default limiter only covers `/lookup` and
 * `/lookup/bulk` — so the wrap here is what keeps a fan-out of N artist
 * calls per release from saturating LML's per-replica 50 req/min Discogs
 * egress cap.
 *
 * Both endpoints return a `FetchOutcome` discriminated union so the
 * orchestrator can split 404 (artist or release deleted upstream of LML)
 * from transient error (network, 5xx, 429, timeout) without sniffing
 * exception shapes. 404 is terminal — LML#510 has already tombstoned
 * the row server-side, so the orchestrator can skip it on this run AND
 * on every future run without persisting any BS-side state. Transient
 * errors leave the row retryable; the `retryable` flag is informational
 * (projected onto Sentry log lines for ops triage) — this job does not
 * in-process retry because the cron re-runs daily and the next pass
 * picks up unwritten rows naturally.
 *
 * BS-side upper bound on a single call is `lmlFetch`'s hard-coded 30 s
 * (shared/lml-client/src/index.ts TIMEOUT_MS — neither `getRelease` nor
 * `getArtistDetails` accepts an override today). LML server-side can
 * hold a Discogs round-trip up to ~62 s during a 429-retry storm
 * (LML's `discogs_max_retries=5`, jittered exponential capped at 60 s).
 * So a BS-side 30 s timeout can return `{kind: 'error'}` while LML's
 * background completes and writes back the row — counters undercount
 * the actual back-fill rate. Tracking the fix on lml-client's surface
 * is out of scope here; see PR description for the follow-up note.
 */

import * as Sentry from '@sentry/node';

import {
  type DiscogsArtistDetails,
  type DiscogsReleaseMetadata,
  LmlClientError,
  getArtistDetails,
  getRelease,
} from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

export type FetchOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'error'; error: Error; retryable: boolean };

const isLmlClientError = (e: unknown): e is LmlClientError => e instanceof LmlClientError;

const classifyError = (e: unknown): FetchOutcome<never> => {
  if (isLmlClientError(e) && e.statusCode === 404) return { kind: 'not_found' };
  const err = e instanceof Error ? e : new Error(String(e));
  // 4xx other than 404/429 is non-retryable in practice — client
  // misconfiguration (auth, malformed id) that won't change between
  // runs. 5xx, 429 (rate limit), and network/timeout errors are
  // retryable: 429 fires when LML's per-replica 50 req/min Discogs
  // cap collides with foreground traffic; >= 500 covers upstream
  // failures including the 504 that lml-client mints for AbortError.
  const retryable = !isLmlClientError(e) || e.statusCode === 429 || e.statusCode >= 500;
  return { kind: 'error', error: err, retryable };
};

/**
 * Mark the active Sentry span with a non-OK status when the call ends
 * in a classified failure. Per OTLP semantic conventions, span status
 * is the queryable signal for error-rate dashboards — without this,
 * every span comes back `ok` even when classifyError returned
 * `kind: 'error'` (because the throw was caught and converted to a
 * return value). One per finding from review pass.
 */
const markSpanOutcome = <T>(outcome: FetchOutcome<T>): void => {
  if (outcome.kind === 'ok') return;
  const span = Sentry.getActiveSpan();
  if (!span) return;
  if (outcome.kind === 'not_found') {
    span.setStatus({ code: 2, message: 'not_found' });
  } else {
    span.setStatus({ code: 2, message: outcome.retryable ? 'retryable_error' : 'permanent_error' });
  }
};

export const fetchRelease = async (releaseId: number): Promise<FetchOutcome<DiscogsReleaseMetadata>> => {
  return Sentry.startSpan(
    {
      name: 'lml.get_release',
      op: 'http.client',
      attributes: { 'lml.release_id': releaseId },
    },
    async () => {
      let outcome: FetchOutcome<DiscogsReleaseMetadata>;
      try {
        const value = await defaultLmlLimiter.run(() => getRelease(releaseId));
        outcome = { kind: 'ok', value };
      } catch (e) {
        outcome = classifyError(e);
      }
      markSpanOutcome(outcome);
      return outcome;
    }
  );
};

export const fetchArtist = async (artistId: number): Promise<FetchOutcome<DiscogsArtistDetails>> => {
  return Sentry.startSpan(
    {
      name: 'lml.get_artist',
      op: 'http.client',
      attributes: { 'lml.artist_id': artistId },
    },
    async () => {
      let outcome: FetchOutcome<DiscogsArtistDetails>;
      try {
        const value = await defaultLmlLimiter.run(() => getArtistDetails(artistId));
        outcome = { kind: 'ok', value };
      } catch (e) {
        outcome = classifyError(e);
      }
      markSpanOutcome(outcome);
      return outcome;
    }
  );
};

/**
 * Discogs artist ids are positive integers. Filter out NULL (name-only
 * credits) AND the JS-level pitfalls — `typeof NaN === 'number'`,
 * `typeof Infinity === 'number'`, and `0` (a Discogs sentinel for
 * unknown / unattributed artist that has no real `/artists/0` payload).
 *
 * Forwarding `0` here is especially bad: it 404s, and LML#510 now
 * tombstones 404 ids, which would write a permanent negative-cache
 * entry for `id=0` that poisons every other LML caller resolving
 * the sentinel.
 */
const isValidArtistId = (x: number | null | undefined): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x > 0;

/**
 * Project the Phase-1 set of artist ids credited on a release: the main
 * `release.artists` array (and `release.artist_id`, the singular primary).
 * `extra_artists` (producers, engineers, etc.) and per-track artists are
 * Phase-2 follow-ups per the issue.
 */
export const extractPhase1ArtistIds = (release: DiscogsReleaseMetadata): number[] => {
  const ids = new Set<number>();
  if (isValidArtistId(release.artist_id)) ids.add(release.artist_id);
  for (const credit of release.artists ?? []) {
    if (isValidArtistId(credit.artist_id)) ids.add(credit.artist_id);
  }
  return Array.from(ids).sort((a, b) => a - b);
};
