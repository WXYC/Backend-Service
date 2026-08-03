import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/library.service');

import * as libraryService from '../../../apps/backend/services/library.service';
import {
  validateCompilationTracksBody,
  getCompilationTracks,
  writeCompilationTracks,
  getCompilationTrackDiscogsSuggestions,
} from '../../../apps/backend/controllers/library.controller';

function mockReqResNext(overrides: Partial<Request> = {}) {
  const req = { params: {}, body: {}, auth: { id: 'test-user-id' }, ...overrides } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const sendMock = jest.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock, send: sendMock } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock, sendMock };
}

describe('validateCompilationTracksBody (BS#1964 CTA write validation)', () => {
  it('rejects a missing/empty tracks array', () => {
    expect(validateCompilationTracksBody({}).ok).toBe(false);
    expect(validateCompilationTracksBody({ tracks: [] }).ok).toBe(false);
    expect(validateCompilationTracksBody({ tracks: undefined }).ok).toBe(false);
  });

  it('rejects a track whose artist_name is missing or blank', () => {
    expect(validateCompilationTracksBody({ tracks: [{ track_title: 'x' }] }).ok).toBe(false);
    expect(validateCompilationTracksBody({ tracks: [{ artist_name: '' }] }).ok).toBe(false);
    expect(validateCompilationTracksBody({ tracks: [{ artist_name: '   ' }] }).ok).toBe(false);
  });

  it('trims artist_name and coerces blank optional fields to null', () => {
    const result = validateCompilationTracksBody({
      tracks: [{ artist_name: '  Juana Molina  ', track_title: '  ', track_position: '' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracks[0]).toEqual({
        artist_name: 'Juana Molina',
        track_title: null,
        track_position: null,
      });
    }
  });

  it('preserves populated optional fields (trimmed)', () => {
    const result = validateCompilationTracksBody({
      tracks: [{ artist_name: 'Jessica Pratt', track_title: '  Back, Baby ', track_position: 'A2' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracks[0]).toEqual({
        artist_name: 'Jessica Pratt',
        track_title: 'Back, Baby',
        track_position: 'A2',
      });
    }
  });

  it('rejects over-length fields (255 / 255 / 20)', () => {
    expect(validateCompilationTracksBody({ tracks: [{ artist_name: 'a'.repeat(256) }] }).ok).toBe(false);
    expect(validateCompilationTracksBody({ tracks: [{ artist_name: 'ok', track_title: 'a'.repeat(256) }] }).ok).toBe(
      false
    );
    expect(validateCompilationTracksBody({ tracks: [{ artist_name: 'ok', track_position: 'a'.repeat(21) }] }).ok).toBe(
      false
    );
  });

  it('accepts a list at the 500-entry cap but rejects one over it', () => {
    const track = { artist_name: 'Guest' };
    expect(validateCompilationTracksBody({ tracks: Array(500).fill(track) }).ok).toBe(true);
    const over = validateCompilationTracksBody({ tracks: Array(501).fill(track) });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.message).toMatch(/exceed/i);
    }
  });
});

describe('getCompilationTracks controller (BS#1964)', () => {
  it('returns 404 when the library row is absent', async () => {
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(false);
    const { req, res, next } = mockReqResNext({ params: { id: '7000' } } as Partial<Request>);
    await expect(getCompilationTracks(req, res, next)).rejects.toThrow('not found');
  });

  it('returns 400 on a non-numeric id', async () => {
    const { req, res, next } = mockReqResNext({ params: { id: 'nope' } } as Partial<Request>);
    await expect(getCompilationTracks(req, res, next)).rejects.toThrow('Invalid album ID');
  });

  it('returns 200 with the library_id + stored tracks', async () => {
    const rows = [{ id: 1, artist_name: 'Juana Molina', track_title: 'la paradoja', track_position: 'A1' }];
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(true);
    (libraryService.getCompilationTracks as jest.Mock).mockResolvedValue(rows);
    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { id: '7000' } } as Partial<Request>);
    await getCompilationTracks(req, res, next);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ library_id: 7000, tracks: rows });
  });
});

describe('writeCompilationTracks controller (BS#1964)', () => {
  it('returns 400 before touching the DB when the body is invalid', async () => {
    const { req, res, next } = mockReqResNext({ params: { id: '7000' }, body: { tracks: [] } } as Partial<Request>);
    await expect(writeCompilationTracks(req, res, next)).rejects.toThrow(/tracks/i);
    expect(libraryService.writeCompilationTracks).not.toHaveBeenCalled();
  });

  it('returns 404 when the library row is absent', async () => {
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(false);
    const { req, res, next } = mockReqResNext({
      params: { id: '7000' },
      body: { tracks: [{ artist_name: 'Juana Molina' }] },
    } as Partial<Request>);
    await expect(writeCompilationTracks(req, res, next)).rejects.toThrow('not found');
    expect(libraryService.writeCompilationTracks).not.toHaveBeenCalled();
  });

  it('returns 200 with inserted/skipped and the full stored set', async () => {
    const tracks = [{ id: 1, artist_name: 'Juana Molina', track_title: 'la paradoja', track_position: 'A1' }];
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(true);
    (libraryService.writeCompilationTracks as jest.Mock).mockResolvedValue({ inserted: 1, skipped: 0, tracks });
    const { req, res, next, statusMock, jsonMock } = mockReqResNext({
      params: { id: '7000' },
      body: { tracks: [{ artist_name: '  Juana Molina  ', track_title: 'la paradoja', track_position: 'A1' }] },
    } as Partial<Request>);
    await writeCompilationTracks(req, res, next);
    // service is handed the normalized (trimmed) rows
    expect(libraryService.writeCompilationTracks).toHaveBeenCalledWith(7000, [
      { artist_name: 'Juana Molina', track_title: 'la paradoja', track_position: 'A1' },
    ]);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ library_id: 7000, inserted: 1, skipped: 0, tracks });
  });
});

describe('getCompilationTrackDiscogsSuggestions controller (BS#1964)', () => {
  it('returns 404 when the library row is absent', async () => {
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(false);
    const { req, res, next } = mockReqResNext({ params: { id: '7000' } } as Partial<Request>);
    await expect(getCompilationTrackDiscogsSuggestions(req, res, next)).rejects.toThrow('not found');
  });

  it('returns 200 with discogs_release_id + write-ready suggestion rows', async () => {
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(true);
    (libraryService.getCompilationTrackSuggestions as jest.Mock).mockResolvedValue({
      discogs_release_id: 5559001,
      tracks: [{ artist_name: 'Juana Molina', track_title: 'la paradoja', track_position: '1' }],
    });
    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { id: '7000' } } as Partial<Request>);
    await getCompilationTrackDiscogsSuggestions(req, res, next);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      library_id: 7000,
      discogs_release_id: 5559001,
      tracks: [{ artist_name: 'Juana Molina', track_title: 'la paradoja', track_position: '1' }],
    });
  });

  it('returns 200 with a null release + empty tracks when nothing is resolvable', async () => {
    (libraryService.libraryRowExists as jest.Mock).mockResolvedValue(true);
    (libraryService.getCompilationTrackSuggestions as jest.Mock).mockResolvedValue({
      discogs_release_id: null,
      tracks: [],
    });
    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { id: '7009' } } as Partial<Request>);
    await getCompilationTrackDiscogsSuggestions(req, res, next);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ library_id: 7009, discogs_release_id: null, tracks: [] });
  });
});
