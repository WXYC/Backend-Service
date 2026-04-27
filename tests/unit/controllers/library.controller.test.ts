import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetAlbumFromDB = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockMarkAlbumMissing = jest.fn<() => Promise<{ id: number } | undefined>>();
const mockMarkAlbumFound = jest.fn<() => Promise<{ id: number } | undefined>>();
const mockFuzzySearchLibrary = jest.fn<() => Promise<unknown[]>>();
const mockEnrichWithArtwork = jest.fn<(results: unknown[]) => Promise<unknown[]>>();
const mockArtistIdFromName = jest.fn<(name: string, genreId: number) => Promise<number>>();
const mockGetArtistNameById = jest.fn<(id: number) => Promise<string | null>>();
const mockInsertAlbum = jest.fn<(album: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const mockGenerateAlbumCodeNumber = jest.fn<(artistId: number) => Promise<number>>();
const mockCreateLabel = jest.fn<(label: string) => Promise<{ id: number }>>();
const mockUpdateCanonicalEntity = jest.fn<(id: number, entityId: string, confidence: number) => Promise<unknown>>();
const mockMapLookupToCanonicalEntity =
  jest.fn<(response: unknown) => { id: string; confidence: number } | null>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  getAlbumFromDB: mockGetAlbumFromDB,
  markAlbumMissing: mockMarkAlbumMissing,
  markAlbumFound: mockMarkAlbumFound,
  fuzzySearchLibrary: mockFuzzySearchLibrary,
  enrichWithArtwork: mockEnrichWithArtwork,
  // Identity-preserving wire-shape transform: tests stub it as a pass-through
  // so the assertions below see the same objects produced by enrichWithArtwork.
  serializeLibraryArtistViewEntry: (row: unknown) => row,
  serializeArtist: (row: unknown) => row,
  // Stub out other exports that may be referenced at import time
  getFormatsFromDB: jest.fn(),
  getRotationFromDB: jest.fn(),
  addToRotation: jest.fn(),
  killRotationInDB: jest.fn(),
  insertAlbum: mockInsertAlbum,
  updateArtworkUrl: jest.fn(),
  updateOnStreaming: jest.fn(),
  updateCanonicalEntity: mockUpdateCanonicalEntity,
  mapLookupToCanonicalEntity: mockMapLookupToCanonicalEntity,
  artistIdFromName: mockArtistIdFromName,
  getArtistNameById: mockGetArtistNameById,
  insertArtist: jest.fn(),
  insertArtistGenreCrossreference: jest.fn(),
  getArtistByCode: jest.fn(),
  generateAlbumCodeNumber: mockGenerateAlbumCodeNumber,
  generateArtistNumber: jest.fn(),
  getGenresFromDB: jest.fn(),
  insertGenre: jest.fn(),
  insertFormat: jest.fn(),
  isISODate: jest.fn(),
}));

jest.mock('../../../apps/backend/services/labels.service', () => ({
  createLabel: mockCreateLabel,
}));

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockCheckStreamingAvailability = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>().mockReturnValue(false);

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  checkStreamingAvailability: mockCheckStreamingAvailability,
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
}));

import { markMissing, markFound, searchForAlbum, addAlbum } from '../../../apps/backend/controllers/library.controller';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

const fullAlbum = {
  id: 42,
  code_letters: 'AU',
  code_artist_number: 1,
  code_number: 3,
  artist_name: 'Autechre',
  alphabetical_name: 'Autechre',
  album_title: 'Confield',
  record_label: 'Warp',
  label_id: 10,
  plays: 5,
  add_date: new Date('2024-01-15'),
  last_modified: new Date('2024-03-01'),
  format_name: 'CD',
  genre_name: 'Electronic',
  date_lost: new Date('2026-04-22'),
  date_found: null,
  on_streaming: true,
};

