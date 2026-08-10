import { Request, Response } from 'express';

/**
 * BS#2062 — `GET /flowsheet/range?start=&end=`.
 *
 * The public, date-windowed flowsheet read that replaces tubafrenzy's
 * `GET /playlists/dailyEntries` at the turndown. Contract lives in
 * `wxyc-shared/api.yaml` (`/flowsheet/range`, merged in wxyc-shared#331); the
 * cases below are its stated 400 conditions plus the window/ordering
 * semantics it pins.
 */

const getEntriesInTimeWindow = jest.fn();
const getShowsInTimeWindow = jest.fn();
const transformToV2 = jest.fn();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getEntriesInTimeWindow: (...args: unknown[]) => getEntriesInTimeWindow(...args),
  getShowsInTimeWindow: (...args: unknown[]) => getShowsInTimeWindow(...args),
  transformToV2: (...args: unknown[]) => transformToV2(...args),
}));

import { getEntriesInRange, MAX_RANGE_MS } from '../../../apps/backend/controllers/flowsheet.controller';

const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-06-01T04:00:00Z — midnight ET on a summer (EDT) date.
const MIDNIGHT_ET = Date.UTC(2026, 5, 1, 4, 0, 0);

beforeEach(() => {
  getEntriesInTimeWindow.mockReset();
  getShowsInTimeWindow.mockReset();
  transformToV2.mockReset();
  getEntriesInTimeWindow.mockResolvedValue([]);
  getShowsInTimeWindow.mockResolvedValue([]);
  transformToV2.mockImplementation((entry: { id: number }) => ({ id: entry.id, projected: true }));
});

const makeRes = () => {
  const res = {} as Response & { _status: number; _body: unknown };
  res.status = jest.fn(function (this: typeof res, code: number) {
    this._status = code;
    return this;
  });
  res.json = jest.fn(function (this: typeof res, body: unknown) {
    this._body = body;
    return this;
  });
  return res;
};

const invoke = async (query: Record<string, string | string[] | undefined>) => {
  const req = { query } as unknown as Request;
  const res = makeRes();
  const next = jest.fn();
  await getEntriesInRange(req, res, next);
  return { res, next };
};

describe('getEntriesInRange — parameter validation', () => {
  it.each([
    ['both missing', {}],
    ['start missing', { end: String(MIDNIGHT_ET + DAY_MS) }],
    ['end missing', { start: String(MIDNIGHT_ET) }],
  ])('400s when %s', async (_label, query) => {
    const { res } = await invoke(query);
    expect(res._status).toBe(400);
    expect(getEntriesInTimeWindow).not.toHaveBeenCalled();
  });

  it.each([
    ['non-numeric', 'yesterday'],
    ['empty string', ''],
    ['a float', '1780000000000.5'],
    ['scientific notation with a fractional value', '1.5e0'],
    ['beyond the representable Date range', '9000000000000000'],
  ])('400s on a %s start', async (_label, start) => {
    const { res } = await invoke({ start, end: String(MIDNIGHT_ET + DAY_MS) });
    expect(res._status).toBe(400);
    expect(getEntriesInTimeWindow).not.toHaveBeenCalled();
  });

  it('400s when end equals start (the window is half-open, so this is empty by construction)', async () => {
    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET) });
    expect(res._status).toBe(400);
  });

  it('400s when end precedes start', async () => {
    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET - 1) });
    expect(res._status).toBe(400);
  });

  it('400s on a window wider than the 8-day ceiling', async () => {
    const { res } = await invoke({
      start: String(MIDNIGHT_ET),
      end: String(MIDNIGHT_ET + MAX_RANGE_MS + 1),
    });
    expect(res._status).toBe(400);
    expect(getEntriesInTimeWindow).not.toHaveBeenCalled();
  });

  it('accepts a window exactly at the ceiling', async () => {
    const { res } = await invoke({
      start: String(MIDNIGHT_ET),
      end: String(MIDNIGHT_ET + MAX_RANGE_MS),
    });
    expect(res._status).toBe(200);
  });

  it('sets the ceiling above a DST-spanning week', () => {
    // A 7-day window across the autumn transition is 7d + 1h. The ceiling is
    // deliberately 8d rather than exactly 7d so that request does not 400.
    expect(MAX_RANGE_MS).toBeGreaterThan(7 * DAY_MS + 60 * 60 * 1000);
  });

  it('every 400 carries a message body', async () => {
    const { res } = await invoke({ start: 'nope', end: 'nope' });
    expect(res._body).toEqual(expect.objectContaining({ message: expect.any(String) }));
  });

  // Express 5's default ('simple') query parser yields an ARRAY for a repeated
  // key, so `req.query.start` is not always a string despite the handler's
  // declared type. Calling a string method on it throws synchronously, and an
  // async handler's throw becomes a rejected promise that Express forwards to
  // `errorHandler` — a 500 plus one Sentry capture, on an unauthenticated and
  // unratelimited route. `searchFlowsheetEndpoint`, the sibling public read,
  // escapes this only because `parseInt` coerces an array instead of throwing.
  it.each([
    ['a repeated start', { start: ['1', '2'], end: String(MIDNIGHT_ET + DAY_MS) }],
    ['a repeated end', { start: String(MIDNIGHT_ET), end: ['1', '2'] }],
    ['both repeated', { start: ['1', '2'], end: ['3', '4'] }],
  ])('400s rather than throwing on %s', async (_label, query) => {
    const { res, next } = await invoke(query);
    expect(res._status).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(getEntriesInTimeWindow).not.toHaveBeenCalled();
  });

  // The guard has to bound the POSTGRES timestamptz range, not the JS Date
  // range: `new Date(8.64e15).toISOString()` is '+275760-09-13T00:00:00.000Z',
  // an expanded-year form Postgres cannot parse. Drizzle's timestamp mapper is
  // `value.toISOString()`, so such a value reaches the driver verbatim and the
  // query throws — another 500 on a public route. Year 9999 ends at 2.53e14.
  it.each([
    ['just past the far future', 253402300800000],
    ['the JS Date maximum', 8640000000000000],
    ['the JS Date minimum', -8640000000000000],
    ['before year 1', -62167219200000 - 86400000],
  ])('400s on an epoch outside the storable range (%s)', async (_label, start) => {
    const { res, next } = await invoke({ start: String(start), end: String(start + 1000) });
    expect(res._status).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(getEntriesInTimeWindow).not.toHaveBeenCalled();
  });

  it('accepts an epoch at the edges of the storable range', async () => {
    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET + DAY_MS) });
    expect(res._status).toBe(200);
  });

  // `Number()` is deliberately used over `parseInt` (the docstring explains
  // why), but it accepts more than the docstring's "plain integer": radix
  // prefixes and surrounding whitespace both parse to a finite integer and
  // would be served as a plausible-looking window instead of rejected.
  it.each([
    ['hex', '0x1E240'],
    ['binary', '0b101'],
    ['octal', '0o17'],
    ['leading/trailing whitespace', '  1780000000000  '],
    ['a positive sign', '+1780000000000'],
    ['integral scientific notation', '1e12'],
    ['Infinity', 'Infinity'],
  ])('400s on a %s start', async (_label, start) => {
    const { res } = await invoke({ start, end: String(MIDNIGHT_ET + DAY_MS) });
    expect(res._status).toBe(400);
    expect(getEntriesInTimeWindow).not.toHaveBeenCalled();
  });

  it('still accepts a negative epoch (pre-1970 flowsheet history is in range)', async () => {
    const start = Date.UTC(1969, 0, 1);
    const { res } = await invoke({ start: String(start), end: String(start + DAY_MS) });
    expect(res._status).toBe(200);
  });
});

