import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetAlbumFromDB = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockGetAlbumByLegacyId = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockMarkAlbumMissing = jest.fn<() => Promise<{ id: number } | undefined>>();
const mockMarkAlbumFound = jest.fn<() => Promise<{ id: number } | undefined>>();
const mockFuzzySearchLibrary = jest.fn<() => Promise<unknown[]>>();
const mockEnrichWithArtwork = jest.fn<(results: unknown[]) => Promise<unknown[]>>();
const mockArtistIdFromName = jest.fn<(name: string, genreId: number) => Promise<number>>();
const mockGetArtistNameById = jest.fn<(id: number) => Promise<string | null>>();
type ArtistConflictRow = { artist_id: number; artist_name: string; code_letters: string };
const mockGetArtistByCode =
  jest.fn<(codeLetters: string, genreId: number, codeNumber: number) => Promise<ArtistConflictRow | null>>();
const mockGetArtistById = jest.fn<(artistId: number) => Promise<ArtistConflictRow | null>>();
const mockInsertArtist = jest.fn<(artist: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const mockInsertArtistGenreCrossreference =
  jest.fn<(artistId: number, genreId: number, codeNumber: number) => Promise<unknown>>();
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

// POST /library/:id/discogs-recheck (BS#1283).
const mockRecheckDiscogsAvailability =
  jest.fn<
    (
      id: number,
      artistName: string,
      albumTitle: string
    ) => Promise<
      | { outcome: 'matched'; discogsReleaseId: number; confidence: number }
      | { outcome: 'low_confidence_match'; confidence: number }
      | { outcome: 'no_match' }
    >
  >();

// DELETE /library/:id (BS#2112).
const mockDeleteAlbumFromDB = jest.fn<
  (id: number) => Promise<
    | { outcome: 'deleted' }
    | { outcome: 'not_found' }
    | {
        outcome: 'has_flowsheet_plays';
        playCount: number;
        directPlayCount: number;
        rotationLinkedPlayCount: number;
      }
  >
>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  getAlbumFromDB: mockGetAlbumFromDB,
  getAlbumByLegacyId: mockGetAlbumByLegacyId,
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
  insertArtist: mockInsertArtist,
  insertArtistGenreCrossreference: mockInsertArtistGenreCrossreference,
  getArtistByCode: mockGetArtistByCode,
  getArtistById: mockGetArtistById,
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
  recheckDiscogsAvailability: mockRecheckDiscogsAvailability,
  deleteAlbumFromDB: mockDeleteAlbumFromDB,
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

// BS#1228: streaming-check partial-error telemetry (PostHog capture + Sentry
// span projection). Mirrors the `getPostHogClient` mock shape in
// tests/unit/middleware/legacy/mirror.posthog.test.ts and the
// `Sentry.getActiveSpan()?.setAttributes(...)` span mock shape in
// tests/unit/services/library-search.cascade-span.test.ts.
const mockPostHogCapture = jest.fn();
const mockGetPostHogClient = jest.fn(() => ({ capture: mockPostHogCapture }));
jest.mock('../../../apps/backend/utils/posthog', () => ({
  getPostHogClient: mockGetPostHogClient,
}));

type SpanLike = { setAttributes: jest.Mock };
const mockSpan: SpanLike = { setAttributes: jest.fn() };
jest.mock('@sentry/node', () => ({
  getActiveSpan: () => mockSpan,
}));

import {
  markMissing,
  markFound,
  searchForAlbum,
  addAlbum,
  addArtist,
  getAlbum,
  getRotationTracks,
  updateAlbum,
  searchLibraryQueryEndpoint,
  manualDiscogsRecheck,
  deleteAlbum,
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
    it('returns local search results without waiting for enrichment to resolve', async () => {
      const searchResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      // Enrichment that never resolves — proves the response can't be waiting on it.
      mockEnrichWithArtwork.mockReturnValue(new Promise<unknown[]>(() => undefined));

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      const start = Date.now();
      await searchForAlbum(req, res, next);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
      expect(mockFuzzySearchLibrary).toHaveBeenCalledWith('Autechre', undefined, undefined, undefined);
      expect(mockEnrichWithArtwork).toHaveBeenCalledWith(searchResults);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(searchResults);
    });

    it('excludes enrichment output from the response even when enrichment resolves immediately', async () => {
      const searchResults = [{ id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: null }];
      const enrichedResults = [
        { id: 1, artist_name: 'Autechre', album_title: 'Confield', artwork_url: 'https://i.discogs.com/confield.jpg' },
      ];
      mockFuzzySearchLibrary.mockResolvedValue(searchResults);
      mockEnrichWithArtwork.mockResolvedValue(enrichedResults);

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      await searchForAlbum(req, res, next);

      // Fire-and-forget: enrichment is still triggered (and still writes
      // artwork_url back to the DB for future searches to benefit from), but
      // the response is built synchronously from the raw search rows before
      // the detached promise can settle, so it never reflects enrichedResults.
      expect(mockEnrichWithArtwork).toHaveBeenCalledWith(searchResults);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(searchResults);
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
      // Rejects on the next microtask — well after the handler has already
      // sent the response, since enrichment is detached and never awaited.
      mockEnrichWithArtwork.mockReturnValue(Promise.reject(enrichError));

      const req = { query: { artist_name: 'Autechre' } } as unknown as Request;
      const res = mockResponse();

      await expect(searchForAlbum(req, res, next)).resolves.toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(searchResults);
      // Give the detached rejection time to settle into the controller's
      // `.catch` so the assertion above isn't subject to a process-level
      // unhandledRejection surfacing after this test completes.
      await new Promise((resolve) => setTimeout(resolve, 10));
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
        // BS#1826 PR 2: `library-canonical-entity` is class 3 (no budget
        // header) — the per-caller policy layer supplies `timeoutMs`
        // (8000ms), not this call site.
        expect(mockLookupMetadata).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, {
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

    describe('discogs_unavailable gate (BS#1294 1c)', () => {
      beforeEach(() => {
        mockGetArtistNameById.mockResolvedValue('Juana Molina');
        mockIsLmlConfigured.mockReturnValue(true);
        mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: null });
        mockLookupMetadata.mockResolvedValue({ results: [], search_type: 'none' });
        mockMapLookupToCanonicalEntity.mockReturnValue(null);
      });

      const req = () =>
        ({
          body: {
            album_title: 'DOGA',
            artist_id: 42,
            // The artwork-lookup call reads `body.artist_name` directly (not
            // the canonical name resolved via getArtistNameById), so it must
            // be present here to assert the exact call args below.
            artist_name: 'Juana Molina',
            label: 'Sonamos',
            genre_id: 11,
            format_id: 1,
          },
        }) as unknown as Request;

      it('pre-reads the freshly inserted row and forwards discogsUnavailable: false to the artwork lookup (fresh-insert no-op)', async () => {
        mockInsertAlbum.mockImplementation((album) =>
          Promise.resolve({ id: 501, ...album, discogs_unavailable: false })
        );

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(mockLookupMetadata).toHaveBeenCalledWith(
          'Juana Molina',
          'DOGA',
          undefined,
          expect.objectContaining({ caller: 'library-add-album', discogsUnavailable: false })
        );
      });

      it('forwards discogsUnavailable: true when the inserted row is already flagged (constructed case — never happens on fresh-insert)', async () => {
        mockInsertAlbum.mockImplementation((album) =>
          Promise.resolve({ id: 501, ...album, discogs_unavailable: true })
        );

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(mockLookupMetadata).toHaveBeenCalledWith(
          'Juana Molina',
          'DOGA',
          undefined,
          expect.objectContaining({ caller: 'library-add-album', discogsUnavailable: true })
        );
      });
    });

    // BS#1228 (LML#376 follow-up): `errored_sources` is thrown on the floor
    // today — capture it to PostHog + a Sentry span attribute so a future
    // retry-policy decision can be made from real production patterns.
    describe('streaming-check partial-error telemetry (BS#1228)', () => {
      const req = () =>
        ({
          body: {
            album_title: 'DOGA',
            artist_id: 42,
            artist_name: 'Juana Molina',
            label: 'Sonamos',
            genre_id: 11,
            format_id: 1,
          },
        }) as unknown as Request;

      beforeEach(() => {
        mockGetArtistNameById.mockResolvedValue('Juana Molina');
        mockInsertAlbum.mockImplementation((album) => Promise.resolve({ id: 501, ...album }));
        // Some cases below exercise a non-null on_streaming verdict, which
        // re-persists via updateOnStreaming and reassigns `inserted_album` in
        // the controller — give it a resolved value so that reassignment
        // doesn't collapse to undefined (this mock has no default elsewhere).
        mockUpdateOnStreaming.mockResolvedValue({ id: 501 });
        mockIsLmlConfigured.mockReturnValue(true);
        mockLookupMetadata.mockResolvedValue({ results: [], search_type: 'none' });
        mockMapLookupToCanonicalEntity.mockReturnValue(null);
      });

      it('emits a streaming_check_partial_error PostHog event when LML reports errored_sources', async () => {
        mockCheckStreamingAvailability.mockResolvedValue({
          on_streaming: null,
          errored_sources: ['spotify', 'apple_music'],
        });

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(mockPostHogCapture).toHaveBeenCalledTimes(1);
        expect(mockPostHogCapture).toHaveBeenCalledWith({
          distinctId: '501',
          event: 'streaming_check_partial_error',
          properties: {
            album_id: 501,
            artist: 'Juana Molina',
            title: 'DOGA',
            on_streaming_verdict: null,
            errored_sources: ['spotify', 'apple_music'],
          },
        });
      });

      it('projects streaming_check.errored_sources and streaming_check.on_streaming onto the active Sentry span', async () => {
        mockCheckStreamingAvailability.mockResolvedValue({
          on_streaming: false,
          errored_sources: ['bandcamp'],
        });

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(mockSpan.setAttributes).toHaveBeenCalledWith({
          'streaming_check.errored_sources': ['bandcamp'],
          'streaming_check.on_streaming': false,
        });
      });

      it('does not emit telemetry when errored_sources is an empty array', async () => {
        mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: true, errored_sources: [] });

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(mockPostHogCapture).not.toHaveBeenCalled();
        expect(mockSpan.setAttributes).not.toHaveBeenCalled();
      });

      it('does not emit telemetry when errored_sources is absent (pre-1.8.0 shape / defensive optional chaining)', async () => {
        mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: true });

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(mockPostHogCapture).not.toHaveBeenCalled();
        expect(mockSpan.setAttributes).not.toHaveBeenCalled();
      });

      it('swallows a PostHog capture failure and degrades to console.warn instead of bubbling up', async () => {
        mockCheckStreamingAvailability.mockResolvedValue({
          on_streaming: null,
          errored_sources: ['spotify'],
        });
        mockPostHogCapture.mockImplementationOnce(() => {
          throw new Error('posthog unreachable');
        });
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const res = mockResponse();
        await addAlbum(req(), res, next);

        expect(res.status).toHaveBeenCalledWith(201);
        expect(consoleWarnSpy).toHaveBeenCalledWith('Failed to emit streaming-check telemetry:', 'posthog unreachable');

        consoleWarnSpy.mockRestore();
      });
    });
  });

  describe('addArtist', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetArtistByCode.mockResolvedValue(null);
      mockArtistIdFromName.mockResolvedValue(0);
    });

    const req = (overrides: Record<string, unknown> = {}) =>
      ({
        body: {
          artist_name: 'Chuquimamani-Condori',
          code_letters: 'CH',
          genre_id: 15,
          code_number: 12,
          ...overrides,
        },
      }) as unknown as Request;

    it('creates a new artist when neither the code triple nor the name conflicts in that genre', async () => {
      mockInsertArtist.mockResolvedValue({
        id: 55,
        artist_name: 'Chuquimamani-Condori',
        alphabetical_name: 'Chuquimamani-Condori',
        code_letters: 'CH',
      });

      const res = mockResponse();
      await addArtist(req(), res, next);

      expect(mockGetArtistByCode).toHaveBeenCalledWith('CH', 15, 12);
      expect(mockArtistIdFromName).toHaveBeenCalledWith('Chuquimamani-Condori', 15);
      expect(mockInsertArtist).toHaveBeenCalledWith(
        expect.objectContaining({ artist_name: 'Chuquimamani-Condori', code_letters: 'CH' })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns 409 with the existing artist and an explicit code-conflict discriminant when the code triple already exists', async () => {
      mockGetArtistByCode.mockResolvedValue({ artist_id: 3, artist_name: 'Jockstrap', code_letters: 'CH' });

      const res = mockResponse();
      await addArtist(req(), res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Artist code already exists for that genre and code letters.',
        reason: 'artist_code_conflict',
        artist: { artist_id: 3, artist_name: 'Jockstrap', code_letters: 'CH' },
      });
      expect(mockInsertArtist).not.toHaveBeenCalled();
    });

    it('returns a distinguishable 409 when only the artist name conflicts in that genre', async () => {
      mockArtistIdFromName.mockResolvedValue(7);
      mockGetArtistById.mockResolvedValue({ artist_id: 7, artist_name: 'Nilüfer Yanya', code_letters: 'NI' });

      const res = mockResponse();
      await addArtist(req({ artist_name: 'Nilüfer Yanya', code_letters: 'ZZ' }), res, next);

      expect(mockGetArtistById).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'artist_name_conflict',
          artist: { artist_id: 7, artist_name: 'Nilüfer Yanya', code_letters: 'NI' },
        })
      );
      // Distinguishable from the code-triple 409: different reason and message text.
      const [payload] = (res.json as jest.Mock).mock.calls[0] as [{ message: string }];
      expect(payload.message).not.toBe('Artist code already exists for that genre and code letters.');
      expect(mockInsertArtist).not.toHaveBeenCalled();
    });

    it('creates the artist when the name match disappears between the two lookups', async () => {
      mockArtistIdFromName.mockResolvedValue(7);
      mockGetArtistById.mockResolvedValue(null);
      mockInsertArtist.mockResolvedValue({
        id: 55,
        artist_name: 'Chuquimamani-Condori',
        alphabetical_name: 'Chuquimamani-Condori',
        code_letters: 'CH',
      });

      const res = mockResponse();
      await addArtist(req(), res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockInsertArtist).toHaveBeenCalled();
      // Never a 409 that asserts a conflicting artist it cannot name.
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ artist: null }));
    });

    it('prefers the code-triple conflict over a simultaneous name conflict, deterministically', async () => {
      mockGetArtistByCode.mockResolvedValue({ artist_id: 3, artist_name: 'Jockstrap', code_letters: 'CH' });
      mockArtistIdFromName.mockResolvedValue(7);

      const res = mockResponse();
      await addArtist(req(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Artist code already exists for that genre and code letters.',
        reason: 'artist_code_conflict',
        artist: { artist_id: 3, artist_name: 'Jockstrap', code_letters: 'CH' },
      });
      // Short-circuits before the name pre-check even runs.
      expect(mockArtistIdFromName).not.toHaveBeenCalled();
      expect(mockInsertArtist).not.toHaveBeenCalled();
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
      discogs_unavailable: false,
      discogs_unavailable_note: null,
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

    // BS#1281 (Not-on-Discogs 1a): PATCH /library/:id accepts the MD's
    // discogs_unavailable write surface. The DB-tier behaviors (column
    // defaults, CHECK constraint, migration idempotency — issue tests 1–3)
    // are covered by the migrate-dryrun + integration CI tiers; these unit
    // tests cover the handler contract (issue tests 4–6 plus input validation).
    describe('discogs_unavailable', () => {
      it('persists a discogsUnavailable + note round-trip (issue test 4)', async () => {
        const res = mockResponse();
        await updateAlbum(reqFor({ discogsUnavailable: true, discogsUnavailableNote: 'embargoed promo' }), res, next);

        expect(mockUpdateAlbumInDB).toHaveBeenCalledWith(
          42,
          expect.objectContaining({ discogs_unavailable: true, discogs_unavailable_note: 'embargoed promo' })
        );
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('clears any note when discogsUnavailable is set false with the note omitted (issue test 5)', async () => {
        // Start from a flagged row that HAS a note, so clearing it is an
        // observable UPDATE rather than a no-op the #1555 short-circuit skips.
        mockGetLibraryRowById.mockResolvedValue({
          ...existingRow,
          discogs_unavailable: true,
          discogs_unavailable_note: 'was embargoed',
        });
        const res = mockResponse();
        await updateAlbum(reqFor({ discogsUnavailable: false }), res, next);

        const updates = mockUpdateAlbumInDB.mock.calls[0][1];
        expect(updates).toMatchObject({ discogs_unavailable: false, discogs_unavailable_note: null });
      });

      it('drops a client-supplied lastDiscogsRecheckAt — server-write-only (issue test 6)', async () => {
        const res = mockResponse();
        await updateAlbum(
          reqFor({ discogsUnavailable: true, lastDiscogsRecheckAt: '2020-01-01T00:00:00Z' }),
          res,
          next
        );

        const updates = mockUpdateAlbumInDB.mock.calls[0][1];
        expect(updates).not.toHaveProperty('last_discogs_recheck_at');
        expect(updates).toMatchObject({ discogs_unavailable: true });
      });

      it('rejects a non-null note contradicting discogsUnavailable: false (flag⟺note invariant)', async () => {
        const res = mockResponse();
        await expect(
          updateAlbum(reqFor({ discogsUnavailable: false, discogsUnavailableNote: 'still embargoed' }), res, next)
        ).rejects.toThrow(/discogsUnavailable/);
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('rejects a non-boolean discogsUnavailable', async () => {
        const res = mockResponse();
        await expect(updateAlbum(reqFor({ discogsUnavailable: 'yes' }), res, next)).rejects.toThrow(
          /discogsUnavailable must be a boolean/
        );
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('rejects a note longer than 500 characters', async () => {
        const res = mockResponse();
        await expect(
          updateAlbum(reqFor({ discogsUnavailable: true, discogsUnavailableNote: 'x'.repeat(501) }), res, next)
        ).rejects.toThrow(/500/);
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('adds a note to an already-flagged row when only the note is supplied', async () => {
        mockGetLibraryRowById.mockResolvedValue({ ...existingRow, discogs_unavailable: true });
        const res = mockResponse();
        await updateAlbum(reqFor({ discogsUnavailableNote: 'audience-segment only' }), res, next);

        const updates = mockUpdateAlbumInDB.mock.calls[0][1];
        expect(updates).toMatchObject({ discogs_unavailable_note: 'audience-segment only' });
        expect(updates).not.toHaveProperty('discogs_unavailable');
      });

      it('rejects a note on a not-yet-flagged row when the flag is omitted', async () => {
        // existingRow.discogs_unavailable === false and the body does not flip it.
        const res = mockResponse();
        await expect(updateAlbum(reqFor({ discogsUnavailableNote: 'orphan note' }), res, next)).rejects.toThrow(
          /discogsUnavailable/
        );
        expect(mockUpdateAlbumInDB).not.toHaveBeenCalled();
      });

      it('accepts a discogs-unavailable-only PATCH (satisfies the at-least-one-field guard)', async () => {
        const res = mockResponse();
        await updateAlbum(reqFor({ discogsUnavailable: true }), res, next);

        expect(res.status).toHaveBeenCalledWith(200);
        const updates = mockUpdateAlbumInDB.mock.calls[0][1];
        expect(updates).toMatchObject({ discogs_unavailable: true });
        // Flag-only (note untouched) leaves the existing note intact.
        expect(updates).not.toHaveProperty('discogs_unavailable_note');
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

  describe('getAlbum', () => {
    it('returns 200 with the album when album_id is provided (serial path)', async () => {
      mockGetAlbumFromDB.mockResolvedValue(fullAlbum);
      const req = { query: { album_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getAlbum(req, res, next);

      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(42);
      expect(mockGetAlbumByLegacyId).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(fullAlbum);
    });

    it('returns 400 when neither album_id nor legacy_release_id is provided', async () => {
      const req = { query: {} } as unknown as Request;
      const res = mockResponse();

      await expect(getAlbum(req, res, next)).rejects.toThrow('missing album identifier');
      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
    });

    it('resolves legacy_release_id and returns 200 with the album (serial in id)', async () => {
      mockGetAlbumByLegacyId.mockResolvedValue(fullAlbum);
      const req = { query: { legacy_release_id: '65880' } } as unknown as Request;
      const res = mockResponse();

      await getAlbum(req, res, next);

      expect(mockGetAlbumByLegacyId).toHaveBeenCalledWith(65880);
      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(fullAlbum);
    });

    it('prefers legacy_release_id over album_id when both are present', async () => {
      mockGetAlbumByLegacyId.mockResolvedValue(fullAlbum);
      const req = { query: { legacy_release_id: '65880', album_id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getAlbum(req, res, next);

      expect(mockGetAlbumByLegacyId).toHaveBeenCalledWith(65880);
      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
    });

    it('returns 404 when legacy_release_id resolves to no catalog row', async () => {
      mockGetAlbumByLegacyId.mockResolvedValue(undefined);
      const req = { query: { legacy_release_id: '999999999' } } as unknown as Request;
      const res = mockResponse();

      await expect(getAlbum(req, res, next)).rejects.toThrow('No catalog album for that legacy_release_id');
    });

    // '65880xyz' locks in strict Number() parsing (parseInt would have accepted
    // the leading digits); '0'/'-5' are non-positive; 'not-a-number' is NaN.
    it.each([['not-a-number'], ['0'], ['-5'], ['65880xyz']])(
      'returns 400 for an invalid legacy_release_id (%s)',
      async (bad) => {
        const req = { query: { legacy_release_id: bad } } as unknown as Request;
        const res = mockResponse();

        await expect(getAlbum(req, res, next)).rejects.toThrow('Invalid legacy_release_id');
        expect(mockGetAlbumByLegacyId).not.toHaveBeenCalled();
      }
    );

    it('returns 400 for a repeated legacy_release_id (Express yields string[]) (#1553-style guard)', async () => {
      // Number(['1','2']) → Number("1,2") → NaN, so a fabricated partial id is
      // rejected rather than silently used.
      const req = { query: { legacy_release_id: ['1', '2'] } } as unknown as Request;
      const res = mockResponse();

      await expect(getAlbum(req, res, next)).rejects.toThrow('Invalid legacy_release_id');
      expect(mockGetAlbumByLegacyId).not.toHaveBeenCalled();
    });
  });

  describe('manualDiscogsRecheck (BS#1283)', () => {
    const flaggedRow = {
      id: 42,
      artist_name: 'Chuquimamani-Condori',
      album_title: 'Edits',
      discogs_unavailable: true,
      discogs_unavailable_note: 'embargoed promo',
    };

    beforeEach(() => {
      mockIsLmlConfigured.mockReturnValue(true);
    });

    it('returns 400 for a non-numeric id', async () => {
      const req = { params: { id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(manualDiscogsRecheck(req, res, next)).rejects.toThrow('Invalid album ID');
      expect(mockGetLibraryRowById).not.toHaveBeenCalled();
    });

    it('returns 404 when the album does not exist', async () => {
      mockGetLibraryRowById.mockResolvedValue(undefined);
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(manualDiscogsRecheck(req, res, next)).rejects.toThrow('Album not found');
      expect(mockRecheckDiscogsAvailability).not.toHaveBeenCalled();
    });

    it('returns 400 when the row has no artist_name/album_title to look up', async () => {
      mockGetLibraryRowById.mockResolvedValue({ ...flaggedRow, artist_name: null, album_title: null });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await expect(manualDiscogsRecheck(req, res, next)).rejects.toThrow(
        'Cannot recheck a release without artist_name and album_title'
      );
      expect(mockRecheckDiscogsAvailability).not.toHaveBeenCalled();
    });

    it('returns 503 when LML is not configured', async () => {
      mockGetLibraryRowById.mockResolvedValue(flaggedRow);
      mockIsLmlConfigured.mockReturnValue(false);
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await expect(manualDiscogsRecheck(req, res, next)).rejects.toThrow('LML is not configured');
      expect(mockRecheckDiscogsAvailability).not.toHaveBeenCalled();
    });

    it('returns the matched outcome shape', async () => {
      mockGetLibraryRowById.mockResolvedValue(flaggedRow);
      mockRecheckDiscogsAvailability.mockResolvedValue({
        outcome: 'matched',
        discogsReleaseId: 99999,
        confidence: 0.98,
      });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await manualDiscogsRecheck(req, res, next);

      expect(mockRecheckDiscogsAvailability).toHaveBeenCalledWith(42, 'Chuquimamani-Condori', 'Edits');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ outcome: 'matched', discogsReleaseId: 99999, confidence: 0.98 });
    });

    it('returns the low_confidence_match outcome shape', async () => {
      mockGetLibraryRowById.mockResolvedValue(flaggedRow);
      mockRecheckDiscogsAvailability.mockResolvedValue({ outcome: 'low_confidence_match', confidence: 0.85 });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await manualDiscogsRecheck(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ outcome: 'low_confidence_match', confidence: 0.85 });
    });

    it('returns the no_match outcome shape', async () => {
      mockGetLibraryRowById.mockResolvedValue(flaggedRow);
      mockRecheckDiscogsAvailability.mockResolvedValue({ outcome: 'no_match' });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await manualDiscogsRecheck(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ outcome: 'no_match' });
    });
  });

  describe('deleteAlbum (BS#2112)', () => {
    it('returns 400 for a non-numeric id', async () => {
      const req = { params: { id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(deleteAlbum(req, res, next)).rejects.toThrow('Invalid album ID');
      expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-positive id', async () => {
      const req = { params: { id: '0' } } as unknown as Request;
      const res = mockResponse();

      await expect(deleteAlbum(req, res, next)).rejects.toThrow('Invalid album ID');
      expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
    });

    it('returns 404 when the album does not exist', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'not_found' });
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(deleteAlbum(req, res, next)).rejects.toThrow('Album not found');
      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(999);
    });

    it('refuses with 409 and names the play count when the release carries flowsheet plays', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 59,
        directPlayCount: 59,
        rotationLinkedPlayCount: 0,
      });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await deleteAlbum(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        message: expect.stringContaining('59'),
        reason: 'flowsheet_references',
        play_count: 59,
        direct_play_count: 59,
        rotation_linked_play_count: 0,
      });
    });

    it('uses singular phrasing for exactly one flowsheet play', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 1,
        directPlayCount: 1,
        rotationLinkedPlayCount: 0,
      });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await deleteAlbum(req, res, next);

      const body = (res.json as jest.Mock).mock.calls[0][0] as { message: string };
      expect(body.message).not.toContain('1 plays');
    });

    // The transitive path (BS#2112 review finding 3): plays that reach the
    // release only through `flowsheet.rotation_id` -> `rotation.album_id`.
    // A librarian looking at a release with zero directly-linked plays would
    // otherwise have no way to understand the refusal.
    it('spells out the split when plays arrive via the rotation entry', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 12,
        directPlayCount: 0,
        rotationLinkedPlayCount: 12,
      });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await deleteAlbum(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as jest.Mock).mock.calls[0][0] as {
        message: string;
        play_count: number;
        direct_play_count: number;
        rotation_linked_play_count: number;
      };
      expect(body.play_count).toBe(12);
      expect(body.direct_play_count).toBe(0);
      expect(body.rotation_linked_play_count).toBe(12);
      expect(body.message).toContain('rotation entry');
    });

    it('omits the split when every play is linked directly', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 4,
        directPlayCount: 4,
        rotationLinkedPlayCount: 0,
      });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await deleteAlbum(req, res, next);

      const body = (res.json as jest.Mock).mock.calls[0][0] as { message: string };
      expect(body.message).not.toContain('rotation entry');
    });

    it('returns 204 with no body on success', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'deleted' });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();
      res.end = jest.fn().mockReturnValue(res) as unknown as Response['end'];

      await deleteAlbum(req, res, next);

      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
