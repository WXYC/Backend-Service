/**
 * HTTP client for the triangle-shows `/api/v1` surface. Base URL from
 * `TRIANGLE_SHOWS_URL` (see docs/env-vars.md); the job fails fast at
 * startup when unset.
 *
 * The events pull is a FULL SNAPSHOT every run — `dedup=false` (every
 * stored row, not the calendar's cross-venue-collapsed view),
 * `include_removed=true` (tombstones), and a back-dated `start`
 * (`map.ts:backdatedStart` — the default start=today window hides a
 * tombstone stamped on the event's own show date, and source rows
 * hard-delete 7 days past their date). No `updated_since`: idempotent by
 * construction, and the whole corpus is a few thousand rows.
 *
 * Each GET retries once after a delay on TRANSIENT failures (network
 * errors, timeouts, 5xx): the source host can cold-start at the 05:05 UTC
 * pull (it last scraped 18:00 ET), and a single transient failure must
 * degrade to "resolution deferred one night" — the README's documented
 * soft edge — not "no mirror tonight". Deterministic 4xx (bad path,
 * rejected param) fails immediately: replaying it can't succeed and the
 * retry wrapper would misread as transience. Failures include a slice of
 * the response body so FastAPI's self-describing 422 `detail` reaches the
 * log instead of an opaque status line.
 */

import type { TsEvent, TsHealth, TsVenue } from './types.js';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 15_000;
const ERROR_BODY_SLICE = 300;

export const resolveBaseUrl = (raw: string | undefined = process.env.TRIANGLE_SHOWS_URL): string => {
  if (!raw) {
    throw new Error('TRIANGLE_SHOWS_URL is required (base URL of the triangle-shows API, no trailing slash)');
  }
  return raw.replace(/\/+$/, '');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Non-2xx responses throw with the status attached so the retry layer
 *  can tell deterministic client errors from transient server trouble. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const getJsonOnce = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(
      `GET ${url} -> ${response.status} ${response.statusText}` +
        (body ? ` — body: ${body.slice(0, ERROR_BODY_SLICE)}` : ''),
      response.status
    );
  }
  return (await response.json()) as T;
};

/** A 4xx is deterministic (bad path, rejected param, auth) — replaying it
 *  cannot succeed and only delays the failure; retry covers the transient
 *  classes: network errors, timeouts, and 5xx. */
const isRetryable = (error: unknown): boolean => !(error instanceof HttpError) || error.status >= 500;

/** Exported for tests; production callers use the default delay. */
export const getJsonWithRetry = async <T>(url: string, retryDelayMs = RETRY_DELAY_MS): Promise<T> => {
  try {
    return await getJsonOnce<T>(url);
  } catch (firstError) {
    if (!isRetryable(firstError)) throw firstError;
    await sleep(retryDelayMs);
    try {
      return await getJsonOnce<T>(url);
    } catch (secondError) {
      // Surface the terminal error but keep the first attempt's story —
      // "timeout then 200" vs "503 twice" triage very differently.
      throw new Error(
        `${(secondError as Error).message} (retry after ${retryDelayMs}ms; first attempt: ${(firstError as Error).message})`,
        { cause: secondError }
      );
    }
  }
};

export const fetchEvents = async (baseUrl: string, start: string): Promise<TsEvent[]> =>
  getJsonWithRetry<TsEvent[]>(`${baseUrl}/api/v1/events?dedup=false&include_removed=true&start=${start}`);

export const fetchVenues = async (baseUrl: string): Promise<TsVenue[]> =>
  getJsonWithRetry<TsVenue[]>(`${baseUrl}/api/v1/venues`);

export const fetchHealth = async (baseUrl: string): Promise<TsHealth> =>
  getJsonWithRetry<TsHealth>(`${baseUrl}/api/v1/health`);