describe('library.controller', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
  });

  describe('markMissing', () => {
    it('returns 400 for non-numeric id parameter', async () => {
      const req = { params: { id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 400 for non-positive id parameter', async () => {
      const req = { params: { id: '0' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 400 for negative id parameter', async () => {
      const req = { params: { id: '-5' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 404 when album not found', async () => {
      mockMarkAlbumMissing.mockResolvedValue(undefined);
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Album not found');
    });

    it('returns 200 with full album on success', async () => {
      mockMarkAlbumMissing.mockResolvedValue({ id: 42 });
      mockGetAlbumFromDB.mockResolvedValue(fullAlbum);
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await markMissing(req, res, next);

      expect(mockMarkAlbumMissing).toHaveBeenCalledWith(42);
      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(fullAlbum);
    });
  });

  describe('markFound', () => {
    it('returns 400 for non-numeric id parameter', async () => {
      const req = { params: { id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(markFound(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 400 for non-positive id parameter', async () => {
      const req = { params: { id: '0' } } as unknown as Request;
      const res = mockResponse();

      await expect(markFound(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 404 when album not found', async () => {
      mockMarkAlbumFound.mockResolvedValue(undefined);
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(markFound(req, res, next)).rejects.toThrow('Album not found');
    });

    it('returns 200 with full album on success', async () => {
      mockMarkAlbumFound.mockResolvedValue({ id: 42 });
      mockGetAlbumFromDB.mockResolvedValue({ ...fullAlbum, date_lost: null, date_found: new Date('2026-04-22') });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await markFound(req, res, next);

      expect(mockMarkAlbumFound).toHaveBeenCalledWith(42);
      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 42, date_found: expect.any(Date) }));
    });
  });

  describe('searchForAlbum', () => {
    it('calls enrichWithArtwork after fuzzy search', async () => {
      const searchResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];
      const enrichedResults = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: 'https://i.discogs.com/confield.jpg' },
      ];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      mockEnrichWithArtwork.mockResolvedValue(enrichedResults);

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      await searchForAlbum(req, res, next);

      expect(mockFuzzySearchLibrary).toHaveBeenCalledWith('Autechre', undefined, undefined, undefined);
      expect(mockEnrichWithArtwork).toHaveBeenCalledWith(searchResults);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(enrichedResults);
    });

    it('rejects when enrichment throws', async () => {
      const searchResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      const enrichError = new Error('enrichment failed');
      mockEnrichWithArtwork.mockRejectedValue(enrichError);

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      await expect(searchForAlbum(req, res, next)).rejects.toThrow(enrichError);
    });
  });

  describe('addAlbum', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGenerateAlbumCodeNumber.mockResolvedValue(1);
      mockCreateLabel.mockResolvedValue({ id: 99 });
      mockInsertAlbum.mockImplementation((album) => Promise.resolve({ id: 1, ...album }));
    });

    it('writes the canonical artist_name from the artists table when artist_id is supplied', async () => {
      mockGetArtistNameById.mockResolvedValue('Juana Molina');

      const req = {
        body: {
          album_title: 'DOGA',
          artist_id: 42,
          label: 'Sonamos',
          genre_id: 11,
          format_id: 1,
        },
      } as unknown as Request;
      const res = mockResponse();

      await addAlbum(req, res, next);

      expect(mockGetArtistNameById).toHaveBeenCalledWith(42);
      expect(mockInsertAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ artist_id: 42, artist_name: 'Juana Molina' })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('resolves the canonical artist_name even when the request body provides one', async () => {
      mockArtistIdFromName.mockResolvedValue(7);
      mockGetArtistNameById.mockResolvedValue('Jessica Pratt');

      const req = {
        body: {
          album_title: 'On Your Own Love Again',
          artist_name: 'jessica pratt',
          label: 'Drag City',
          genre_id: 11,
          format_id: 1,
        },
      } as unknown as Request;
      const res = mockResponse();

      await addAlbum(req, res, next);

      expect(mockGetArtistNameById).toHaveBeenCalledWith(7);
      expect(mockInsertAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ artist_id: 7, artist_name: 'Jessica Pratt' })
      );
    });

    describe('canonical entity (B-1.3)', () => {
      beforeEach(() => {
        mockGetArtistNameById.mockResolvedValue('Juana Molina');
        mockInsertAlbum.mockImplementation((album) => Promise.resolve({ id: 501, ...album }));
        mockIsLmlConfigured.mockReturnValue(true);
        mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: null });
      });

      const req = () =>
        ({
          body: {
            album_title: 'DOGA',
            artist_id: 42,
            label: 'Sonamos',
            genre_id: 11,
            format_id: 1,
          },
        }) as unknown as Request;

      it('kicks off an LML lookup for canonical entity resolution after insert', async () => {
        const lookupResponse = { results: [], search_type: 'none' };
        mockLookupMetadata.mockResolvedValue(lookupResponse);
        mockMapLookupToCanonicalEntity.mockReturnValue(null);

        const res = mockResponse();
        await addAlbum(req(), res, next);

        // Controller returns 201 immediately, before fire-and-forget completes.
        expect(res.status).toHaveBeenCalledWith(201);
        expect(mockLookupMetadata).toHaveBeenCalledWith('Juana Molina', 'DOGA');
      });

      it('writes canonical_entity_id back to the inserted row when the lookup yields a match', async () => {
        const lookupResponse = {
          results: [{ artwork: { release_id: 999 } }],
          search_type: 'direct',
        };
        mockLookupMetadata.mockResolvedValue(lookupResponse);
        mockMapLookupToCanonicalEntity.mockReturnValue({ id: 'discogs:release:999', confidence: 0.9 });
        mockUpdateCanonicalEntity.mockResolvedValue({ id: 501 });

        const res = mockResponse();
        await addAlbum(req(), res, next);

        // Fire-and-forget — let the microtask queue drain before asserting.
        await new Promise((r) => setImmediate(r));

        expect(mockMapLookupToCanonicalEntity).toHaveBeenCalledWith(lookupResponse);
        expect(mockUpdateCanonicalEntity).toHaveBeenCalledWith(501, 'discogs:release:999', 0.9);
      });

      it('does not write canonical entity when the mapper returns null (no linkable result)', async () => {
        mockLookupMetadata.mockResolvedValue({ results: [], search_type: 'none' });
        mockMapLookupToCanonicalEntity.mockReturnValue(null);

        const res = mockResponse();
        await addAlbum(req(), res, next);
        await new Promise((r) => setImmediate(r));

        expect(mockUpdateCanonicalEntity).not.toHaveBeenCalled();
      });

      it('skips the lookup entirely when LML is not configured', async () => {
        mockIsLmlConfigured.mockReturnValue(false);

        const res = mockResponse();
        await addAlbum(req(), res, next);
        await new Promise((r) => setImmediate(r));

        expect(mockLookupMetadata).not.toHaveBeenCalled();
        expect(mockUpdateCanonicalEntity).not.toHaveBeenCalled();
      });
    });
  });
});
