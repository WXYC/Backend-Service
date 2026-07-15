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
const mockMapLookupToCanonicalEntity = jest.fn<(response: unknown) => { id: string; confidence: number } | null>();
type PickerSourceMock = {
  releaseId: number | null;
  inlineTracklist: Array<{ position: string; title: string; duration: string | null; artists: string[] }> | null;
};
const mockResolveRotationPickerSource = jest.fn<(rotationId: number) => Promise<PickerSourceMock | null>>();
type RotationTrackMock = { position: string; title: string; duration: string | null; artists: string[] };
const mockGetRotationTracksFromRelease = jest.fn<(releaseId: number) => Promise<RotationTrackMock[] | null>>();

// PATCH /library/:id (updateAlbum) surface.
const mockGetLibraryRowById = jest.fn<(id: number) => Promise<Record<string, unknown> | undefined>>();
const mockUpdateAlbumInDB =
  jest.fn<(id: number, updates: Record<string, unknown>, opts?: unknown) => Promise<{ id: number } | undefined>>();
const mockGetFormatById = jest.fn<(id: number) => Promise<{ id: number; format_name: string } | undefined>>();
const mockArtistExistsInGenre = jest.fn<(artistId: number, genreId: number) => Promise<boolean>>();
const mockAlbumCodeNumberTaken = jest.fn<(artistId: number, code: number, exclude: number) => Promise<boolean>>();
const mockUpdateOnStreaming = jest.fn<() => Promise<unknown>>();
const mockUpdateArtworkUrl = jest.fn<() => Promise<unknown>>();
const mockGetLabelById = jest.fn<(id: number) => Promise<{ id: number; label_name: string } | undefined>>();
const mockSearchLibrary = jest.fn<() => Promise<{ results: unknown[]; total: number }>>();

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
  updateArtworkUrl: mockUpdateArtworkUrl,
  updateOnStreaming: mockUpdateOnStreaming,
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
  getFormatById: mockGetFormatById,
  isISODate: jest.fn(),
  resolveRotationPickerSource: mockResolveRotationPickerSource,
  getRotationTracksFromRelease: mockGetRotationTracksFromRelease,
  getLibraryRowById: mockGetLibraryRowById,
  updateAlbumInDB: mockUpdateAlbumInDB,
  artistExistsInGenre: mockArtistExistsInGenre,
  albumCodeNumberTaken: mockAlbumCodeNumberTaken,
}));

jest.mock('../../../apps/backend/services/labels.service', () => ({
  createLabel: mockCreateLabel,
  getLabelById: mockGetLabelById,
}));

jest.mock('../../../apps/backend/services/library-search.service', () => ({
  parseEnumQueryList: () => undefined,
  parseRotationBinsQueryList: () => undefined,
  searchLibrary: mockSearchLibrary,
}));

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockCheckStreamingAvailability = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>().mockReturnValue(false);

jest.mock('@wxyc/lml-client', () => ({
  checkStreamingAvailability: mockCheckStreamingAvailability,
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
  envInt: (_name: string, fallback: number) => fallback,
}));

// Backend code paths now route through the LmlLookupCoordinator (BS#885).
// The mock stub mirrors the real coordinator's `requireSearchType` gate
// (BS#1355) so the addAlbum + fireAndForgetCanonicalEntity migrations are
// validated end-to-end.
jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: {
    lookup: async (artist: unknown, album: unknown, song: unknown, opts: Record<string, unknown> | undefined) => {
      const response = (await mockLookupMetadata(artist as never, album as never, song as never, opts as never)) as {
        search_type?: string;
      } | null;
      if (response && opts?.requireSearchType && response.search_type !== opts.requireSearchType) {
        return null;
      }
      return response;
    },
  },
}));

