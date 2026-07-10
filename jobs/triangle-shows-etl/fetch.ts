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
 */

import type { TsEvent, TsHealth, TsVenue } from './types.js';

const REQUEST_TIMEOUT_MS = 30_000;

export const resolveBaseUrl = (raw: string | undefined = process.env.TRIANGLE_SHOWS_URL): string => {
  if (!raw) {
    throw new Error('TRIANGLE_SHOWS_URL is required (base URL of the triangle-shows API, no trailing slash)');
  }
  return raw.replace(/\/+$/, '');
};

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
};

export const buildEventsUrl = (baseUrl: string, start: string): string =>
  `${baseUrl}/api/v1/events?dedup=false&include_removed=true&start=${start}`;

export const fetchEvents = async (baseUrl: string, start: string): Promise<TsEvent[]> =>
  getJson<TsEvent[]>(buildEventsUrl(baseUrl, start));

export const fetchVenues = async (baseUrl: string): Promise<TsVenue[]> =>
  getJson<TsVenue[]>(`${baseUrl}/api/v1/venues`);

export const fetchHealth = async (baseUrl: string): Promise<TsHealth> => getJson<TsHealth>(`${baseUrl}/api/v1/health`);
