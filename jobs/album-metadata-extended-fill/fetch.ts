/**
 * The LML reads (BS#1442): the release a row names, and its primary artist,
 * memoized per run. They skip the client's limiter and breaker, so the job
 * paces them itself. `lmlFetch` turns every 5xx into 502 and a timeout into
 * 504, and passes a 404 through.
 */

import { LmlAuthError, LmlClientError, getArtistDetails, getPinnedTracklists, getRelease } from '@wxyc/lml-client';
import type { DiscogsArtistDetails, DiscogsReleaseMetadata, PinnedTracklistsResult } from '@wxyc/lml-client';

export const CALLER = 'album-metadata-extended-fill' as const;

/** One call's result: the value and LML's latency (pacing excluded), or the status. */
export type Fetched<T> = { ok: true; value: T; latencyMs?: number } | { ok: false; status: number };

export interface Pacer {
  wait(): Promise<void>;
}

/** Spaces call starts `60000 / ratePerMin` ms apart; the first does not wait. */
export const createPacer = (
  ratePerMin: number,
  { now = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}
): Pacer => {
  let last: number | undefined;
  return {
    wait: async () => {
      const due = last === undefined ? 0 : last + 60_000 / ratePerMin - now();
      if (due > 0) {
        await sleep(due);
      }
      last = now();
    },
  };
};

export interface LmlFetcher {
  release(releaseId: number): Promise<Fetched<DiscogsReleaseMetadata>>;
  artist(artistId: number): Promise<Fetched<DiscogsArtistDetails>>;
  /** The release pins for a batch of `library.legacy_release_id`s, in order. */
  pins(legacyReleaseIds: number[]): Promise<Fetched<PinnedTracklistsResult[]>>;
  /** Paced LML calls made so far; memo hits and pins calls are not counted. */
  calls(): number;
}

/**
 * The fetch layer for one run. Every call waits on `pacer`. An auth rejection
 * is rethrown (fatal); any other error, an unparseable body included, is a
 * failure with its status (502 when it has none). An artist that answers is
 * fetched once per run; a failure is never memoized. The pins call is not
 * paced: LML answers it from PostgreSQL and spends no Discogs quota.
 */
export const createLmlFetcher = (pacer: Pacer): LmlFetcher => {
  const artists = new Map<number, DiscogsArtistDetails>();
  let calls = 0;
  const call = async <T>(fetch: () => Promise<T>, paced = true): Promise<Fetched<T>> => {
    if (paced) {
      await pacer.wait();
      calls += 1;
    }
    const started = Date.now();
    try {
      return { ok: true, value: await fetch(), latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof LmlAuthError) {
        throw err;
      }
      return { ok: false, status: err instanceof LmlClientError ? err.statusCode : 502 };
    }
  };
  return {
    release: (id) => call(() => getRelease(id, { caller: CALLER })),
    artist: async (id) => {
      const known = artists.get(id);
      if (known) {
        return { ok: true, value: known };
      }
      const fetched = await call(() => getArtistDetails(id, { caller: CALLER }));
      if (fetched.ok) {
        artists.set(id, fetched.value);
      }
      return fetched;
    },
    pins: (ids) => call(() => getPinnedTracklists(ids, { caller: CALLER }), false),
    calls: () => calls,
  };
};
