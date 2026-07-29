/**
 * Unit tests for the playlist controller.
 *
 * The playlist proxy service is mocked; tests verify the HTTP handler
 * correctly reads query params, routes v=1 (flat) vs v=2 (grouped), sets
 * headers (incl. X-Last-Modified, BS#1866), and delegates to the service.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88): `getRecentEntries`
 * is now async (a live Postgres query). A DB error is surfaced as a DIRECT
 * 503 response — never thrown through the error pipeline, whose Sentry filter
 * captures every >=500. This is an unauthenticated endpoint mobile clients
 * poll on a fixed interval, so a captured 503 would mean one Sentry event per
 * poll during a DB blip.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// --- Mocks ---

const mockGetGrouped = jest.fn();
const mockGetFlat = jest.fn();

jest.mock('../../../apps/backend/services/playlist-proxy.service', () => ({
  getRecentEntries: (...args: unknown[]) => mockGetGrouped(...args),
  getRecentEntriesFlat: (...args: unknown[]) => mockGetFlat(...args),
  // Real logic so header-value assertions are meaningful.
  lastModifiedFromTimestamps: (ts: number[]) => (ts.length > 0 ? Math.max(...ts) : 0),
}));

import { getRecentEntries } from '../../../apps/backend/controllers/playlist.controller';

// --- Helpers ---

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.set = jest.fn().mockReturnValue(res) as unknown as Response['set'];
  res.append = jest.fn().mockReturnValue(res) as unknown as Response['append'];
  return res;
};

const noopNext: NextFunction = jest.fn();

const setCalls = (res: Partial<Response>) => (res.set as jest.Mock).mock.calls as [string, string][];
const headerValue = (res: Partial<Response>, name: string) => setCalls(res).find(([k]) => k === name)?.[1];

// --- Fixture data: representative WXYC entries ---

const sampleGrouped = {
  playcuts: [
    {
      id: 2602250,
      chronOrderID: 2602250,
      hour: 1775080800000,
      timeCreated: 1775082908948,
      songTitle: 'Back, Baby',
      artistName: 'Jessica Pratt',
      releaseTitle: 'On Your Own Love Again',
      labelName: 'Drag City',
      request: 'false',
      rotation: 'false',
      artworkURL: 'https://i.discogs.com/jessica.jpg',
    },
    {
      id: 2602249,
      chronOrderID: 2602249,
      hour: 1775080800000,
      timeCreated: 1775082999000,
      songTitle: 'la paradoja',
      artistName: 'Juana Molina',
      releaseTitle: 'DOGA',
      labelName: 'Sonamos',
      request: 'false',
      rotation: 'true',
    },
  ],
  talksets: [{ id: 2602247, chronOrderID: 2602247, hour: 1775080800000, timeCreated: 1775082820391 }],
  breakpoints: [{ id: 2602238, chronOrderID: 2602238, hour: 1775077200000, timeCreated: 1775076979166 }],
};
// Max timeCreated across all grouped entries.
const GROUPED_MAX_TS = 1775082999000;

const sampleFlat = [
  {
    id: 2602250,
    chronOrderID: 2602250,
    hour: 1775080800000,
    timeCreated: 1775082908948,
    entryType: 'playcut',
    playcut: {
      artistName: 'Jessica Pratt',
      songTitle: 'Back, Baby',
      releaseTitle: 'On Your Own Love Again',
      labelName: 'Drag City',
      rotation: 'false',
      request: 'false',
      segue: 'false',
    },
  },
  { id: 2602247, chronOrderID: 2602247, hour: 1775080800000, timeCreated: 1775082820391, entryType: 'talkset' },
  {
    id: 2602238,
    chronOrderID: 2602238,
    hour: 1775077200000,
    timeCreated: 1775076979166,
    entryType: 'breakpoint',
    artistName: 'BREAKPOINT',
  },
];
const FLAT_MAX_TS = 1775082908948;

// --- Tests ---

describe('playlist.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGrouped.mockResolvedValue(sampleGrouped);
    mockGetFlat.mockResolvedValue(sampleFlat);
  });

  describe('v=2 grouped path (iOS)', () => {
    it('returns enriched playcuts with artworkURL', async () => {
      const req = { query: { v: '2', n: '50' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.playcuts[0].artworkURL).toBe('https://i.discogs.com/jessica.jpg');
      expect(body.playcuts[1].artworkURL).toBeUndefined();
      expect(mockGetFlat).not.toHaveBeenCalled();
    });

    it('sets Cache-Control, X-Last-Modified (max timeCreated), and Access-Control-Expose-Headers', async () => {
      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=30');
      expect(headerValue(res, 'X-Last-Modified')).toBe(String(GROUPED_MAX_TS));
      // Appended (not set) so the CORS-exposed X-Request-Id survives.
      expect(res.append).toHaveBeenCalledWith('Access-Control-Expose-Headers', 'X-Last-Modified');
    });

    it('passes n to the grouped service; defaults to 50; clamps [1, 100]', async () => {
      const cases: [string | undefined, number][] = [
        ['5', 5],
        [undefined, 50],
        ['500', 100],
        ['0', 1],
        ['abc', 50],
      ];
      for (const [n, expected] of cases) {
        jest.clearAllMocks();
        mockGetGrouped.mockResolvedValue(sampleGrouped);
        const req = { query: n === undefined ? { v: '2' } : { v: '2', n } } as unknown as Request;
        await getRecentEntries(req, createMockRes() as Response, noopNext);
        expect(mockGetGrouped).toHaveBeenCalledWith(expected);
      }
    });

    it('preserves talksets and breakpoints unchanged', async () => {
      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.talksets).toEqual(sampleGrouped.talksets);
      expect(body.breakpoints).toEqual(sampleGrouped.breakpoints);
    });
  });

  describe('v=1 flat path (Android; default when v absent)', () => {
    it('routes to the flat service when v is absent (the Android contract)', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetFlat).toHaveBeenCalled();
      expect(mockGetGrouped).not.toHaveBeenCalled();
      expect((res.json as jest.Mock).mock.calls[0][0]).toBe(sampleFlat);
    });

    it('routes to the flat service for v=1', async () => {
      const req = { query: { v: '1' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetFlat).toHaveBeenCalled();
      expect(mockGetGrouped).not.toHaveBeenCalled();
    });

    it('defaults n to 200 and clamps [1, 200] (tubafrenzy total-entries semantic)', async () => {
      const cases: [string | undefined, number][] = [
        [undefined, 200],
        ['35', 35],
        ['999', 200],
        ['0', 1],
      ];
      for (const [n, expected] of cases) {
        jest.clearAllMocks();
        mockGetFlat.mockResolvedValue(sampleFlat);
        const req = { query: n === undefined ? {} : { n } } as unknown as Request;
        await getRecentEntries(req, createMockRes() as Response, noopNext);
        expect(mockGetFlat).toHaveBeenCalledWith(expected);
      }
    });

    it('sets X-Last-Modified from the flat window and Access-Control-Expose-Headers', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=30');
      expect(headerValue(res, 'X-Last-Modified')).toBe(String(FLAT_MAX_TS));
      expect(res.append).toHaveBeenCalledWith('Access-Control-Expose-Headers', 'X-Last-Modified');
    });
  });

  describe('DB failure', () => {
    it('returns a direct 503 (grouped) without setting headers or calling next', async () => {
      mockGetGrouped.mockRejectedValue(new Error('connection terminated'));
      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await expect(getRecentEntries(req, res as Response, noopNext)).resolves.toBeUndefined();

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ message: 'Playlist data temporarily unavailable' });
      expect(res.set).not.toHaveBeenCalled();
      expect(noopNext).not.toHaveBeenCalled();
    });

    it('returns a direct 503 (flat) without setting headers', async () => {
      mockGetFlat.mockRejectedValue(new Error('connection terminated'));
      const req = { query: {} } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.set).not.toHaveBeenCalled();
    });
  });
});
