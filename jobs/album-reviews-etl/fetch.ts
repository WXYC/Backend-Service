/**
 * Google Sheets client for album-reviews-etl: REST v4
 * `GET /v4/spreadsheets/{id}/values/{range}` (FORMATTED_VALUE,
 * majorDimension=ROWS), authed by a service-account JWT via
 * `google-auth-library` (scope `spreadsheets.readonly`) — the repo's first
 * Google dependency; the full `googleapis` meta-package is deliberately
 * avoided.
 *
 * Env (all fail-fast — a cron run without its source config must exit
 * non-zero, not no-op):
 *   - `ALBUM_REVIEWS_SHEET_ID` (required) — the spreadsheet id.
 *   - `ALBUM_REVIEWS_SHEET_RANGE` (default 'Form Responses 1') — the tab
 *     the form writes to; a bare sheet name reads the whole tab.
 *   - `GOOGLE_SERVICE_ACCOUNT_JSON_B64` (required) — base64 of the SA key
 *     JSON, so the multi-line key survives the single-line `KEY=VALUE`
 *     constraint of the EC2 `.env` and the set-ec2-env-var workflow.
 *
 * The values API right-trims trailing empty cells from every row, so rows
 * are RAGGED; `padRows` right-pads them to the widest row so map.ts's
 * header-resolved indexes never read past a row's end.
 *
 * Transient upstream 5xx/429s (Google's canonical "service is currently
 * unavailable" 503, from EITHER the OAuth token mint or the values GET —
 * both legs run inside the single `client.request` call) are absorbed by a
 * small bounded retry with jittered exponential backoff (`withSheetRetry`,
 * wired in job.ts). Deterministic 4xx config errors (401/403 bad
 * credentials, 404 wrong sheet id) are NOT retried — they are config
 * regressions that must stay loud, per the fail-fast contract above.
 */

import { JWT } from 'google-auth-library';
import { log } from './logger.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export const resolveSheetId = (raw: string | undefined = process.env.ALBUM_REVIEWS_SHEET_ID): string => {
  if (!raw) {
    throw new Error('ALBUM_REVIEWS_SHEET_ID is required (the "Album Review Responses" spreadsheet id)');
  }
  return raw;
};

export const resolveSheetRange = (raw: string | undefined = process.env.ALBUM_REVIEWS_SHEET_RANGE): string =>
  raw || 'Form Responses 1';

export type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

export const resolveServiceAccountCredentials = (
  raw: string | undefined = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64
): ServiceAccountCredentials => {
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_B64 is required (base64 of the service-account key JSON)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch (error) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON_B64 did not decode to JSON (${(error as Error).message}) — ` +
        `expected base64 of the downloaded service-account key file`,
      { cause: error }
    );
  }
  const creds = parsed as Partial<ServiceAccountCredentials>;
  if (typeof creds.client_email !== 'string' || creds.client_email === '') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_B64 decoded JSON is missing client_email');
  }
  if (typeof creds.private_key !== 'string' || creds.private_key === '') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_B64 decoded JSON is missing private_key');
  }
  return { client_email: creds.client_email, private_key: creds.private_key };
};

export type SheetValuesResponse = { values?: unknown[][] };
export type SheetRequestFn = (url: string) => Promise<SheetValuesResponse>;

/** Authed GET returning the response body; `google-auth-library`'s JWT
 *  client mints + caches the bearer token per instance. */
export const createSheetsRequest = (creds: ServiceAccountCredentials): SheetRequestFn => {
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [SHEETS_SCOPE],
  });
  return async (url: string): Promise<SheetValuesResponse> => {
    const response = await client.request<SheetValuesResponse>({ url });
    return response.data;
  };
};

/** A transient upstream status is retryable; a deterministic 4xx is not.
 *  408 (request timeout) + 429 (rate limit) + any 5xx — the same idempotent
 *  set gaxios retries by default, narrowed to what we actually expect from
 *  the Sheets values GET and the token endpoint. */
export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

/** Extract the HTTP status from a thrown error. GaxiosError (google-auth's
 *  transport) exposes `.status` in v7 and `.response.status` historically;
 *  read both. Returns undefined for errors with no HTTP status (env/cred
 *  Errors, transport failures with no response) — those never retry. */
export const extractStatus = (error: unknown): number | undefined => {
  if (error && typeof error === 'object') {
    const e = error as { status?: unknown; response?: { status?: unknown } };
    if (typeof e.status === 'number') return e.status;
    if (e.response && typeof e.response === 'object' && typeof e.response.status === 'number') {
      return e.response.status;
    }
  }
  return undefined;
};

export type RetryOptions = {
  /** Retries AFTER the first attempt (default 3 → up to 4 total tries). */
  retries?: number;
  /** Base backoff; delay for retry i is base * 2^i + jitter (default 250ms). */
  baseDelayMs?: number;
  /** Per-attempt backoff ceiling before jitter (default 4000ms). */
  maxDelayMs?: number;
  /** Injectable for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1) (default Math.random). */
  random?: () => number;
};

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wrap a `SheetRequestFn` in a bounded retry: transient 5xx/429 responses
 *  (from either the token mint or the values GET, both inside `request`)
 *  are retried with jittered exponential backoff; deterministic 4xx and
 *  non-HTTP errors propagate on the first attempt. Each retry is
 *  warn-logged so a flaky-but-recovering night is visible in container
 *  logs without a Sentry alert. Total added latency is bounded (a few
 *  seconds), well within the cron slot. */
export const withSheetRetry = (request: SheetRequestFn, options: RetryOptions = {}): SheetRequestFn => {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  return async (url: string): Promise<SheetValuesResponse> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(url);
      } catch (error) {
        const status = extractStatus(error);
        if (status === undefined || !isRetryableStatus(status) || attempt >= retries) {
          throw error;
        }
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const delay = backoff + Math.floor(random() * baseDelayMs);
        log(
          'warn',
          'fetch_retry',
          `Sheets fetch attempt ${attempt + 1} failed with status ${status}; retrying in ${delay}ms`,
          {
            attempt: attempt + 1,
            max_attempts: retries + 1,
            status,
            delay_ms: delay,
            error_message: error instanceof Error ? error.message : String(error),
          }
        );
        await sleep(delay);
      }
    }
  };
};

/** Right-pad every row to the widest row's length, coercing cells to
 *  strings (FORMATTED_VALUE emits strings, but the feed is untrusted). */
export const padRows = (rows: unknown[][]): string[][] => {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) =>
    Array.from({ length: width }, (_, i) => {
      const cell = row[i];
      if (typeof cell === 'string') return cell;
      // FORMATTED_VALUE emits strings, but the feed is untrusted: keep
      // scalar coercions, drop anything object-shaped to empty.
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
      return '';
    })
  );
};

/** Fetch the tab's rows (header row included), padded rectangular. */
export const fetchSheetRows = async (sheetId: string, range: string, request: SheetRequestFn): Promise<string[][]> => {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const body = await request(url);
  return padRows(body.values ?? []);
};