describe('getEntriesInRange — window semantics', () => {
  it('passes a half-open [start, end) window as Dates to the service', async () => {
    const end = MIDNIGHT_ET + DAY_MS;
    await invoke({ start: String(MIDNIGHT_ET), end: String(end) });

    expect(getEntriesInTimeWindow).toHaveBeenCalledWith(new Date(MIDNIGHT_ET), new Date(end));
    expect(getShowsInTimeWindow).toHaveBeenCalledWith(new Date(MIDNIGHT_ET), new Date(end));
  });

  it('serves a midnight-ET day boundary', async () => {
    await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET + DAY_MS) });
    const [start, end] = getEntriesInTimeWindow.mock.calls[0];
    expect(start.toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-02T04:00:00.000Z');
  });

  it('serves a Sunday→Saturday week boundary', async () => {
    // 2026-05-31 is a Sunday; midnight ET that day through the next Sunday.
    const weekStart = Date.UTC(2026, 4, 31, 4, 0, 0);
    const { res } = await invoke({ start: String(weekStart), end: String(weekStart + 7 * DAY_MS) });
    expect(res._status).toBe(200);
    const [start, end] = getEntriesInTimeWindow.mock.calls[0];
    expect(new Date(start).getUTCDay()).toBe(0);
    expect(end.getTime() - start.getTime()).toBe(7 * DAY_MS);
  });
});

describe('getEntriesInRange — response shape', () => {
  it('returns 200 with empty arrays for an empty window, never 404', async () => {
    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET + DAY_MS) });

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ shows: [], entries: [] });
  });

  it('projects entries through the same transform GET /flowsheet uses', async () => {
    // Field parity with GET /flowsheet is a contract requirement, not a
    // coincidence: iOS V2 decodes both with a single decoder (api.yaml
    // FlowsheetRangeEntry).
    getEntriesInTimeWindow.mockResolvedValue([{ id: 11 }, { id: 12 }]);

    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET + DAY_MS) });

    expect(transformToV2).toHaveBeenCalledTimes(2);
    expect(res._body).toEqual({
      shows: [],
      entries: [
        { id: 11, projected: true },
        { id: 12, projected: true },
      ],
    });
  });

  it('returns an entry whose show_id is null rather than dropping or crashing on it', async () => {
    // 20 of 2.6M rows are unattributed; Phase 0 decided against a backfill.
    transformToV2.mockImplementation((e: { id: number; show_id: number | null }) => ({
      id: e.id,
      show_id: e.show_id,
    }));
    getEntriesInTimeWindow.mockResolvedValue([{ id: 7, show_id: null }]);

    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET + DAY_MS) });

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ shows: [], entries: [{ id: 7, show_id: null }] });
  });

  it('passes shows through verbatim', async () => {
    const show = {
      id: 900,
      show_name: null,
      dj_name: 'DJ Chuquimamani',
      specialty_id: null,
      start_time: new Date(MIDNIGHT_ET),
      end_time: null,
    };
    getShowsInTimeWindow.mockResolvedValue([show]);

    const { res } = await invoke({ start: String(MIDNIGHT_ET), end: String(MIDNIGHT_ET + DAY_MS) });

    expect((res._body as { shows: unknown[] }).shows).toEqual([show]);
  });

  it('forwards a service failure to next() rather than answering 200', async () => {
    getEntriesInTimeWindow.mockRejectedValue(new Error('statement timeout'));

    const { res, next } = await invoke({
      start: String(MIDNIGHT_ET),
      end: String(MIDNIGHT_ET + DAY_MS),
    });

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res._status).not.toBe(200);
  });
});
