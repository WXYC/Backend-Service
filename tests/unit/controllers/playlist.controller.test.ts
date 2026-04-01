/**
 * Unit tests for the playlist controller.
 *
 * The playlist proxy service is mocked; tests verify the HTTP handler
 * correctly reads query params, sets headers, and delegates to the service.
 */
import { jest } from '@jest/globals';
import type { Request, Response } from 'express';

// --- Mocks ---

const mockGetRecentEntries = jest.fn();
const mockIsConnected = jest.fn();

jest.mock('../../../apps/backend/services/playlist-proxy.service', () => ({
  getRecentEntries: (...args: unknown[]) => mockGetRecentEntries(...args),
  isConnected: () => mockIsConnected(),
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

// --- Fixture data: representative WXYC entries ---

const sampleResponse = {
  playcuts: [
    {
      id: 2602249,
      chronOrderID: 171606010,
      hour: 1775080800000,
      timeCreated: 1775082908948,
      songTitle: 'I Shall Be Released',
      artistName: 'Nina Simone',
      releaseTitle: 'Best of',
      labelName: 'BMG',
      request: 'false',
      rotation: 'false',
      artworkURL: 'https://i.discogs.com/nina.jpg',
    },
    {
      id: 2602250,
      chronOrderID: 171606011,
      hour: 1775080800000,
      timeCreated: 1775082999000,
      songTitle: 'la paradoja',
      artistName: 'Juana Molina',
      releaseTitle: 'DOGA',
      labelName: 'Sonamos',
      request: 'false',
      rotation: 'false',
    },
  ],
  talksets: [
    {
      id: 2602247,
      chronOrderID: 171606008,
      hour: 1775080800000,
      timeCreated: 1775082820391,
    },
  ],
  breakpoints: [
    {
      id: 2602238,
      chronOrderID: 171605047,
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
    it('returns enriched playcuts with artworkURL', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2', n: '50' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.playcuts[0].artworkURL).toBe('https://i.discogs.com/nina.jpg');
      expect(body.playcuts[1].artworkURL).toBeUndefined();
    });

    it('sets Cache-Control: public, max-age=30', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=30');
    });

    it('passes n param to service (slices entries)', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2', n: '5' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(mockGetRecentEntries).toHaveBeenCalledWith(5);
    });

    it('defaults n to 50 when not provided', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(mockGetRecentEntries).toHaveBeenCalledWith(50);
    });

    it('clamps n to 100 when n exceeds maximum', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2', n: '500' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(mockGetRecentEntries).toHaveBeenCalledWith(100);
    });

    it('clamps n to 1 when n is zero or negative', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2', n: '0' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(mockGetRecentEntries).toHaveBeenCalledWith(1);
    });

    it('returns 503 when SSE not yet connected', () => {
      mockIsConnected.mockReturnValue(false);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ message: 'Playlist data not yet available' });
    });

    it('preserves talksets and breakpoints unchanged', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.talksets).toEqual(sampleResponse.talksets);
      expect(body.breakpoints).toEqual(sampleResponse.breakpoints);
    });

    it('handles non-numeric n param gracefully (defaults to 50)', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetRecentEntries.mockReturnValue(sampleResponse);

      const req = { query: { v: '2', n: 'abc' } } as unknown as Request;
      const res = createMockRes();

      getRecentEntries(req, res as Response, jest.fn());

      expect(mockGetRecentEntries).toHaveBeenCalledWith(50);
    });
  });
});
