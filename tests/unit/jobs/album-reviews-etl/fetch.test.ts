/**
 * Unit tests for the album-reviews-etl Google Sheets client: fail-fast env
 * resolvers (sheet id + base64 service-account JSON required; range
 * defaulted), ragged-row right-padding (the values API right-trims
 * trailing empty cells), and the values.get URL contract
 * (FORMATTED_VALUE, majorDimension=ROWS, encoded range). Service-account
 * auth is mocked — no google endpoint is ever hit.
 */
import {
  resolveSheetId,
  resolveSheetRange,
  resolveServiceAccountCredentials,
  padRows,
  fetchSheetRows,
  createSheetsRequest,
} from '../../../../jobs/album-reviews-etl/fetch';

const jwtInstances: Array<Record<string, unknown>> = [];
const mockRequest = jest.fn();

jest.mock('google-auth-library', () => ({
  JWT: class {
    constructor(options: Record<string, unknown>) {
      jwtInstances.push(options);
    }
    request = mockRequest;
  },
}));

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'album-reviews@wxyc-etl.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n',
});
const SA_B64 = Buffer.from(SA_JSON, 'utf-8').toString('base64');

describe('env resolvers (fail-fast)', () => {
  it('resolveSheetId throws when unset and passes a value through', () => {
    expect(() => resolveSheetId(undefined)).toThrow(/ALBUM_REVIEWS_SHEET_ID/);
    expect(resolveSheetId('1AbCsheetId')).toBe('1AbCsheetId');
  });

  it("resolveSheetRange defaults to 'Form Responses 1' and honors an override", () => {
    expect(resolveSheetRange(undefined)).toBe('Form Responses 1');
    expect(resolveSheetRange('Form Responses 2')).toBe('Form Responses 2');
  });

  it('resolveServiceAccountCredentials throws when unset', () => {
    expect(() => resolveServiceAccountCredentials(undefined)).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON_B64/);
  });

  it('resolveServiceAccountCredentials throws on non-base64 / non-JSON input', () => {
    expect(() => resolveServiceAccountCredentials('%%%not-base64%%%')).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON_B64/);
    expect(() => resolveServiceAccountCredentials(Buffer.from('not json').toString('base64'))).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON_B64/
    );
  });

  it.each([['client_email'], ['private_key']])(
    'resolveServiceAccountCredentials throws when %s is missing from the decoded key JSON',
    (field) => {
      const incomplete = JSON.parse(SA_JSON) as Record<string, unknown>;
      delete incomplete[field];
      const b64 = Buffer.from(JSON.stringify(incomplete), 'utf-8').toString('base64');
      expect(() => resolveServiceAccountCredentials(b64)).toThrow(new RegExp(field));
    }
  );

  it('resolveServiceAccountCredentials decodes a valid base64 SA key', () => {
    const creds = resolveServiceAccountCredentials(SA_B64);
    expect(creds.client_email).toBe('album-reviews@wxyc-etl.iam.gserviceaccount.com');
    expect(creds.private_key).toMatch(/BEGIN PRIVATE KEY/);
  });
});

describe('padRows (ragged rows)', () => {
  it('right-pads short rows to the widest row so header-based indexes never read undefined', () => {
    const padded = padRows([
      ['Timestamp', 'Artist Name', 'Album Name', 'Buzzwords'],
      ['7/15/2021 14:05:33', 'Juana Molina'], // API right-trimmed the trailing empties
      [],
    ]);
    expect(padded).toEqual([
      ['Timestamp', 'Artist Name', 'Album Name', 'Buzzwords'],
      ['7/15/2021 14:05:33', 'Juana Molina', '', ''],
      ['', '', '', ''],
    ]);
  });

  it('coerces non-string cells to strings and null/undefined to empty', () => {
    const padded = padRows([[122, null, 'x'], [true]]);
    expect(padded).toEqual([
      ['122', '', 'x'],
      ['true', '', ''],
    ]);
  });

  it('returns [] for an empty response', () => {
    expect(padRows([])).toEqual([]);
  });
});

describe('fetchSheetRows', () => {
  it('GETs the values.get URL with FORMATTED_VALUE + majorDimension=ROWS and the range URL-encoded', async () => {
    const request = jest.fn().mockResolvedValue({ values: [['Timestamp'], ['7/15/2021 14:05:33']] });
    await fetchSheetRows('1AbCsheetId', 'Form Responses 1', request);

    expect(request).toHaveBeenCalledTimes(1);
    const url = request.mock.calls[0][0] as string;
    expect(url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/1AbCsheetId/values/Form%20Responses%201' +
        '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE'
    );
  });

  it('returns the padded rows', async () => {
    const request = jest.fn().mockResolvedValue({
      values: [
        ['Timestamp', 'Artist Name', 'Album Name'],
        ['7/15/2021 14:05:33', 'Jessica Pratt'],
      ],
    });
    await expect(fetchSheetRows('id', 'r', request)).resolves.toEqual([
      ['Timestamp', 'Artist Name', 'Album Name'],
      ['7/15/2021 14:05:33', 'Jessica Pratt', ''],
    ]);
  });

  it('returns [] when the API omits values entirely (empty tab)', async () => {
    const request = jest.fn().mockResolvedValue({});
    await expect(fetchSheetRows('id', 'r', request)).resolves.toEqual([]);
  });
});

describe('createSheetsRequest (SA auth, mocked)', () => {
  beforeEach(() => {
    jwtInstances.length = 0;
    mockRequest.mockReset();
  });

  it('builds a JWT client with the SA email/key and the spreadsheets.readonly scope', () => {
    createSheetsRequest(resolveServiceAccountCredentials(SA_B64));
    expect(jwtInstances).toHaveLength(1);
    expect(jwtInstances[0]).toMatchObject({
      email: 'album-reviews@wxyc-etl.iam.gserviceaccount.com',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    expect(jwtInstances[0].key).toMatch(/BEGIN PRIVATE KEY/);
  });

  it('unwraps response.data from the authed request', async () => {
    mockRequest.mockResolvedValue({ data: { values: [['x']] } });
    const request = createSheetsRequest(resolveServiceAccountCredentials(SA_B64));
    await expect(request('https://sheets.googleapis.com/whatever')).resolves.toEqual({ values: [['x']] });
    expect(mockRequest).toHaveBeenCalledWith({ url: 'https://sheets.googleapis.com/whatever' });
  });
});
