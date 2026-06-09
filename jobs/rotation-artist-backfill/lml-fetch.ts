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
 * from transient error (network, 5xx, timeout) without sniffing exception
 * shapes. 404 is terminal — LML#510 has already tombstoned the row
 * server-side, so the orchestrator can skip it on this run AND on every
 * future run without persisting any BS-side state. Transient errors leave
 * the row retryable.
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
  // 4xx (other than 404) is non-retryable in practice — it's a client
  // misconfiguration (auth, malformed id) that won't change between runs.
  // 5xx + timeouts + network errors are retryable.
  const retryable = !isLmlClientError(e) || e.statusCode >= 500 || e.statusCode === 504;
  return { kind: 'error', error: err, retryable };
};

export const fetchRelease = async (releaseId: number): Promise<FetchOutcome<DiscogsReleaseMetadata>> => {
  return Sentry.startSpan(
    {
      name: 'lml.get_release',
      op: 'http.client',
      attributes: { 'lml.release_id': releaseId },
    },
    async () => {
      try {
        const value = await defaultLmlLimiter.run(() => getRelease(releaseId));
        return { kind: 'ok', value };
      } catch (e) {
        return classifyError(e);
      }
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
      try {
        const value = await defaultLmlLimiter.run(() => getArtistDetails(artistId));
        return { kind: 'ok', value };
      } catch (e) {
        return classifyError(e);
      }
    }
  );
};

/**
 * Project the Phase-1 set of artist ids credited on a release: the main
 * `release.artists` array (and `release.artist_id`, the singular primary).
 * `extra_artists` (producers, engineers, etc.) and per-track artists are
 * Phase-2 follow-ups per the issue. NULL `artist_id` values on credits
 * are skipped — they mark name-only credits that don't have a Discogs
 * artist row to refresh.
 */
export const extractPhase1ArtistIds = (release: DiscogsReleaseMetadata): number[] => {
  const ids = new Set<number>();
  if (typeof release.artist_id === 'number') ids.add(release.artist_id);
  for (const credit of release.artists ?? []) {
    if (typeof credit.artist_id === 'number') ids.add(credit.artist_id);
  }
  return Array.from(ids).sort((a, b) => a - b);
};
