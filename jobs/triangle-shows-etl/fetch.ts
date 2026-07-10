/**
 * HTTP pull for triangle-shows-etl: URL construction + a thin fetch-JSON
 * wrapper. The events query string is contract, not plumbing — it's the
 * mirror-consumer recipe shipped by triangle-shows Phase 0
 * (`include_removed=true&dedup=false` + an explicit back-dated `start`).
 */
import { nyCalendarDate } from '@wxyc/database';

// Relative (no leading slash) + resolveAgainst's trailing-slash
// normalization, so a path-prefixed base URL (reverse-proxy subpath
// deploy) keeps its prefix — new URL('/abs', base) would silently resolve
// against the origin and 404 every pull.
const EVENTS_PATH = 'api/v1/events';
const VENUES_PATH = 'api/v1/venues';
const HEALTH_PATH = 'api/v1/health';

const resolveAgainst = (baseUrl: string, path: string): URL =>
  new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

/** How far the events window reaches back. The source stamps a tombstone
 *  as late as the event's own show date and hard-deletes rows 7 days past
 *  their date; 8 days guarantees every observable tombstone is inside the
 *  window (the default start=today would hide show-day tombstones). */
const START_DAYS_BACK = 8;

/**
 * The Eastern calendar date `daysBack` days before `now`. Anchored on the
 * America/New_York date first (a 03:30Z run moment is still "yesterday"
 * in the Triangle), then day-arithmetic on a UTC-noon anchor so DST
 * transitions can't skew the subtraction.
 */
export const backdatedStart = (now: Date, daysBack: number = START_DAYS_BACK): string => {
  const easternToday = nyCalendarDate(now);
  const anchor = new Date(`${easternToday}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - daysBack);
  return anchor.toISOString().slice(0, 10);
};

export const buildEventsUrl = (baseUrl: string, now: Date): string => {
  const url = resolveAgainst(baseUrl, EVENTS_PATH);
  url.searchParams.set('dedup', 'false');
  url.searchParams.set('include_removed', 'true');
  url.searchParams.set('start', backdatedStart(now));
  return url.toString();
};

export const buildVenuesUrl = (baseUrl: string): string => resolveAgainst(baseUrl, VENUES_PATH).toString();

export const buildHealthUrl = (baseUrl: string): string => resolveAgainst(baseUrl, HEALTH_PATH).toString();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a JSON resource with a hard timeout; non-2xx is an error.
 *
 * Retries ONCE on a 5xx or timeout after a short backoff — the source is
 * a Railway-hosted service that can 502 briefly on a cold start at the
 * 05:05 UTC pull (same convention as rhp-fetch.ts's fetchHtml). Never
 * retries a 4xx: the URL is wrong, retrying doesn't help.
 */
export const fetchJson = async <T>(url: string, timeoutMs = 60_000, retryBackoffMs = 2_000): Promise<T> => {
  const attemptOnce = async (): Promise<Response> =>
    fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });

  let response: Response | null = null;
  try {
    response = await attemptOnce();
  } catch {
    // Timeout / network error — fall through to the single retry below.
  }
  if (response === null || response.status >= 500) {
    if (retryBackoffMs > 0) await sleep(retryBackoffMs);
    response = await attemptOnce(); // A second throw propagates to the caller.
  }
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`);
  }
  return (await response.json()) as T;
};
