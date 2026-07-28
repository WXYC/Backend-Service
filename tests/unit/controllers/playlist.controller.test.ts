/**
 * Unit tests for the playlist controller.
 *
 * The playlist proxy service is mocked; tests verify the HTTP handler
 * correctly reads query params, sets headers, and delegates to the service.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88): `getRecentEntries`
 * is now async (a live Postgres query, not an in-memory read), so the
 * controller awaits it and there is no more `isConnected()` SSE gate. A
 * DB error is surfaced as a DIRECT 503 response — never thrown through the
 * error pipeline, whose Sentry filter captures every >=500. This is an
 * unauthenticated endpoint mobile clients poll on a fixed interval, so a
 * captured 503 would mean one Sentry event per poll during a DB blip.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// --- Mocks ---

const mockGetRecentEntries = jest.fn();

jest.mock('../../../apps/backend/services/playlist-proxy.service', () => ({
  getRecentEntries: (...args: unknown[]) => mockGetRecentEntries(...args),
}));

import { getRecentEntries } from '../../../apps/backend/controllers/playlist.controller';

// --- Helpers ---

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.set = jest.fn().mockReturnValue(res) as unknown as Response['set'];
  return res;
};

const noopNext: NextFunction = jest.fn();

// --- Fixture data: representative WXYC entries ---

const sampleResponse = {
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
  talksets: [
    {
      id: 2602247,
      chronOrderID: 2602247,
      hour: 1775080800000,
      timeCreated: 1775082820391,
    },
  ],
  breakpoints: [
    {
      id: 2602238,
      chronOrderID: 2602238,
      hour: 1775077200000,
      timeCreated: 1775076979166,
    },
  ],
};

// --- Tests ---

describe('playlist.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getRecentEntries', () => {
    it('returns enriched playcuts with artworkURL', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2', n: '50' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.playcuts[0].artworkURL).toBe('https://i.discogs.com/jessica.jpg');
      expect(body.playcuts[1].artworkURL).toBeUndefined();
    });

    it('sets Cache-Control: public, max-age=30', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=30');
    });

    it('passes n param to service (slices entries)', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2', n: '5' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetRecentEntries).toHaveBeenCalledWith(5);
    });

    it('defaults n to 50 when not provided', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetRecentEntries).toHaveBeenCalledWith(50);
    });

    it('clamps n to 100 when n exceeds maximum', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2', n: '500' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetRecentEntries).toHaveBeenCalledWith(100);
    });

    it('clamps n to 1 when n is zero or negative', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2', n: '0' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetRecentEntries).toHaveBeenCalledWith(1);
    });

    it('returns a direct 503 when the service rejects (DB failure), without throwing into the error pipeline', async () => {
      mockGetRecentEntries.mockRejectedValue(new Error('connection terminated'));

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await expect(getRecentEntries(req, res as Response, noopNext)).resolves.toBeUndefined();

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ message: 'Playlist data temporarily unavailable' });
      expect(res.set).not.toHaveBeenCalled();
      expect(noopNext).not.toHaveBeenCalled();
    });

    it('preserves talksets and breakpoints unchanged', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.talksets).toEqual(sampleResponse.talksets);
      expect(body.breakpoints).toEqual(sampleResponse.breakpoints);
    });

    it('handles non-numeric n param gracefully (defaults to 50)', async () => {
      mockGetRecentEntries.mockResolvedValue(sampleResponse);

      const req = { query: { v: '2', n: 'abc' } } as unknown as Request;
      const res = createMockRes();

      await getRecentEntries(req, res as Response, noopNext);

      expect(mockGetRecentEntries).toHaveBeenCalledWith(50);
    });
  });
});