import {
  markMissing,
  markFound,
  searchForAlbum,
  addAlbum,
  getRotationTracks,
  updateAlbum,
  searchLibraryQueryEndpoint,
} from '../../../apps/backend/controllers/library.controller';

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
    it('returns enriched results when enrichment finishes within the budget', async () => {
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

    it('returns raw results without waiting when enrichment exceeds the budget', async () => {
      const searchResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      // Enrichment that never resolves within any reasonable budget.
      mockEnrichWithArtwork.mockReturnValue(new Promise<unknown[]>(() => undefined));

      const previous = process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS;
      process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS = '20';
      jest.resetModules();
      const { searchForAlbum: searchWithTightBudget } =
        await import('../../../apps/backend/controllers/library.controller');

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      const start = Date.now();
      await searchWithTightBudget(req, res, next);
      const elapsed = Date.now() - start;

      try {
        expect(elapsed).toBeLessThan(500);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(searchResults);
      } finally {
        if (previous === undefined) delete process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS;
        else process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS = previous;
      }
    });

    it('returns 400 when no query parameters are supplied', async () => {
      const req = { query: {} } as unknown as Request;
      const res = mockResponse();

      await expect(searchForAlbum(req, res, next)).rejects.toThrow('Missing query parameter');
      expect(mockFuzzySearchLibrary).not.toHaveBeenCalled();
    });

    it('accepts on_streaming=false as a sufficient filter and returns 200', async () => {
      const searchResults = [{ id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', on_streaming: false }];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      mockEnrichWithArtwork.mockResolvedValue(searchResults);

      const req = { query: { on_streaming: 'false' } } as unknown as Request;
      const res = mockResponse();

      await searchForAlbum(req, res, next);

      expect(mockFuzzySearchLibrary).toHaveBeenCalledWith(undefined, undefined, undefined, false);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(searchResults);
    });

    it('accepts on_streaming=true as a sufficient filter and returns 200', async () => {
      const searchResults = [{ id: 2, artist_name: 'Stereolab', album_title: 'Aluminum Tunes', on_streaming: true }];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      mockEnrichWithArtwork.mockResolvedValue(searchResults);

      const req = { query: { on_streaming: 'true' } } as unknown as Request;
      const res = mockResponse();

      await searchForAlbum(req, res, next);

      expect(mockFuzzySearchLibrary).toHaveBeenCalledWith(undefined, undefined, undefined, true);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(searchResults);
    });

    it('does not propagate enrichment errors as request failures', async () => {
      const searchResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      const enrichError = new Error('enrichment failed');
      // Reject *after* the budget would naturally fire — the budget should win
      // and the rejection should be swallowed.
      mockEnrichWithArtwork.mockReturnValue(
        new Promise<unknown[]>((_, reject) => setTimeout(() => reject(enrichError), 500))
      );

      const previous = process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS;
      // Budget << reject delay; 50/500/750ms gives ~10x headroom over the
      // previous 5/50/75ms shape so CI runners under load don't race-invert
      // and resolve the rejection before the budget fires.
      process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS = '50';
      jest.resetModules();
      const { searchForAlbum: searchWithTightBudget } =
        await import('../../../apps/backend/controllers/library.controller');

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      try {
        await expect(searchWithTightBudget(req, res, next)).resolves.toBeUndefined();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(searchResults);
        // Give the late rejection time to settle into the catch handler so the
        // assertion below isn't subject to a process-level unhandledRejection.
        await new Promise((resolve) => setTimeout(resolve, 750));
      } finally {
        if (previous === undefined) delete process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS;
        else process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS = previous;
      }
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
        expect(mockLookupMetadata).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, {
          budgetMs: 5000,
          caller: 'library-canonical-entity',
          warm_cache: true,
          requireSearchType: 'direct',
        });
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

  describe('getRotationTracks', () => {
    const sampleProjection: RotationTrackMock[] = [
      { position: 'A1', title: 'VI Scose Poise', duration: '5:30', artists: ['Autechre'] },
      { position: 'A2', title: 'Cfern', duration: '5:11', artists: ['Autechre'] },
    ];

    beforeEach(() => {
      mockResolveRotationPickerSource.mockReset();
      mockGetRotationTracksFromRelease.mockReset();
    });

    it('returns 400 for non-numeric rotation_id', async () => {
      const req = { params: { rotation_id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(getRotationTracks(req, res, next)).rejects.toThrow('positive integer');
      expect(mockResolveRotationPickerSource).not.toHaveBeenCalled();
    });

    it('returns 400 for non-positive rotation_id', async () => {
      const req = { params: { rotation_id: '0' } } as unknown as Request;
      const res = mockResponse();

      await expect(getRotationTracks(req, res, next)).rejects.toThrow('positive integer');
    });

    it('returns 200 + empty array when no identity resolves (rotation missing, no album_id, or no library_identity row)', async () => {
      mockResolveRotationPickerSource.mockResolvedValue(null);
      const req = { params: { rotation_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getRotationTracks(req, res, next);

      expect(mockResolveRotationPickerSource).toHaveBeenCalledWith(42);
      expect(mockGetRotationTracksFromRelease).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([]);
    });

    it('delegates to getRotationTracksFromRelease when identity resolves and inline tracklist is absent', async () => {
      mockResolveRotationPickerSource.mockResolvedValue({ releaseId: 4080, inlineTracklist: null });
      mockGetRotationTracksFromRelease.mockResolvedValue(sampleProjection);
      const req = { params: { rotation_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getRotationTracks(req, res, next);

      expect(mockGetRotationTracksFromRelease).toHaveBeenCalledWith(4080);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(sampleProjection);
    });

    it('short-circuits to the inline tracklist when the resolver carries one (no release fetch)', async () => {
      // BS#1185 + LML#427: when the tier-3 LML lookup returns an extended
      // result with a tracklist (Discogs hit OR MusicBrainz rescue), the
      // service projects it inline and the controller returns it directly.
      // No second LML round-trip.
      const inlineTracklist = [
        { position: '1', title: 'Tragic Magic', duration: '6:01', artists: ['Julianna Barwick & Mary Lattimore'] },
        { position: '2', title: 'For Mariko', duration: '4:18', artists: ['Julianna Barwick & Mary Lattimore'] },
      ];
      mockResolveRotationPickerSource.mockResolvedValue({ releaseId: null, inlineTracklist });
      const req = { params: { rotation_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getRotationTracks(req, res, next);

      expect(mockGetRotationTracksFromRelease).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(inlineTracklist);
    });

    it('returns 200 + empty array when the service returns null (LML 404 negative-cached)', async () => {
      mockResolveRotationPickerSource.mockResolvedValue({ releaseId: 9999999, inlineTracklist: null });
      mockGetRotationTracksFromRelease.mockResolvedValue(null);
      const req = { params: { rotation_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getRotationTracks(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([]);
    });

    it('bubbles service errors (LML 5xx, network) so transient failures surface rather than silently degrading', async () => {
      mockResolveRotationPickerSource.mockResolvedValue({ releaseId: 4080, inlineTracklist: null });
      mockGetRotationTracksFromRelease.mockRejectedValue(new Error('upstream timeout'));
      const req = { params: { rotation_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await expect(getRotationTracks(req, res, next)).rejects.toThrow('upstream timeout');
    });
  });

  describe('updateAlbum', () => {
    const existingRow = {
      id: 42,
      artist_id: 7,
      genre_id: 11,
      format_id: 1,
      album_title: 'DOGA',
      label: 'Sonamos',
      label_id: 10,
      alternate_artist_name: null,
      disc_quantity: 1,
      code_number: 3,
      artist_name: 'Juana Molina',
    };

    const reqFor = (body: Record<string, unknown>) => ({ params: { id: '42' }, body }) as unknown as Request;

    beforeEach(() => {
      jest.clearAllMocks();
      mockIsLmlConfigured.mockReturnValue(false);
      mockGetLibraryRowById.mockResolvedValue(existingRow);
      mockUpdateAlbumInDB.mockResolvedValue({ id: 42 });
      mockGetFormatById.mockResolvedValue({ id: 1, format_name: 'CD' });
      mockGetAlbumFromDB.mockResolvedValue(fullAlbum);
      mockGetArtistNameById.mockResolvedValue('Juana Molina');
      mockArtistExistsInGenre.mockResolvedValue(true);
    });

    describe('format_id existence guard (#1550)', () => {
      it('returns 400 when format_id does not reference an existing format', async () => {
        mockGetFormatById.mockResolvedValue(undefined);
        const res = mockResponse();

        await expect(updateAlbum(reqFor({ format_id: 99999999 }), res, next)).rejects.toThrow(
          'format_id does not reference an existing format'
        );
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('does not create an orphan label when an invalid format_id is combined with a new label', async () => {
        mockGetFormatById.mockResolvedValue(undefined);
        const res = mockResponse();

        await expect(updateAlbum(reqFor({ format_id: 99999999, label: 'Brand New Label' }), res, next)).rejects.toThrow(
          'format_id does not reference an existing format'
        );
        // format_id is validated before the label upsert, so no labels row is stranded.
        expect(mockCreateLabel).not.toHaveBeenCalled();
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('accepts a format_id that references an existing format', async () => {
        mockGetFormatById.mockResolvedValue({ id: 2, format_name: 'Vinyl' });
        const res = mockResponse();

        await updateAlbum(reqFor({ format_id: 2 }), res, next);

        expect(mockGetFormatById).toHaveBeenCalledWith(2);
        expect(mockUpdateAlbumInDB).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe('over-length string guards (#1551)', () => {
      it('returns 400 for an over-length album_title (>128 chars)', async () => {
        const res = mockResponse();

        await expect(updateAlbum(reqFor({ album_title: 'a'.repeat(129) }), res, next)).rejects.toThrow(
          'album_title must be 128 characters or fewer'
        );
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('returns 400 for an over-length alternate_artist_name (>128 chars)', async () => {
        const res = mockResponse();

        await expect(updateAlbum(reqFor({ alternate_artist_name: 'a'.repeat(129) }), res, next)).rejects.toThrow(
          'alternate_artist_name must be 128 characters or fewer'
        );
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('returns 400 for an over-length label (>128 chars) without upserting it', async () => {
        const res = mockResponse();

        await expect(updateAlbum(reqFor({ label: 'a'.repeat(129) }), res, next)).rejects.toThrow(
          'label must be 128 characters or fewer'
        );
        expect(mockCreateLabel).not.toHaveBeenCalled();
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('accepts an exactly-128-char album_title', async () => {
        const res = mockResponse();

        await updateAlbum(reqFor({ album_title: 'a'.repeat(128) }), res, next);

        expect(mockUpdateAlbumInDB).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe('no-op short-circuit (#1555)', () => {
      it('returns 200 without running the UPDATE when artist_id is unchanged', async () => {
        const res = mockResponse();

        await updateAlbum(reqFor({ artist_id: 7 }), res, next);

        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(fullAlbum);
      });

      it('returns 200 without running the UPDATE when the submitted album_title equals the stored value', async () => {
        const res = mockResponse();

        await updateAlbum(reqFor({ album_title: 'DOGA' }), res, next);

        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('runs the UPDATE when a field actually changes', async () => {
        const res = mockResponse();

        await updateAlbum(reqFor({ album_title: 'A Different Title' }), res, next);

        expect(mockUpdateAlbumInDB).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe('enrichment repair on identity change (#1549)', () => {
      it('does not null enrichment columns when LML is unconfigured', async () => {
        mockIsLmlConfigured.mockReturnValue(false);
        const res = mockResponse();

        await updateAlbum(reqFor({ album_title: 'A New Title' }), res, next);

        // Two-arg call, no resetEnrichment flag: updateAlbumInDB never NULLs
        // on_streaming / artwork_url / canonical_entity_*.
        expect(mockUpdateAlbumInDB).toHaveBeenCalledWith(42, expect.objectContaining({ album_title: 'A New Title' }));
        expect(mockUpdateAlbumInDB.mock.calls[0]).toHaveLength(2);
        // LML unconfigured -> no re-enrichment fired, so nothing is wiped or rewritten.
        expect(mockUpdateOnStreaming).not.toHaveBeenCalled();
        expect(mockUpdateArtworkUrl).not.toHaveBeenCalled();
        expect(mockUpdateCanonicalEntity).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('preserves prior enrichment when the identity re-lookup finds no match', async () => {
        mockIsLmlConfigured.mockReturnValue(true);
        mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: null });
        mockLookupMetadata.mockResolvedValue(null); // no match: coordinator returns null
        const res = mockResponse();

        await updateAlbum(reqFor({ album_title: 'A New Title' }), res, next);
        // Drain the fire-and-forget canonical-entity lookup before asserting.
        await new Promise((r) => setImmediate(r));

        expect(mockUpdateAlbumInDB).toHaveBeenCalledWith(42, expect.objectContaining({ album_title: 'A New Title' }));
        expect(mockUpdateAlbumInDB.mock.calls[0]).toHaveLength(2);
        // A no-match re-lookup writes nothing, so the prior artwork / streaming /
        // canonical values survive the edit instead of being NULLed-and-abandoned.
        expect(mockUpdateOnStreaming).not.toHaveBeenCalled();
        expect(mockUpdateArtworkUrl).not.toHaveBeenCalled();
        expect(mockUpdateCanonicalEntity).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('swaps in the newly looked-up artwork/streaming when the re-lookup matches', async () => {
        mockIsLmlConfigured.mockReturnValue(true);
        mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: true });
        mockLookupMetadata.mockResolvedValue({
          search_type: 'direct',
          results: [{ artwork: { artwork_url: 'https://i.discogs.com/new.jpg' } }],
        });
        const res = mockResponse();

        await updateAlbum(reqFor({ album_title: 'A New Title' }), res, next);
        await new Promise((r) => setImmediate(r));

        expect(mockUpdateOnStreaming).toHaveBeenCalledWith(42, true);
        expect(mockUpdateArtworkUrl).toHaveBeenCalledWith(42, 'https://i.discogs.com/new.jpg');
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });
  });

  describe('searchLibraryQueryEndpoint', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockSearchLibrary.mockResolvedValue({ results: [], total: 0 });
    });

    it('returns 400 when the page key is repeated (Express yields string[]) (#1553)', async () => {
      const req = { query: { page: ['1', '2'] } } as unknown as Request;
      const res = mockResponse();

      await expect(searchLibraryQueryEndpoint(req, res, next)).rejects.toThrow('page must be a single string value');
      expect(mockSearchLibrary).not.toHaveBeenCalled();
    });

    it('returns 400 when the limit key is repeated (Express yields string[]) (#1553)', async () => {
      const req = { query: { limit: ['1', '2'] } } as unknown as Request;
      const res = mockResponse();

      await expect(searchLibraryQueryEndpoint(req, res, next)).rejects.toThrow('limit must be a single string value');
      expect(mockSearchLibrary).not.toHaveBeenCalled();
    });

    it('accepts single-valued page/limit and returns 200', async () => {
      const req = { query: { page: '1', limit: '10' } } as unknown as Request;
      const res = mockResponse();

      await searchLibraryQueryEndpoint(req, res, next);

      expect(mockSearchLibrary).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
