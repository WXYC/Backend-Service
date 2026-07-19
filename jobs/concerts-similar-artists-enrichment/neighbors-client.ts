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
 *     resp   { "results": { "4210": [{"artist_id": 5121, "weight": 4.83}, ...], "887": [] },
 *              "source_plays": { "4210": 312, "887": 58 } }
 *            keyed by STRINGIFIED input id; every requested id present; weights
 *            descending, list-relative. An empty list = unknown/unmapped/
 *            ambiguous headliner → "no enrichment", NOT an error.
 *            `source_plays` (semantic-index#369) is an ADDITIVE map of the
 *            headliner's all-time WXYC flowsheet play count (`artist.total_plays`),
 *            keyed by the same stringified input id — the BS#1702 station-affinity
 *            signal. Absent on an un-deployed semantic-index → `{}` here (forward-
 *            and backward-compatible; the station writer simply writes nothing).
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

/**
 * `results` keyed by the STRINGIFIED input id → that headliner's neighbor list.
 * `source_plays` (semantic-index#369, BS#1702) is the additive all-time play
 * count keyed by the same stringified input id; the client always surfaces it as
 * an object (defaulting to `{}` when the un-deployed endpoint omits it), already
 * validated to non-negative integers.
 */
export type NeighborsBatchResponse = {
  results: Record<string, SimilarArtistNeighbor[]>;
  source_plays: Record<string, number>;
};

/** True when `n` is a well-formed neighbor (numeric `artist_id` + `weight`). */
const isSimilarArtistNeighbor = (n: unknown): n is SimilarArtistNeighbor =>
  typeof n === 'object' &&
  n !== null &&
  typeof (n as SimilarArtistNeighbor).artist_id === 'number' &&
  typeof (n as SimilarArtistNeighbor).weight === 'number';

/**
 * True when `v` is a valid play count: a non-negative integer. Mirrors the
 * neighbor sanitization's discipline (reject non-integer/negative rather than
 * trust the wire) — a fractional or negative `total_plays` is a contract
 * violation and is dropped rather than persisted onto `Concert.station_plays`.
 */
const isPlayCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Keep ONLY the two contract fields — drops any extra key the endpoint adds. */
const pickNeighborFields = (n: SimilarArtistNeighbor): SimilarArtistNeighbor => ({
  artist_id: n.artist_id,
  weight: n.weight,
});

const baseUrl = (): string => (process.env.SEMANTIC_INDEX_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

/**
 * The two batch-neighbors endpoints differ only by the reverse-lookup KEY: the
 * library lane (semantic-index#354) keys on `artists.id`; the discogs lane
 * (semantic-index#367) keys on the external Discogs artist id. Everything else —
 * the cap, timeout, `{ results: { "<id>": [...] } }` response shape, and the
 * catalog-id neighbor keyspace — is identical, so both share one impl. Only the
 * request `path` and the JSON body's id-array field name change per lane.
 */
type NeighborsEndpoint = {
  /** POST path under the base URL. */
  path: string;
  /** The JSON body key carrying the id array. */
  bodyKey: 'library_artist_ids' | 'discogs_artist_ids';
  /** Public-function name for error prefixes (so a thrown error names its lane). */
  label: string;
};

const LIBRARY_ENDPOINT: NeighborsEndpoint = {
  path: '/graph/library-artists/neighbors/batch',
  bodyKey: 'library_artist_ids',
  label: 'fetchNeighborsBatch',
};

const DISCOGS_ENDPOINT: NeighborsEndpoint = {
  path: '/graph/discogs-artists/neighbors/batch',
  bodyKey: 'discogs_artist_ids',
  label: 'fetchDiscogsNeighborsBatch',
};

/**
 * Shared batch-neighbors fetch for both lanes. Validates the batch, POSTs the
 * id array under `endpoint.bodyKey` to `endpoint.path`, and sanitizes each
 * verdict to exactly `{ artist_id, weight }`.
 *
 * @throws NeighborsClientError on empty/oversize input, non-2xx, or a body whose
 *   `results` is not an object — the whole chunk is then retryable next run (the
 *   caller counts it and continues, never wiping rows).
 */
async function fetchNeighborsBatchImpl(
  ids: number[],
  limit: number,
  endpoint: NeighborsEndpoint,
  options?: { timeoutMs?: number }
): Promise<NeighborsBatchResponse> {
  if (ids.length === 0) {
    throw new NeighborsClientError(`${endpoint.label} requires at least 1 id.`, 400);
  }
  if (ids.length > SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP) {
    throw new NeighborsClientError(
      `${endpoint.label} exceeded the cap of ${SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP} ids (received ${ids.length}).`,
      400
    );
  }

  const timeoutMs = options?.timeoutMs ?? ids.length * PER_ID_TIMEOUT_MS + TIMEOUT_SLACK_MS;
  // heat is deliberately omitted — the server default (0.5) is the production blend.
  const body = JSON.stringify({ [endpoint.bodyKey]: ids, limit });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The timer is cleared only AFTER the body is read (not right after headers
  // arrive), so a stalled body stream is aborted by the same timeout as the
  // request — the whole call is bounded by `timeoutMs`.
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl()}${endpoint.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new NeighborsClientError(`${endpoint.label}: request failed (${reason}).`);
    }

    if (!response.ok) {
      throw new NeighborsClientError(
        `${endpoint.label}: semantic-index returned HTTP ${response.status}.`,
        response.status
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new NeighborsClientError(`${endpoint.label}: unparseable body (${reason}).`, 502);
    }

    const results = (parsed as { results?: unknown } | null)?.results;
    if (results === null || typeof results !== 'object' || Array.isArray(results)) {
      throw new NeighborsClientError(`${endpoint.label}: response \`results\` is not an object.`, 502);
    }

    // Narrow each verdict to exactly `{ artist_id, weight }` — the leak barrier
    // for jsonb sub-objects. The projected column is persisted verbatim and
    // re-emitted on `Concert.similar_artists`, so any extra per-neighbor field a
    // future endpoint adds would silently violate the api.yaml `SimilarArtist`
    // contract. Drop malformed elements (non-numeric id/weight) rather than
    // store garbage. A NON-array value for an id is DROPPED from the sanitized
    // map so the orchestrator routes that id as a malformed verdict (skip +
    // retry), never as an observed-empty (which would delete a healthy row).
    // Built via `Object.fromEntries` (not a computed-key assignment) to avoid a
    // dynamic object-injection sink on the response-controlled keys.
    const sanitized = Object.fromEntries(
      Object.entries(results as Record<string, unknown>)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, (value as unknown[]).filter(isSimilarArtistNeighbor).map(pickNeighborFields)])
    ) as Record<string, SimilarArtistNeighbor[]>;

    // `source_plays` (semantic-index#369, BS#1702) is ADDITIVE: an un-deployed
    // endpoint omits it, so a missing / non-object value degrades to `{}` (the
    // station writer then writes nothing) rather than throwing. Keep only
    // stringified-id → non-negative-integer entries — same "validate, don't
    // trust the wire" discipline as the neighbor verdicts above. Built via
    // `Object.fromEntries` (not a computed-key assignment) to avoid a dynamic
    // object-injection sink on the response-controlled keys.
    const rawPlays = (parsed as { source_plays?: unknown } | null)?.source_plays;
    const sourcePlays =
      rawPlays !== null && typeof rawPlays === 'object' && !Array.isArray(rawPlays)
        ? (Object.fromEntries(
            Object.entries(rawPlays as Record<string, unknown>).filter(([, value]) => isPlayCount(value))
          ) as Record<string, number>)
        : {};

    return { results: sanitized, source_plays: sourcePlays };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch top-K affinity neighbors for a batch of LIBRARY artist ids
 * (semantic-index#354 — the in-library lane).
 *
 * @param libraryArtistIds - `artists.id` values (1..=`SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP`).
 * @param limit - top-K per input id (K=20 in production).
 * @param options.timeoutMs - override the batch-scaled socket timeout.
 */
export function fetchNeighborsBatch(
  libraryArtistIds: number[],
  limit: number,
  options?: { timeoutMs?: number }
): Promise<NeighborsBatchResponse> {
  return fetchNeighborsBatchImpl(libraryArtistIds, limit, LIBRARY_ENDPOINT, options);
}

/**
 * Fetch top-K affinity neighbors for a batch of external DISCOGS artist ids
 * (semantic-index#367 — the Discogs-only touring-headliner lane, BS#1701). The
 * returned neighbors are still WXYC catalog artist ids (#367 reuses #354's
 * translate-drop-cut path), so the sanitized `{ artist_id, weight }` verdicts
 * are persisted and re-emitted with zero field mapping, exactly like the library
 * lane.
 *
 * @param discogsArtistIds - external Discogs artist ids (1..=`SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP`).
 * @param limit - top-K per input id (K=20 in production).
 * @param options.timeoutMs - override the batch-scaled socket timeout.
 */
export function fetchDiscogsNeighborsBatch(
  discogsArtistIds: number[],
  limit: number,
  options?: { timeoutMs?: number }
): Promise<NeighborsBatchResponse> {
  return fetchNeighborsBatchImpl(discogsArtistIds, limit, DISCOGS_ENDPOINT, options);
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
