/**
 * Semantic-index graph client for jobs/concerts-similar-artists-enrichment
 * (BS#1626, On Tour R3b).
 *
 * The affinity-neighbors endpoint (WXYC/semantic-index#354) is a SEPARATE
 * service from LML — public, no-auth, and its worst case is a bounded local
 * SQLite read (100 ids × 2×limit). So unlike the LML jobs there is no API key,
 * no shared `@wxyc/lml-client` chokepoint, and no rate limiter: the job makes
 * ~1 request per night against a ~50-id cohort. Just a plain `fetch` with an
 * `AbortController` timeout.
 *
 * Contract (WXYC/semantic-index#354, amended after design review):
 *   POST /graph/library-artists/neighbors/batch
 *     body   { "library_artist_ids": [4210, 887, ...], "limit": 20 }   // heat omitted → server default 0.5
 *     cap    100 ids/call; a structured 422 beyond (never silent truncation).
 *     resp   { "results": { "4210": [{"artist_id": 5121, "weight": 4.83}, ...], "887": [] } }
 *            keyed by STRINGIFIED input id; every requested id present; weights
 *            descending, list-relative. An empty list = unknown/unmapped/
 *            ambiguous headliner → "no enrichment", NOT an error.
 *
 * `library_artist_ids` and the response `artist_id`s are both WXYC catalog
 * artist ids (`artists.id`) — the SAME keyspace as `concerts.headlining_artist_id`
 * (verified: semantic-index#358 populates `artist.wxyc_library_code_id` from
 * `wxyc_schema.artists.id`). So the job sends `headlining_artist_id` verbatim
 * and persists the returned neighbors with zero field mapping.
 */

import type { SimilarArtistNeighbor } from '@wxyc/database';

export type { SimilarArtistNeighbor };

/** Endpoint per-request id cap (WXYC/semantic-index#354). The job chunks at this. */
export const SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP = 100;

/** Base URL of the semantic-index graph API (explore.wxyc.org in prod). */
const DEFAULT_BASE_URL = 'https://explore.wxyc.org';

/** Per-id slice of the batch-size-scaled socket timeout (ms). */
const PER_ID_TIMEOUT_MS = 200;
/** Fixed slack on top of the per-id budget — connection setup + serialization. */
const TIMEOUT_SLACK_MS = 20_000;
/** Fixed timeout for the tiny `/health` probe (ms). */
const HEALTH_TIMEOUT_MS = 10_000;

/** Thrown on any non-2xx response or an unparseable/misshaped body. */
export class NeighborsClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'NeighborsClientError';
  }
}

/** `results` keyed by the STRINGIFIED input id → that headliner's neighbor list. */
export type NeighborsBatchResponse = { results: Record<string, SimilarArtistNeighbor[]> };

const baseUrl = (): string => (process.env.SEMANTIC_INDEX_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

/**
 * Fetch top-K affinity neighbors for a batch of library artist ids.
 *
 * @param libraryArtistIds - `artists.id` values (1..=`SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP`).
 * @param limit - top-K per input id (K=20 in production).
 * @param options.timeoutMs - override the batch-scaled socket timeout.
 * @throws NeighborsClientError on empty/oversize input, non-2xx, or a body
 *   whose `results` is not an object — the whole chunk is then retryable next
 *   run (the caller counts it and continues, never wiping rows).
 */
export async function fetchNeighborsBatch(
  libraryArtistIds: number[],
  limit: number,
  options?: { timeoutMs?: number }
): Promise<NeighborsBatchResponse> {
  if (libraryArtistIds.length === 0) {
    throw new NeighborsClientError('fetchNeighborsBatch requires at least 1 id.', 400);
  }
  if (libraryArtistIds.length > SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP) {
    throw new NeighborsClientError(
      `fetchNeighborsBatch exceeded the cap of ${SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP} ids (received ${libraryArtistIds.length}).`,
      400
    );
  }

  const timeoutMs = options?.timeoutMs ?? libraryArtistIds.length * PER_ID_TIMEOUT_MS + TIMEOUT_SLACK_MS;
  // heat is deliberately omitted — the server default (0.5) is the production blend.
  const body = JSON.stringify({ library_artist_ids: libraryArtistIds, limit });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The timer is cleared only AFTER the body is read (not right after headers
  // arrive), so a stalled body stream is aborted by the same timeout as the
  // request — the whole call is bounded by `timeoutMs`.
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/graph/library-artists/neighbors/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new NeighborsClientError(`fetchNeighborsBatch: request failed (${reason}).`);
    }

    if (!response.ok) {
      throw new NeighborsClientError(
        `fetchNeighborsBatch: semantic-index returned HTTP ${response.status}.`,
        response.status
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new NeighborsClientError(`fetchNeighborsBatch: unparseable body (${reason}).`, 502);
    }

    const results = (parsed as { results?: unknown } | null)?.results;
    if (results === null || typeof results !== 'object' || Array.isArray(results)) {
      throw new NeighborsClientError('fetchNeighborsBatch: response `results` is not an object.', 502);
    }

    return { results: results as Record<string, SimilarArtistNeighbor[]> };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort probe of the graph API's `/health`, read ONLY to enrich the loud
 * log when a whole sweep comes back empty — `mapped_artist_count` (~22K when
 * healthy) is the integration-day disambiguator between "mapping not yet
 * rebuilt" (near-0) and a real fault (healthy count, still all-empty). Never
 * throws: a health-probe failure must not change the write decision, so any
 * error resolves to `{ mapped_artist_count: null }`.
 */
export async function fetchGraphHealth(): Promise<{ mapped_artist_count: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl()}/health`, { signal: controller.signal });
    if (!response.ok) return { mapped_artist_count: null };
    const body = (await response.json()) as { mapped_artist_count?: unknown };
    const count = body?.mapped_artist_count;
    return { mapped_artist_count: typeof count === 'number' && Number.isFinite(count) ? count : null };
  } catch {
    return { mapped_artist_count: null };
  } finally {
    clearTimeout(timer);
  }
}
