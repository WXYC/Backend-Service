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
 */

import { JWT } from 'google-auth-library';

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
        `expected base64 of the downloaded service-account key file`
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

/** Right-pad every row to the widest row's length, coercing cells to
 *  strings (FORMATTED_VALUE emits strings, but the feed is untrusted). */
export const padRows = (rows: unknown[][]): string[][] => {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) =>
    Array.from({ length: width }, (_, i) => {
      const cell = row[i];
      return cell === null || cell === undefined ? '' : String(cell);
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
