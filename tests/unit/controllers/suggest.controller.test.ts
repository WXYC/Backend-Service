import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/suggest.service');

import * as suggestService from '../../../apps/backend/services/suggest.service';
import {
  suggestArtistsEndpoint,
  suggestTracksEndpoint,
  getTrackDetailsEndpoint,
} from '../../../apps/backend/controllers/suggest.controller';
import WxycError from '../../../apps/backend/utils/error';

function mockReqResNext(query: Record<string, string> = {}) {
  const req = { query } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = {
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

describe('suggest.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('suggestArtistsEndpoint', () => {
    it('throws WxycError 400 when q parameter is missing', async () => {
      const { req, res, next } = mockReqResNext({});

      await expect(suggestArtistsEndpoint(req, res, next)).rejects.toThrow(WxycError);
      await expect(suggestArtistsEndpoint(req, res, next)).rejects.toThrow('Missing required query parameter: q');
    });

    it('returns 200 with artist names', async () => {
      const mockArtists = ['Autechre', 'Autolux'];
      (suggestService.suggestArtists as jest.Mock).mockResolvedValue(mockArtists);

      const { req, res, next, statusMock, jsonMock } = mockReqResNext({ q: 'Aut' });

      await suggestArtistsEndpoint(req, res, next);

      expect(suggestService.suggestArtists).toHaveBeenCalledWith('Aut', undefined);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(mockArtists);
    });

    it('passes limit parameter to service', async () => {
      (suggestService.suggestArtists as jest.Mock).mockResolvedValue(['Autechre']);

      const { req, res, next } = mockReqResNext({ q: 'Aut', limit: '1' });

      await suggestArtistsEndpoint(req, res, next);

      expect(suggestService.suggestArtists).toHaveBeenCalledWith('Aut', 1);
    });

    it('rejects with the service error', async () => {
      const error = new Error('DB error');
      (suggestService.suggestArtists as jest.Mock).mockRejectedValue(error);

      const { req, res, next } = mockReqResNext({ q: 'Aut' });

      await expect(suggestArtistsEndpoint(req, res, next)).rejects.toThrow(error);
    });
  });

  describe('suggestTracksEndpoint', () => {
    it('throws WxycError 400 when q parameter is missing', async () => {
      const { req, res, next } = mockReqResNext({ artist: 'Autechre' });

      await expect(suggestTracksEndpoint(req, res, next)).rejects.toThrow('Missing required query parameter: q');
    });

    it('throws WxycError 400 when artist parameter is missing', async () => {
      const { req, res, next } = mockReqResNext({ q: 'VI' });

      await expect(suggestTracksEndpoint(req, res, next)).rejects.toThrow('Missing required query parameter: artist');
    });

    it('returns 200 with track results', async () => {
      const mockTracks = [{ track_title: 'VI Scose Poise', album_title: 'Confield', record_label: 'Warp' }];
      (suggestService.suggestTracks as jest.Mock).mockResolvedValue(mockTracks);

      const { req, res, next, statusMock, jsonMock } = mockReqResNext({ q: 'VI', artist: 'Autechre' });

      await suggestTracksEndpoint(req, res, next);

      expect(suggestService.suggestTracks).toHaveBeenCalledWith('VI', 'Autechre', undefined);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(mockTracks);
    });
  });

  describe('getTrackDetailsEndpoint', () => {
    it('throws WxycError 400 when artist parameter is missing', async () => {
      const { req, res, next } = mockReqResNext({ track: 'VI Scose Poise' });

      await expect(getTrackDetailsEndpoint(req, res, next)).rejects.toThrow(
        'Missing required query parameter: artist'
      );
    });

    it('throws WxycError 400 when track parameter is missing', async () => {
      const { req, res, next } = mockReqResNext({ artist: 'Autechre' });

      await expect(getTrackDetailsEndpoint(req, res, next)).rejects.toThrow(
        'Missing required query parameter: track'
      );
    });

    it('returns 200 with track details', async () => {
      const mockDetails = { album_title: 'Confield', record_label: 'Warp' };
      (suggestService.getTrackDetails as jest.Mock).mockResolvedValue(mockDetails);

      const { req, res, next, statusMock, jsonMock } = mockReqResNext({
        artist: 'Autechre',
        track: 'VI Scose Poise',
      });

      await getTrackDetailsEndpoint(req, res, next);

      expect(suggestService.getTrackDetails).toHaveBeenCalledWith('Autechre', 'VI Scose Poise');
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(mockDetails);
    });

    it('returns 200 with null when no match found', async () => {
      (suggestService.getTrackDetails as jest.Mock).mockResolvedValue(null);

      const { req, res, next, statusMock, jsonMock } = mockReqResNext({
        artist: 'Unknown',
        track: 'Unknown',
      });

      await getTrackDetailsEndpoint(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(null);
    });
  });
});
