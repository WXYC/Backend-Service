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
// GET /library/artists/by-code (BS#2149).
const mockGetArtistsByCode =
  jest.fn<(codeLetters: string, genreId: number, codeNumber: number) => Promise<ArtistConflictRow[]>>();
const mockGenreExists = jest.fn<(genreId: number) => Promise<boolean>>();
const mockGenerateArtistNumber = jest.fn<(codeLetters: string, genreId: number) => Promise<number>>();
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

// GET /library/rotation, POST /library/rotation, PATCH /library/rotation,
// GET /library/rotation/uncatalogued, PATCH /library/rotation/:id/link (BS#2109).
const mockGetRotationFromDB = jest.fn<() => Promise<unknown[]>>();
const mockAddToRotation = jest.fn<(fields: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const mockKillRotationInDB = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockGetUncataloguedRotationFromDB = jest.fn<(page?: { limit?: number; offset?: number }) => Promise<unknown[]>>();
type LinkRotationOutcomeMock =
  | { outcome: 'linked'; rotation: Record<string, unknown> }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'already_linked' }
  | { outcome: 'album_not_found' };
const mockLinkRotationToAlbum = jest.fn<(rotationId: number, albumId: number) => Promise<LinkRotationOutcomeMock>>();

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

// GET/PATCH /library/artists/:id + GET /library/artists/:id/releases (BS#2156).
type ArtistCardMock = {
  artist_id: number;
  artist_name: string;
  alphabetical_name: string;
  genre_id: number;
  code_letters: string;
  code_artist_number: number;
};
const mockGetArtistCardById = jest.fn<(artistId: number) => Promise<ArtistCardMock | null>>();
const mockUpdateArtistInDB =
  jest.fn<
    (
      artistId: number,
      updates: Record<string, unknown>
    ) => Promise<{ id: number; artist_name: string; alphabetical_name: string } | undefined>
  >();
type ArtistReleaseRowMock = {
  id: number;
  last_modified: Date;
  format_name: string;
  genre_id: number;
  code_letters: string;
  code_artist_number: number;
  code_number: number;
  code_volume_letters: string | null;
  album_title: string;
  alternate_artist_name: string | null;
};
const mockGetReleasesForArtist =
  jest.fn<(artistId: number, page: number, limit: number) => Promise<ArtistReleaseRowMock[]>>();
const mockCountReleasesForArtist = jest.fn<(artistId: number) => Promise<number>>();
// PATCH /library/rotation/:id (updateRotation, BS#2113). The service now
// resolves a compare-and-set outcome (review finding 4) rather than a bare
// row, so the controller can't tell "not found" apart from "linked
// concurrently" by re-reading the row itself.
type UpdateRotationOutcome =
  | { outcome: 'updated'; rotation: Record<string, unknown> }
  | { outcome: 'not_found' }
  | { outcome: 'linked_conflict'; albumId: number };
const mockUpdateRotation = jest.fn<(id: number, updates: Record<string, unknown>) => Promise<UpdateRotationOutcome>>();
const mockIsISODate = jest.fn<(date: string) => boolean>();

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
  (
    id: number,
    actor?: { userId?: string | null; email?: string | null; role?: string | null }
  ) => Promise<
    | { outcome: 'deleted' }
    | { outcome: 'not_found' }
    | { outcome: 'lock_unavailable' }
    | {
        outcome: 'has_flowsheet_plays';
        playCount: number;
        directPlayCount: number;
        rotationLinkedPlayCount: number;
        legacyLinkedPlayCount: number;
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
  getRotationFromDB: mockGetRotationFromDB,
  addToRotation: mockAddToRotation,
  killRotationInDB: mockKillRotationInDB,
  // Real projection, not a stub: the controller now routes its 200 through
  // this, so a pass-through mock would assert a shape the endpoint no longer
  // returns. Mirrors `UNCATALOGUED_ROTATION_PROJECTION`'s key set. (Value and
  // helper exports going missing from these hand-maintained mocks is the
  // recurring hazard tracked in WXYC/Backend-Service#2209.)
  ROTATION_SNAPSHOT_COLUMNS: ['artist_name', 'album_title', 'record_label'] as const,
  toRotationRowSummary: (row) =>
    Object.fromEntries(
      ['id', 'album_id', 'rotation_bin', 'add_date', 'kill_date', 'artist_name', 'album_title', 'record_label'].map(
        (key) => [key, row?.[key]]
      )
    ),
  getUncataloguedRotationFromDB: mockGetUncataloguedRotationFromDB,
  // Not a function — a real value export the controller destructures at module
  // load for its 400 message and bound check. Omitting it makes the ceiling
  // `undefined`, so `limit > undefined` is false and every over-limit request
  // silently 200s.
  UNCATALOGUED_ROTATION_MAX_LIMIT: 500,
  linkRotationToAlbum: mockLinkRotationToAlbum,
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
  getArtistsByCode: mockGetArtistsByCode,
  genreExists: mockGenreExists,
  getArtistById: mockGetArtistById,
  generateAlbumCodeNumber: mockGenerateAlbumCodeNumber,
  generateArtistNumber: mockGenerateArtistNumber,
  getGenresFromDB: jest.fn(),
  insertGenre: jest.fn(),
  insertFormat: jest.fn(),
  getFormatById: mockGetFormatById,
  isISODate: mockIsISODate,
  resolveRotationPickerSource: mockResolveRotationPickerSource,
  getRotationTracksFromRelease: mockGetRotationTracksFromRelease,
  getLibraryRowById: mockGetLibraryRowById,
  updateAlbumInDB: mockUpdateAlbumInDB,
  artistExistsInGenre: mockArtistExistsInGenre,
  albumCodeNumberTaken: mockAlbumCodeNumberTaken,
  recheckDiscogsAvailability: mockRecheckDiscogsAvailability,
  deleteAlbumFromDB: mockDeleteAlbumFromDB,
  getArtistCardById: mockGetArtistCardById,
  updateArtistInDB: mockUpdateArtistInDB,
  getReleasesForArtist: mockGetReleasesForArtist,
  countReleasesForArtist: mockCountReleasesForArtist,
  updateRotation: mockUpdateRotation,
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
  resolveArtistByCode,
  peekArtistNumber,
  getAlbum,
  getRotationTracks,
  updateAlbum,
  searchLibraryQueryEndpoint,
  manualDiscogsRecheck,
  deleteAlbum,
  addRotation,
  getUncataloguedRotation,
  linkRotationToAlbum,
  pickAddRotationFields,
  getArtistCard,
  updateArtistCard,
  getArtistReleases,
  updateRotation,
} from '../../../apps/backend/controllers/library.controller';
import WxycError from '../../../apps/backend/utils/error';

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

  // GET /library/artists/by-code (BS#2149).
  describe('resolveArtistByCode', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetArtistsByCode.mockResolvedValue([]);
      mockGenreExists.mockResolvedValue(true);
    });

    const req = (query: Record<string, unknown> = {}) =>
      ({
        query: {
          genre_id: '11',
          code_letters: 'BU',
          code_number: '60',
          ...query,
        },
      }) as unknown as Request;

    const owner = (id: number, artist_name: string, code_letters = 'BU') => ({
      artist_id: id,
      artist_name,
      code_letters,
    });

    it('returns the sole owner of an uncontested code as a one-element list', async () => {
      mockGetArtistsByCode.mockResolvedValue([owner(9, 'Built to Spill')]);

      const res = mockResponse();
      await resolveArtistByCode(req(), res, next);

      expect(mockGetArtistsByCode).toHaveBeenCalledWith('BU', 11, 60);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        artists: [{ id: 9, artist_name: 'Built to Spill', code_letters: 'BU', code_number: 60, genre_id: 11 }],
      });
    });

    // Contested codes are NOT a V/A-only phenomenon: 11 of the 13 collisions in
    // the production clone are ordinary artist codes (`KU`/11/7 has 3 owners).
    // A V/A-gated special case would answer one arbitrary row for those, so the
    // list treatment has to be unconditional.
    it('returns every owner of a contested ORDINARY code, not only V/A codes', async () => {
      mockGetArtistsByCode.mockResolvedValue([
        owner(301, 'Kudzu', 'KU'),
        owner(302, 'Kudzu Ranch', 'KU'),
        owner(303, 'Kukuruza', 'KU'),
      ]);

      const res = mockResponse();
      await resolveArtistByCode(req({ genre_id: '11', code_letters: 'KU', code_number: '7' }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const [payload] = (res.json as jest.Mock).mock.calls[0] as [{ artists: Array<{ id: number }> }];
      expect(payload.artists.map((a) => a.id)).toEqual([301, 302, 303]);
    });

    // The V/A invariant: `V/A`/12/0 has 27 owners in the production clone and
    // each is a distinct shelf bucket. Collapsing or arbitrarily picking one
    // would be stably wrong for the other 26.
    it('returns EVERY owner of a contested code, not just the first', async () => {
      const buckets = [
        owner(101, 'Soundtracks - A', 'V/A'),
        owner(102, 'Soundtracks - B', 'V/A'),
        owner(103, 'Soundtracks - C', 'V/A'),
      ];
      mockGetArtistsByCode.mockResolvedValue(buckets);

      const res = mockResponse();
      await resolveArtistByCode(req({ genre_id: '12', code_letters: 'V/A', code_number: '0' }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const [payload] = (res.json as jest.Mock).mock.calls[0] as [{ artists: Array<{ id: number }> }];
      expect(payload.artists).toHaveLength(3);
      expect(payload.artists.map((a) => a.id)).toEqual([101, 102, 103]);
      expect(payload.artists.map((a) => a.artist_name)).toEqual([
        'Soundtracks - A',
        'Soundtracks - B',
        'Soundtracks - C',
      ]);
    });

    // The entire Various-Artists surface is filed at artist_genre_code 0 (68
    // rows in the production clone). A `< 1` floor made the one filing class
    // that most needs code-first resolution unanswerable.
    it('accepts code_number 0 (the Various-Artists filing) and passes it through unchanged', async () => {
      mockGetArtistsByCode.mockResolvedValue([owner(200, 'Various Artists', 'V/A')]);

      const res = mockResponse();
      await resolveArtistByCode(req({ genre_id: '11', code_letters: 'V/A', code_number: '0' }), res, next);

      expect(mockGetArtistsByCode).toHaveBeenCalledWith('V/A', 11, 0);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        artists: [{ id: 200, artist_name: 'Various Artists', code_letters: 'V/A', code_number: 0, genre_id: 11 }],
      });
    });

    it('rejects a negative code_number', async () => {
      const res = mockResponse();

      await expect(resolveArtistByCode(req({ code_number: '-1' }), res, next)).rejects.toThrow('code_number');
      expect(mockGetArtistsByCode).not.toHaveBeenCalled();
    });

    it('rejects a non-integer code_number', async () => {
      const res = mockResponse();

      await expect(resolveArtistByCode(req({ code_number: '3.5' }), res, next)).rejects.toThrow('code_number');
      expect(mockGetArtistsByCode).not.toHaveBeenCalled();
    });

    // `Number('')` is 0, which now passes Number.isInteger and the >= 0 floor,
    // so a present-but-blank parameter would silently resolve as a V/A lookup.
    it('rejects a present-but-blank code_number rather than reading it as 0', async () => {
      const res = mockResponse();

      await expect(resolveArtistByCode(req({ code_number: '' }), res, next)).rejects.toThrow('code_number');
      expect(mockGetArtistsByCode).not.toHaveBeenCalled();
    });

    it('rejects genre_id 0 (genre ids start at 1)', async () => {
      const res = mockResponse();

      await expect(resolveArtistByCode(req({ genre_id: '0' }), res, next)).rejects.toThrow('genre_id');
      expect(mockGetArtistsByCode).not.toHaveBeenCalled();
    });

    // BS#1800 class: parses as a JS integer, overflows the int4 column, and
    // used to reach Postgres as SQLSTATE 22003 -> unhandled 500 + Sentry noise.
    describe('int4-bounds validation (BS#1800 class)', () => {
      it('rejects a genre_id above INT4_MAX with a 400 naming genre_id', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ genre_id: '2147483648' }), res, next)).rejects.toThrow('genre_id');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      it('rejects a code_number above INT4_MAX with a 400 naming code_number', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_number: '2147483648' }), res, next)).rejects.toThrow('code_number');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      it('rejects an overflowing parameter with a WxycError (400), never an unhandled error', async () => {
        const res = mockResponse();

        // The status code is the whole point of the test's name: a
        // `WxycError` carrying 500 would satisfy a bare `toBeInstanceOf` while
        // being exactly the outcome this guard exists to prevent.
        const thrown = await resolveArtistByCode(req({ code_number: '9999999999' }), res, next).then(
          () => null,
          (error: unknown) => error
        );
        expect(thrown).toBeInstanceOf(WxycError);
        expect((thrown as WxycError).statusCode).toBe(400);
      });

      it('still accepts values exactly at the INT4_MAX boundary', async () => {
        mockGetArtistsByCode.mockResolvedValue([owner(1, 'Edge Case')]);
        const res = mockResponse();

        await resolveArtistByCode(req({ genre_id: '2147483647', code_number: '2147483647' }), res, next);

        expect(mockGetArtistsByCode).toHaveBeenCalledWith('BU', 2147483647, 2147483647);
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe('404 discrimination', () => {
      it('answers reason: genre_not_found when the genre does not exist', async () => {
        mockGetArtistsByCode.mockResolvedValue([]);
        mockGenreExists.mockResolvedValue(false);

        const res = mockResponse();
        await resolveArtistByCode(req({ genre_id: '999999' }), res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ message: 'Genre not found', reason: 'genre_not_found' });
      });

      it('answers reason: code_not_assigned when the genre exists but the code is free', async () => {
        mockGetArtistsByCode.mockResolvedValue([]);
        mockGenreExists.mockResolvedValue(true);

        const res = mockResponse();
        await resolveArtistByCode(req({ code_number: '999999' }), res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Artist code not assigned in that genre',
          reason: 'code_not_assigned',
        });
      });

      it('gives the two 404s different reasons, so a client never has to parse the message', async () => {
        const missReasons: string[] = [];
        for (const genreKnown of [false, true]) {
          jest.clearAllMocks();
          mockGetArtistsByCode.mockResolvedValue([]);
          mockGenreExists.mockResolvedValue(genreKnown);
          const res = mockResponse();
          await resolveArtistByCode(req(), res, next);
          const [payload] = (res.json as jest.Mock).mock.calls[0] as [{ reason: string }];
          missReasons.push(payload.reason);
        }

        expect(new Set(missReasons).size).toBe(2);
      });
    });

    describe('code_letters normalization', () => {
      it.each([
        ['lower-cased', 'bu'],
        ['whitespace-padded', ' BU '],
        ['both', ' bu '],
      ])('trims and upper-cases a %s code_letters before matching', async (_label, raw) => {
        mockGetArtistsByCode.mockResolvedValue([owner(9, 'Built to Spill')]);

        const res = mockResponse();
        await resolveArtistByCode(req({ code_letters: raw }), res, next);

        expect(mockGetArtistsByCode).toHaveBeenCalledWith('BU', 11, 60);
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('rejects code_letters that is empty once trimmed', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: '   ' }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });
    });

    // BS#2149 review findings 1 + 2: `artists.code_letters` is a Postgres
    // varchar(4) column and neither writer (insertArtist, the tubafrenzy
    // library-etl job) guarantees a trimmed/upper-case/ASCII-only value, so a
    // bare `.trim().toUpperCase()` isn't a safe read-side repair -- it can
    // fold a non-canonical input onto a DIFFERENT real artist's code (`ß` ->
    // `SS`, `ı` -> `I`) with no precondition that the input was canonical.
    // These pin the domain check that replaced the naive normalization.
    describe('code_letters domain validation (BS#2149 review findings 1 + 2)', () => {
      it('rejects a code_letters longer than 4 characters (varchar(4) domain)', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: 'ABCDE' }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      it('rejects a code_letters that is exactly 5 characters after trimming', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: ' ABCDE ' }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      it('accepts a code_letters at the 4-character boundary', async () => {
        mockGetArtistsByCode.mockResolvedValue([owner(9, 'Built to Spill', 'ABCD')]);
        const res = mockResponse();

        await resolveArtistByCode(req({ code_letters: 'ABCD' }), res, next);

        expect(mockGetArtistsByCode).toHaveBeenCalledWith('ABCD', 11, 60);
        expect(res.status).toHaveBeenCalledWith(200);
      });

      // `'ß'.toUpperCase() === 'SS'` -- not length-preserving. Left
      // unvalidated, this would silently query for 'SS' instead of rejecting
      // an input the column's real (ASCII) domain never contains.
      it('rejects a code_letters containing ß rather than silently folding it to SS', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: 'ß' }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      // `'ı'.toUpperCase() === 'I'` (the Turkish dotless i) -- length-preserving
      // but charset-changing, so a length check alone would miss this case.
      it('rejects a code_letters containing the dotless-i (ı) rather than folding it to I', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: 'ı' }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      it('accepts the V/A code, whose "/" is the one non-alphanumeric character in production use', async () => {
        mockGetArtistsByCode.mockResolvedValue([owner(200, 'Various Artists', 'V/A')]);
        const res = mockResponse();

        await resolveArtistByCode(req({ code_letters: 'V/A' }), res, next);

        expect(mockGetArtistsByCode).toHaveBeenCalledWith('V/A', 11, 60);
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('rejects a code_letters containing a character outside A-Z, 0-9, and /', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: 'B-U' }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });
    });

    describe('repeated-key (Express string[]) parsing', () => {
      it('rejects a repeated code_letters before it can bind a text[] against a text column', async () => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ code_letters: ['B', 'U'] }), res, next)).rejects.toThrow('code_letters');
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });

      it.each([['genre_id'], ['code_number']])('rejects a repeated %s by name', async (param) => {
        const res = mockResponse();

        await expect(resolveArtistByCode(req({ [param]: ['1', '2'] }), res, next)).rejects.toThrow(param);
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });
    });

    describe('missing parameters', () => {
      const ALL_PARAMS = ['genre_id', 'code_letters', 'code_number'] as const;

      // Each case omits exactly one parameter and asserts the message names THAT
      // one and none of the others. A message listing all three would satisfy a
      // `toContain('code_number')` assertion no matter which parameter the
      // handler actually refused on -- the blind spot this suite had before.
      it.each(ALL_PARAMS.map((p) => [p]))('names %s, and only %s, when it is the missing one', async (param) => {
        const full: Array<[string, string]> = [
          ['genre_id', '11'],
          ['code_letters', 'BU'],
          ['code_number', '60'],
        ];
        const query = Object.fromEntries(full.filter(([name]) => name !== param));
        const res = mockResponse();

        const thrown = await resolveArtistByCode({ query } as unknown as Request, res, next).then(
          () => null,
          (err: unknown) => err
        );

        expect(thrown).toBeInstanceOf(WxycError);
        expect((thrown as WxycError).statusCode).toBe(400);
        expect((thrown as WxycError).message).toContain(param);
        for (const other of ALL_PARAMS.filter((p) => p !== param)) {
          expect((thrown as WxycError).message).not.toContain(other);
        }
        expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      });
    });

    // Finding 6: genreExists is only needed to explain a miss. A hit proves the
    // genre exists, because the lookup inner-joins on genre_artist_crossreference
    // .genre_id -- so probing it up front doubles the round-trips on the path
    // that is taken every time a librarian types a real code.
    describe('round-trip discipline', () => {
      it('does not probe genreExists on a hit', async () => {
        mockGetArtistsByCode.mockResolvedValue([owner(9, 'Built to Spill')]);

        const res = mockResponse();
        await resolveArtistByCode(req(), res, next);

        expect(mockGenreExists).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('probes genreExists exactly once on a miss', async () => {
        mockGetArtistsByCode.mockResolvedValue([]);

        const res = mockResponse();
        await resolveArtistByCode(req(), res, next);

        expect(mockGenreExists).toHaveBeenCalledTimes(1);
        expect(mockGenreExists).toHaveBeenCalledWith(11);
      });
    });
  });

  // The sibling this endpoint was NOT folded into. `peekArtistNumber` reads
  // exactly two query parameters, and these pin that: it must call the service
  // with (code_letters, genre_id) and nothing else, for every call shape
  // dj-site sends -- including one carrying a stray `code_number`.
  describe('peekArtistNumber two-parameter contract (BS#2149 regression)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGenerateArtistNumber.mockResolvedValue(61);
    });

    it('calls generateArtistNumber with exactly (code_letters, genre_id)', async () => {
      const res = mockResponse();
      await peekArtistNumber({ query: { code_letters: 'BU', genre_id: '11' } } as unknown as Request, res, next);

      expect(mockGenerateArtistNumber).toHaveBeenCalledTimes(1);
      expect(mockGenerateArtistNumber.mock.calls[0]).toEqual(['BU', 11]);
      expect(res.json).toHaveBeenCalledWith({ next_code_number: 61 });
    });

    it('ignores a code_number the by-code sibling would consume — same service call, same response', async () => {
      const res = mockResponse();
      await peekArtistNumber(
        { query: { code_letters: 'BU', genre_id: '11', code_number: '60' } } as unknown as Request,
        res,
        next
      );

      // Byte-identical to the two-parameter call above: the third parameter
      // reaches neither the service nor the response.
      expect(mockGenerateArtistNumber.mock.calls[0]).toEqual(['BU', 11]);
      expect(res.json).toHaveBeenCalledWith({ next_code_number: 61 });
      expect(mockGetArtistsByCode).not.toHaveBeenCalled();
    });

    it('does not route to the by-code resolver even when all three parameters are present', async () => {
      const res = mockResponse();
      await peekArtistNumber(
        { query: { code_letters: 'V/A', genre_id: '12', code_number: '0' } } as unknown as Request,
        res,
        next
      );

      expect(mockGenerateArtistNumber).toHaveBeenCalledTimes(1);
      expect(mockGetArtistsByCode).not.toHaveBeenCalled();
      expect(mockGenreExists).not.toHaveBeenCalled();
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

  describe('pickAddRotationFields (BS#2109)', () => {
    it('picks album_id and rotation_bin, dropping the snapshot trio, when album_id is present', () => {
      const picked = pickAddRotationFields({
        album_id: 5,
        rotation_bin: 'M',
        artist_name: 'Forged Artist',
        album_title: 'Forged Album',
        record_label: 'Forged Label',
      });

      expect(picked).toEqual({ album_id: 5, rotation_bin: 'M' });
    });

    it('picks the snapshot trio when album_id is absent', () => {
      const picked = pickAddRotationFields({
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
        record_label: 'Rough Trade',
      });

      expect(picked).toEqual({
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
        record_label: 'Rough Trade',
      });
    });

    it('omits record_label from the picked fields when not supplied (album_id absent)', () => {
      const picked = pickAddRotationFields({
        rotation_bin: 'S',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
      });

      expect(picked).toEqual({ rotation_bin: 'S', artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' });
    });

    // `album_id: null` is what `selected?.id ?? null` produces, and it must
    // behave identically to omitting the key. An `=== undefined` test took
    // the has-an-album_id branch and dropped the free text on the floor.
    it('treats an explicit album_id: null exactly as absent and still picks the snapshot trio', () => {
      const picked = pickAddRotationFields({
        album_id: null,
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
        record_label: 'Rough Trade',
      });

      expect(picked).toEqual({
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
        record_label: 'Rough Trade',
      });
      expect(picked).not.toHaveProperty('album_id');
    });

    it('drops explicitly-null snapshot fields rather than writing NULL over them', () => {
      const picked = pickAddRotationFields({
        album_id: null,
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
        record_label: null,
      });

      expect(picked).toEqual({ rotation_bin: 'L', artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' });
    });
  });

  describe('addRotation (BS#2109)', () => {
    beforeEach(() => {
      mockAddToRotation.mockReset();
    });

    it('returns 400 when rotation_bin is missing', async () => {
      const req = { body: { album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await expect(addRotation(req, res, next)).rejects.toThrow('Missing Parameters');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('returns 400 when neither album_id nor the artist_name/album_title pair is given', async () => {
      const req = { body: { rotation_bin: 'M' } } as unknown as Request;
      const res = mockResponse();

      await expect(addRotation(req, res, next)).rejects.toThrow('Missing Parameters');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('returns 400 when only artist_name is given (album_title also required)', async () => {
      const req = { body: { rotation_bin: 'M', artist_name: 'Jockstrap' } } as unknown as Request;
      const res = mockResponse();

      await expect(addRotation(req, res, next)).rejects.toThrow('Missing Parameters');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('accepts a catalogued rotation add (album_id present, no free text needed)', async () => {
      mockAddToRotation.mockResolvedValue({ id: 1, album_id: 5, rotation_bin: 'M' });
      const req = { body: { album_id: 5, rotation_bin: 'M' } } as unknown as Request;
      const res = mockResponse();

      await addRotation(req, res, next);

      expect(mockAddToRotation).toHaveBeenCalledWith({ album_id: 5, rotation_bin: 'M' });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('accepts an uncatalogued rotation add (no album_id, artist_name + album_title supplied)', async () => {
      mockAddToRotation.mockResolvedValue({
        id: 2,
        album_id: null,
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
      });
      const req = {
        body: { rotation_bin: 'L', artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' },
      } as unknown as Request;
      const res = mockResponse();

      await addRotation(req, res, next);

      expect(mockAddToRotation).toHaveBeenCalledWith({
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    // The `selected?.id ?? null` client shape. Before the fix this returned
    // 201 having silently discarded artist_name/album_title, leaving a row
    // that no longer identifies anything and that `PATCH .../link` cannot
    // usefully repair.
    it('accepts an uncatalogued add sent as album_id: null, keeping the free text', async () => {
      mockAddToRotation.mockResolvedValue({ id: 3, album_id: null, rotation_bin: 'L' });
      const req = {
        body: { album_id: null, rotation_bin: 'L', artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' },
      } as unknown as Request;
      const res = mockResponse();

      await addRotation(req, res, next);

      expect(mockAddToRotation).toHaveBeenCalledWith({
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: 'I Love You Jennifer B',
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns 400 for album_id: null with no artist_name/album_title pair (does not slip past the guard)', async () => {
      const req = { body: { album_id: null, rotation_bin: 'L' } } as unknown as Request;
      const res = mockResponse();

      await expect(addRotation(req, res, next)).rejects.toThrow('Missing Parameters');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('returns 400 when rotation_bin is explicitly null', async () => {
      const req = { body: { rotation_bin: null, album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await expect(addRotation(req, res, next)).rejects.toThrow('Missing Parameters: rotation_bin');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    // There is no `0` sentinel on rotation.album_id — it FKs library.id,
    // a serial starting at 1. `0` is the literal payload the classic
    // /wxycdb rotation form posts; unguarded it dropped the free text and
    // then 23503'd into an opaque 500.
    it('returns 400 for album_id: 0 rather than dropping the free text into an FK violation', async () => {
      const req = {
        body: { album_id: 0, rotation_bin: 'L', artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' },
      } as unknown as Request;
      const res = mockResponse();

      await expect(addRotation(req, res, next)).rejects.toThrow('album_id must be a positive integer');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('returns 400 for a negative or non-integer album_id', async () => {
      const res = mockResponse();

      await expect(
        addRotation({ body: { album_id: -1, rotation_bin: 'L' } } as unknown as Request, res, next)
      ).rejects.toThrow('album_id must be a positive integer');
      await expect(
        addRotation({ body: { album_id: 1.5, rotation_bin: 'L' } } as unknown as Request, res, next)
      ).rejects.toThrow('album_id must be a positive integer');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    // Review round 3 finding 7: `Number.isInteger` tightens the pre-existing
    // catalogued path too, not just the new uncatalogued one — a numeric
    // *string* `album_id` previously inserted fine (PostgreSQL coerces on
    // the way into an `integer` column) and now 400s. Deliberately kept:
    // dj-site's `addRotationEntry` call site is typed `number` end to end
    // (`AddRotationRequest` from the shared OpenAPI contract, sourced from
    // `AlbumEntry.id: number`), so the only known caller never sends this
    // shape — see `addRotation`'s docblock.
    it('returns 400 for a numeric-string album_id rather than relying on PostgreSQL coercion', async () => {
      const res = mockResponse();

      await expect(
        addRotation({ body: { album_id: '2', rotation_bin: 'M' } } as unknown as Request, res, next)
      ).rejects.toThrow('album_id must be a positive integer');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('returns 400 when a blank/whitespace-only artist_name or album_title is supplied', async () => {
      const res = mockResponse();

      await expect(
        addRotation(
          { body: { rotation_bin: 'L', artist_name: '   ', album_title: 'Real Title' } } as unknown as Request,
          res,
          next
        )
      ).rejects.toThrow('Missing Parameters');
      await expect(
        addRotation(
          { body: { rotation_bin: 'L', artist_name: 'Real Artist', album_title: '' } } as unknown as Request,
          res,
          next
        )
      ).rejects.toThrow('Missing Parameters');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    // The three snapshot columns are varchar(128). Without a guard, PG
    // raises 22001 and the librarian gets a 500 naming no field.
    it.each(['artist_name', 'album_title', 'record_label'])(
      'returns a field-naming 400 when %s exceeds 128 characters',
      async (field) => {
        const body: Record<string, unknown> = {
          rotation_bin: 'L',
          artist_name: 'Jockstrap',
          album_title: 'I Love You Jennifer B',
        };
        body[field] = 'x'.repeat(129);
        const res = mockResponse();

        await expect(addRotation({ body } as unknown as Request, res, next)).rejects.toThrow(
          `${field} exceeds the 128-character limit`
        );
        expect(mockAddToRotation).not.toHaveBeenCalled();
      }
    );

    it('accepts a snapshot field at exactly 128 characters', async () => {
      mockAddToRotation.mockResolvedValue({ id: 4, album_id: null, rotation_bin: 'L' });
      const title = 'y'.repeat(128);
      const res = mockResponse();

      await addRotation(
        { body: { rotation_bin: 'L', artist_name: 'Jockstrap', album_title: title } } as unknown as Request,
        res,
        next
      );

      expect(mockAddToRotation).toHaveBeenCalledWith({
        rotation_bin: 'L',
        artist_name: 'Jockstrap',
        album_title: title,
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    // Review round 3 finding 6: `varchar(128)` is a PostgreSQL *character*
    // (code point) limit, but `String.prototype.length` counts UTF-16 code
    // units — every astral character (emoji, CJK Extension B, …) counts as
    // 2. 70 astral code points is a value PostgreSQL accepts outright, but
    // `.length` reads it as 140 and would 400 it — undercutting this
    // endpoint's own reject-over-truncate rationale (a guard that rejects
    // something PG would have stored is not the guard the docblock argues
    // for). Never the reverse: a bare `.length` only ever over-counts, so
    // there was no 22001 escape either way.
    it('accepts a 70-character astral-plane (emoji) artist_name even though .length reads it as 140', async () => {
      mockAddToRotation.mockResolvedValue({ id: 6, album_id: null, rotation_bin: 'L' });
      const astralName = '🎸'.repeat(70);
      expect(astralName.length).toBe(140);
      expect([...astralName].length).toBe(70);
      const res = mockResponse();

      await addRotation(
        {
          body: { rotation_bin: 'L', artist_name: astralName, album_title: 'I Love You Jennifer B' },
        } as unknown as Request,
        res,
        next
      );

      expect(mockAddToRotation).toHaveBeenCalledWith({
        rotation_bin: 'L',
        artist_name: astralName,
        album_title: 'I Love You Jennifer B',
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('rejects a 129-code-point astral-plane artist_name', async () => {
      const astralName = '🎸'.repeat(129);
      const res = mockResponse();

      await expect(
        addRotation(
          {
            body: { rotation_bin: 'L', artist_name: astralName, album_title: 'I Love You Jennifer B' },
          } as unknown as Request,
          res,
          next
        )
      ).rejects.toThrow('artist_name exceeds the 128-character limit');
      expect(mockAddToRotation).not.toHaveBeenCalled();
    });

    it('does not length-guard the snapshot trio when album_id is present (the trio is dropped anyway)', async () => {
      mockAddToRotation.mockResolvedValue({ id: 5, album_id: 7, rotation_bin: 'M' });
      const res = mockResponse();

      await addRotation(
        { body: { album_id: 7, rotation_bin: 'M', artist_name: 'z'.repeat(500) } } as unknown as Request,
        res,
        next
      );

      expect(mockAddToRotation).toHaveBeenCalledWith({ album_id: 7, rotation_bin: 'M' });
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('getUncataloguedRotation (BS#2109)', () => {
    beforeEach(() => {
      mockGetUncataloguedRotationFromDB.mockReset();
    });

    it('delegates to getUncataloguedRotationFromDB and returns 200', async () => {
      const rows = [{ id: 10, album_id: null, artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' }];
      mockGetUncataloguedRotationFromDB.mockResolvedValue(rows);
      const req = { query: {} } as unknown as Request;
      const res = mockResponse();

      await getUncataloguedRotation(req, res, next);

      expect(mockGetUncataloguedRotationFromDB).toHaveBeenCalledWith({ limit: undefined, offset: undefined });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(rows);
    });

    it('passes through a valid limit/offset window', async () => {
      mockGetUncataloguedRotationFromDB.mockResolvedValue([]);
      const req = { query: { limit: '50', offset: '100' } } as unknown as Request;
      const res = mockResponse();

      await getUncataloguedRotation(req, res, next);

      expect(mockGetUncataloguedRotationFromDB).toHaveBeenCalledWith({ limit: 50, offset: 100 });
    });

    it.each(['0', '501', 'abc', '10abc', '1.5', '-1'])('returns 400 for limit=%s', async (limit) => {
      const req = { query: { limit } } as unknown as Request;
      const res = mockResponse();

      await expect(getUncataloguedRotation(req, res, next)).rejects.toThrow('limit must be an integer');
      expect(mockGetUncataloguedRotationFromDB).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed offset', async () => {
      const req = { query: { offset: '10abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(getUncataloguedRotation(req, res, next)).rejects.toThrow('offset must be a non-negative integer');
      expect(mockGetUncataloguedRotationFromDB).not.toHaveBeenCalled();
    });
  });

  describe('linkRotationToAlbum (BS#2109)', () => {
    beforeEach(() => {
      mockLinkRotationToAlbum.mockReset();
    });

    it('returns 400 for a non-numeric rotation_id', async () => {
      const req = { params: { rotation_id: 'abc' }, body: { album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('positive integer');
      expect(mockLinkRotationToAlbum).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-positive rotation_id', async () => {
      const req = { params: { rotation_id: '0' }, body: { album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('positive integer');
    });

    // `parseInt('42abc', 10)` is 42, so the pre-fix parse let
    // `/library/rotation/42abc/link` mutate rotation 42.
    it.each(['42abc', ' 42', '4.5', '+42', '0x2a', '1e3'])(
      'returns 400 for the malformed rotation_id %s rather than coercing it',
      async (rotation_id) => {
        const req = { params: { rotation_id }, body: { album_id: 5 } } as unknown as Request;
        const res = mockResponse();

        await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('positive integer');
        expect(mockLinkRotationToAlbum).not.toHaveBeenCalled();
      }
    );

    it('returns 400 when album_id is missing', async () => {
      const req = { params: { rotation_id: '42' }, body: {} } as unknown as Request;
      const res = mockResponse();

      await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('Missing Parameters');
      expect(mockLinkRotationToAlbum).not.toHaveBeenCalled();
    });

    it('returns 200 with the updated row on success', async () => {
      mockLinkRotationToAlbum.mockResolvedValue({
        outcome: 'linked',
        rotation: { id: 42, album_id: 5, artist_name: null, album_title: null, record_label: null },
      });
      const req = { params: { rotation_id: '42' }, body: { album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await linkRotationToAlbum(req, res, next);

      expect(mockLinkRotationToAlbum).toHaveBeenCalledWith(42, 5);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        id: 42,
        album_id: 5,
        artist_name: null,
        album_title: null,
        record_label: null,
      });
    });

    it('returns 404 when the rotation row does not exist', async () => {
      mockLinkRotationToAlbum.mockResolvedValue({ outcome: 'rotation_not_found' });
      const req = { params: { rotation_id: '42' }, body: { album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('Rotation entry not found');
    });

    it('returns 404 when the album does not exist', async () => {
      mockLinkRotationToAlbum.mockResolvedValue({ outcome: 'album_not_found' });
      const req = { params: { rotation_id: '42' }, body: { album_id: 999999 } } as unknown as Request;
      const res = mockResponse();

      await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('Album not found');
    });

    it('returns 409 when the rotation row is already linked (rejects double-linking)', async () => {
      mockLinkRotationToAlbum.mockResolvedValue({ outcome: 'already_linked' });
      const req = { params: { rotation_id: '42' }, body: { album_id: 5 } } as unknown as Request;
      const res = mockResponse();

      await expect(linkRotationToAlbum(req, res, next)).rejects.toThrow('already linked');
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

    // BS#2212: the album_id branch parsed with a bare `parseInt`, so it had
    // none of the discipline the legacy branch above documents. The same
    // `parseResourceId` every other `/library/:id` route uses now guards it.
    const rejectedAlbumIds: Array<[string, string]> = [
      ['non-numeric', 'abc'],
      ['trailing garbage', '65880xyz'],
      ['empty', ''],
      ['zero', '0'],
      ['negative', '-5'],
      ['leading-zero padded', '007'],
      ['explicitly signed', '+42'],
      ['above INT4_MAX', '2147483648'],
      ['exponent notation', '1e21'],
      ['surrounded by whitespace', ' 42 '],
    ];

    it.each(rejectedAlbumIds)('returns 400 for an album_id that is %s', async (_label, rawId) => {
      const req = { query: { album_id: rawId } } as unknown as Request;

      await expect(getAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
    });

    // Pinned by value, not just by status. `parseInt('65880xyz')` is 65880, so
    // the failure this replaces did not error -- it fetched release 65880, a
    // real and different album, and served it with a 200. Asserting the status
    // alone would still pass if a future parse silently truncated again.
    it('never fetches the truncated id when album_id carries trailing garbage', async () => {
      const req = { query: { album_id: '65880xyz' } } as unknown as Request;

      await expect(getAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockGetAlbumFromDB).not.toHaveBeenCalledWith(65880);
    });

    it('returns 400 for a repeated album_id (Express yields string[])', async () => {
      // parseInt(['1','2']) is parseInt("1,2") = 1, so a request naming two
      // releases used to be served the first one.
      const req = { query: { album_id: ['1', '2'] } } as unknown as Request;

      await expect(getAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
    });

    // Matches the legacy branch's miss contract. Previously a 200 whose body
    // was `undefined` -- which satisfied no declared response schema, and
    // which all three consumers already routed to their error path anyway.
    it('returns 404 when album_id resolves to no catalog row', async () => {
      mockGetAlbumFromDB.mockResolvedValue(undefined);
      const req = { query: { album_id: '999999' } } as unknown as Request;

      await expect(getAlbum(req, mockResponse(), next)).rejects.toThrow('No catalog album for that album_id');
      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(999999);
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
      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(999, expect.any(Object));
    });

    it('refuses with 409 and names the play count when the release carries flowsheet plays', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 59,
        directPlayCount: 59,
        rotationLinkedPlayCount: 0,
        legacyLinkedPlayCount: 0,
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
        legacy_linked_play_count: 0,
      });
    });

    it('uses singular phrasing for exactly one flowsheet play', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 1,
        directPlayCount: 1,
        rotationLinkedPlayCount: 0,
        legacyLinkedPlayCount: 0,
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
        legacyLinkedPlayCount: 0,
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
        legacyLinkedPlayCount: 0,
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

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    // BS#2112 review finding 8: plays the tubafrenzy webhook wrote carrying
    // only `legacy_release_id`, which `jobs/legacy-linkage-resolve` has not yet
    // turned into an `album_id`. Deleting in that window strands them for
    // good, because the denylist means no future library row ever carries that
    // legacy id for the resolver to join to.
    it('spells out the split when plays are awaiting legacy-id linkage', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({
        outcome: 'has_flowsheet_plays',
        playCount: 3,
        directPlayCount: 0,
        rotationLinkedPlayCount: 0,
        legacyLinkedPlayCount: 3,
      });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await deleteAlbum(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as jest.Mock).mock.calls[0][0] as {
        message: string;
        legacy_linked_play_count: number;
      };
      expect(body.legacy_linked_play_count).toBe(3);
      expect(body.message).toContain('legacy release id');
      expect(body.message).not.toContain('rotation entry');
    });

    // BS#2112 review finding 7: the delete stands down rather than block a
    // live writer. 503, not 409 — 409 on this endpoint means "refused on the
    // merits", and this refusal says nothing about the release.
    it('returns a retryable 503 when the delete stood down on lock contention', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'lock_unavailable' });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await deleteAlbum(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        message: expect.stringContaining('Try again'),
        reason: 'lock_unavailable',
      });
    });

    // BS#2112 review finding 5: `catalog:write` is held by two roles, so
    // without an actor incident response cannot tell a legitimate deletion
    // from an abusive one.
    it('threads the authenticated subject through to the service', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'deleted' });
      const req = {
        params: { id: '42' },
        auth: { id: 'user-abc', email: 'md@wxyc.org', role: 'musicDirector' },
      } as unknown as Request;
      const res = mockResponse();
      res.end = jest.fn().mockReturnValue(res) as unknown as Response['end'];

      await deleteAlbum(req, res, next);

      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(42, {
        userId: 'user-abc',
        email: 'md@wxyc.org',
        role: 'musicDirector',
      });
    });

    it('falls back to the JWT `sub` claim when `id` is absent', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'deleted' });
      const req = {
        params: { id: '42' },
        auth: { sub: 'subject-xyz', email: 'sm@wxyc.org', role: 'stationManager' },
      } as unknown as Request;
      const res = mockResponse();
      res.end = jest.fn().mockReturnValue(res) as unknown as Response['end'];

      await deleteAlbum(req, res, next);

      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(42, expect.objectContaining({ userId: 'subject-xyz' }));
    });

    // A thin token (AUTH_BYPASS, or a payload with no claims) must cost the
    // audit trail, never the delete.
    it('still deletes when no auth payload is present, recording nulls', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'deleted' });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();
      res.end = jest.fn().mockReturnValue(res) as unknown as Response['end'];

      await deleteAlbum(req, res, next);

      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(42, { userId: null, email: null, role: null });
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });

  // The three BS#2156 routes share one path-id parser with PATCH /library/:id
  // and friends (`parseResourceId`). `artists.id` is a `serial` (int4), so an
  // id above INT4_MAX parses as a JS integer, reaches Postgres, and answers
  // 500 + a Sentry event where 404 is the honest answer (BS#1800); the
  // non-canonical spellings below each alias a distinct URL onto one resource
  // because `Number()` accepts them.
  describe('artist path-id parsing (BS#2156)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    const rejected: Array<[string, string]> = [
      ['non-numeric', 'abc'],
      ['above INT4_MAX', '2147483648'],
      ['exponent notation', '1e21'],
      ['hex notation', '0x2a'],
      ['surrounded by whitespace', ' 42 '],
      ['a trailing fraction', '42.0'],
      ['explicitly signed', '+42'],
      ['negative', '-42'],
      ['zero', '0'],
      ['leading-zero padded', '007'],
      ['empty', ''],
    ];

    it.each(rejected)('rejects an id that is %s with 400 on getArtistCard', async (_label, rawId) => {
      const req = { params: { id: rawId } } as unknown as Request;
      await expect(getArtistCard(req, mockResponse(), next)).rejects.toThrow('Invalid artist ID');
      expect(mockGetArtistCardById).not.toHaveBeenCalled();
    });

    it.each(rejected)('rejects an id that is %s with 400 on updateArtistCard', async (_label, rawId) => {
      const req = { params: { id: rawId }, body: { alphabetical_name: 'Anohni' } } as unknown as Request;
      await expect(updateArtistCard(req, mockResponse(), next)).rejects.toThrow('Invalid artist ID');
      expect(mockGetArtistCardById).not.toHaveBeenCalled();
    });

    it.each(rejected)('rejects an id that is %s with 400 on getArtistReleases', async (_label, rawId) => {
      const req = { params: { id: rawId }, query: {} } as unknown as Request;
      await expect(getArtistReleases(req, mockResponse(), next)).rejects.toThrow('Invalid artist ID');
      expect(mockGetArtistCardById).not.toHaveBeenCalled();
    });

    it('accepts an id exactly at INT4_MAX', async () => {
      mockGetArtistCardById.mockReset().mockResolvedValue(null);
      const req = { params: { id: '2147483647' } } as unknown as Request;

      await expect(getArtistCard(req, mockResponse(), next)).rejects.toThrow('Artist not found');
      expect(mockGetArtistCardById).toHaveBeenCalledWith(2147483647);
    });
  });

  // Review finding N3: `deleteAlbum`/`updateAlbum` share the same tightened
  // `parseResourceId` (`^[1-9][0-9]*$` + INT4_MAX, replacing a bare
  // `Number.isInteger` check) the artist routes above pin, but no test
  // exercised the tightened regex for them specifically -- the pre-existing
  // album-side tests only used 'abc', '0', '-5', all of which the OLD
  // implementation also rejected, so reverting `parseAlbumId` to
  // `Number.isInteger` would leave this suite green.
  describe('album path-id parsing (BS#2156 review N3)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    const rejectedAlbumIds: Array<[string, string]> = [
      ['non-numeric', 'abc'],
      ['above INT4_MAX', '2147483648'],
      ['exponent notation', '1e21'],
      ['hex notation', '0x10'],
      ['surrounded by whitespace', ' 16 '],
      ['a trailing fraction', '42.0'],
      ['explicitly signed', '+16'],
      ['negative', '-16'],
      ['zero', '0'],
      ['leading-zero padded', '016'],
      ['empty', ''],
    ];

    it.each(rejectedAlbumIds)('rejects an id that is %s with 400 on deleteAlbum', async (_label, rawId) => {
      const req = { params: { id: rawId } } as unknown as Request;
      await expect(deleteAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
    });

    it.each(rejectedAlbumIds)('rejects an id that is %s with 400 on updateAlbum', async (_label, rawId) => {
      const req = { params: { id: rawId }, body: { album_title: 'Some Title' } } as unknown as Request;
      await expect(updateAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockGetLibraryRowById).not.toHaveBeenCalled();
    });

    it('accepts an id exactly at INT4_MAX on deleteAlbum', async () => {
      mockDeleteAlbumFromDB.mockResolvedValue({ outcome: 'not_found' });
      const req = { params: { id: '2147483647' } } as unknown as Request;

      await expect(deleteAlbum(req, mockResponse(), next)).rejects.toThrow('Album not found');
      expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(2147483647, expect.any(Object));
    });

    it('rejects an id one past INT4_MAX on deleteAlbum', async () => {
      const req = { params: { id: '2147483648' } } as unknown as Request;

      await expect(deleteAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
    });

    it('accepts an id exactly at INT4_MAX on updateAlbum', async () => {
      mockGetLibraryRowById.mockResolvedValue(undefined);
      const req = {
        params: { id: '2147483647' },
        body: { album_title: 'Some Title' },
      } as unknown as Request;

      // Reaching the existence check (and its 'Album not found', not
      // 'Invalid album ID') proves the id parsed rather than being rejected.
      await expect(updateAlbum(req, mockResponse(), next)).rejects.toThrow('Album not found');
      expect(mockGetLibraryRowById).toHaveBeenCalledWith(2147483647);
    });

    it('rejects an id one past INT4_MAX on updateAlbum', async () => {
      const req = {
        params: { id: '2147483648' },
        body: { album_title: 'Some Title' },
      } as unknown as Request;

      await expect(updateAlbum(req, mockResponse(), next)).rejects.toThrow('Invalid album ID');
      expect(mockGetLibraryRowById).not.toHaveBeenCalled();
    });
  });

  describe('getArtistCard (BS#2156)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns 404 when the artist does not exist', async () => {
      mockGetArtistCardById.mockResolvedValue(null);
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(getArtistCard(req, res, next)).rejects.toThrow('Artist not found');
    });

    it('returns 200 with the card field set on success', async () => {
      const card = {
        artist_id: 42,
        artist_name: 'Chuquimamani-Condori',
        alphabetical_name: 'Chuquimamani-Condori',
        genre_id: 11,
        code_letters: 'CH',
        code_artist_number: 3,
      };
      mockGetArtistCardById.mockResolvedValue(card);
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await getArtistCard(req, res, next);

      expect(mockGetArtistCardById).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(card);
    });
  });

  describe('updateArtistCard (BS#2156)', () => {
    const existingCard: ArtistCardMock = {
      artist_id: 42,
      artist_name: 'Anohni',
      alphabetical_name: 'Anohni',
      genre_id: 11,
      code_letters: 'AN',
      code_artist_number: 3,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns 404 when the artist does not exist', async () => {
      mockGetArtistCardById.mockResolvedValue(null);
      const req = { params: { id: '999' }, body: { alphabetical_name: 'Anohni' } } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow('Artist not found');
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it('returns 400 when the body has no updatable fields', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = { params: { id: '42' }, body: {} } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow(
        'Bad Request: provide at least one of alphabetical_name'
      );
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    // `app.ts` mounts a bare `express.json()`; body-parser 2.x leaves
    // `req.body` undefined for a body-less or non-JSON request and Express 5
    // no longer defaults it to `{}`. Dereferencing it was a TypeError -> 500,
    // and because it happened AFTER the existence lookup, a nonexistent
    // artist 404'd (hiding the bug from exactly the smoke test that would
    // find it) while a real one 500'd.
    // Two groups, because the two failures are genuinely different and the
    // messages now say so. An absent or null body normalizes to `{}` — which
    // IS a JSON object, just an empty one — so the honest complaint is that it
    // carries no writable field. A string/array/number body never gets that
    // far: it is not an object at all, and telling that caller to "provide at
    // least one of alphabetical_name" sends them to inspect their fields when
    // the problem is their Content-Type.
    it.each([
      ['undefined (no body sent at all)', undefined],
      ['null', null],
    ])('returns 400 naming the missing field when the body is %s', async (_label, body) => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = { params: { id: '42' }, body } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow(
        'Bad Request: provide at least one of alphabetical_name'
      );
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it.each([
      ['a bare JSON string', 'alphabetical_name'],
      ['a JSON array', ['alphabetical_name']],
      ['a JSON number', 3],
    ])('returns 400 naming the body shape when the body is %s', async (_label, body) => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = { params: { id: '42' }, body } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow('Bad Request: body must be a JSON object');
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it('rejects a malformed body before the existence lookup, so an unknown artist still 400s', async () => {
      mockGetArtistCardById.mockResolvedValue(null);
      const req = { params: { id: '999' }, body: undefined } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow(
        'Bad Request: provide at least one of alphabetical_name'
      );
      expect(mockGetArtistCardById).not.toHaveBeenCalled();
    });

    // Third-round review (verified end to end): `artist_name` renaming was
    // pulled from this endpoint entirely -- `artists`/`library` are still
    // tubafrenzy-canonical and `jobs/library-etl`'s `ensureArtist` matches by
    // `fold_artist_name` and never UPDATEs `artists`, so a Backend-side
    // rename would move the match key, get silently duplicated on the next
    // ETL pass, and be reverted by that duplicate's release upsert. A client
    // that sends `artist_name` is REJECTED with a 400 naming the field and
    // the reason, not silently ignored -- silently dropping a requested
    // write is its own defect class, and this endpoint already rejects
    // `genre_id`/`code_letters`/`code_artist_number` the same way.
    it.each([
      ['a string (a plausible rename attempt)', 'Anohni Hegarty'],
      ['a number', 123],
      ['an array', ['a']],
    ])(
      'rejects a body containing artist_name (%s) with a 400 naming the field, before the existence lookup',
      async (_label, value) => {
        const req = { params: { id: '42' }, body: { artist_name: value } } as unknown as Request;
        const res = mockResponse();

        let caught: unknown;
        try {
          await updateArtistCard(req, res, next);
        } catch (err) {
          caught = err;
        }
        const message = (caught as Error).message;
        expect(message).toContain('no write path exists for artist_name');
        expect(message).toContain('tubafrenzy-canonical');
        expect(mockGetArtistCardById).not.toHaveBeenCalled();
        expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
      }
    );

    it('rejects artist_name even when a valid alphabetical_name is present in the same body', async () => {
      const req = {
        params: { id: '42' },
        body: { artist_name: 'Anohni Hegarty', alphabetical_name: 'Anohni Hegarty' },
      } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow('no write path exists for artist_name');
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    // TypeScript's `UpdateArtistRequest` is erased at runtime, so this
    // `typeof !== 'string'` guard is the ENTIRE runtime defense behind the
    // allowlist against a non-string reaching `.trim()` (TypeError -> 500) or
    // the UPDATE.
    it.each([
      ['a number', 123],
      ['an array', ['a']],
      ['an object', { toString: 'nope' }],
      ['a boolean', true],
    ])('returns 400 when alphabetical_name is %s', async (_label, value) => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = { params: { id: '42' }, body: { alphabetical_name: value } } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow('alphabetical_name must be a non-empty string');
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    // `varchar(128)`; over-length input must 400 rather than reach the
    // UPDATE and trip PG 22001 ("value too long") -> 500 (#1551).
    it('returns 400 when alphabetical_name exceeds 128 characters', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = { params: { id: '42' }, body: { alphabetical_name: 'x'.repeat(129) } } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow(
        'alphabetical_name must be 128 characters or fewer'
      );
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it('accepts alphabetical_name at exactly 128 characters', async () => {
      const atLimit = 'x'.repeat(128);
      mockGetArtistCardById.mockResolvedValue(existingCard);
      mockUpdateArtistInDB.mockResolvedValue({ id: 42, artist_name: 'Anohni', alphabetical_name: atLimit });
      const req = { params: { id: '42' }, body: { alphabetical_name: atLimit } } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      expect(mockUpdateArtistInDB).toHaveBeenCalledWith(42, { alphabetical_name: atLimit });
    });

    it('returns 400 when alphabetical_name is whitespace-only', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = { params: { id: '42' }, body: { alphabetical_name: '   ' } } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow('alphabetical_name must be a non-empty string');
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace before validating and storing', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      mockUpdateArtistInDB.mockResolvedValue({ id: 42, artist_name: 'Anohni', alphabetical_name: 'Anohni Hegarty' });
      const req = { params: { id: '42' }, body: { alphabetical_name: '  Anohni Hegarty  ' } } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      expect(mockUpdateArtistInDB).toHaveBeenCalledWith(42, { alphabetical_name: 'Anohni Hegarty' });
    });

    // Review finding N2: the controller used to measure `trimmed.length` on
    // the RAW input while `updateArtistInDB` writes `.normalize('NFC')`, and
    // NFC is NOT length-non-increasing -- a full composition-exclusion
    // codepoint like U+0958 ('क़') is 1 UTF-16 unit raw but 2 after NFC (it
    // canonically decomposes to U+0915 + U+093C and, being excluded from
    // recomposition, stays decomposed). A 128-repeat of it passed the old
    // raw-length 400 and would have reached Postgres at NFC length 256,
    // tripping SQLSTATE 22001 ("value too long") -> 500 where the documented
    // answer is 400.
    // The fixtures below MUST use `'\u0958'` escape notation, never a literal
    // pasted into the source. An editor, a formatter, or a git filter that
    // normalizes the file silently rewrites that literal to its decomposed
    // form U+0915 U+093C -- which is what happened to an earlier revision of
    // these two tests. Once decomposed, the input is already NFC, so both
    // tests passed identically with and without the normalize-before-measure
    // fix they exist to pin: reverting the controller to measure the raw
    // `trim()`ed value left them green. Asserting the code points up front
    // makes that silent rewrite a test failure instead of a silent hole.
    it('returns 400 when alphabetical_name is within the raw-length limit but exceeds it after NFC normalization', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const precomposed = '\u0958'; // 'क़' as a single composition-exclusion code point
      expect(precomposed.length).toBe(1);
      expect(precomposed.normalize('NFC')).toBe('\u0915\u093C');

      const compositionExclusion = precomposed.repeat(128); // raw length 128, NFC length 256
      expect(compositionExclusion.length).toBe(128);
      expect(compositionExclusion.normalize('NFC').length).toBe(256);

      const req = { params: { id: '42' }, body: { alphabetical_name: compositionExclusion } } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow(
        'alphabetical_name must be 128 characters or fewer'
      );
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    // `updateArtistInDB` always SETs `last_modified = NOW()`, which fires
    // `touch_library_watermark_from_artists` (migration 0105, FOR EACH
    // STATEMENT on `artists`) and advances the catalog conditional-GET
    // watermark — so a librarian hitting Save on an unchanged card makes every
    // iOS and dj-site poller re-download the full catalog for a write that
    // changed nothing. `updateAlbum` guards exactly this (#1555); this path
    // reaches it through a coarser statement-level trigger on the parent table.
    it('short-circuits a no-op edit without writing, so the catalog watermark does not advance', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      const req = {
        params: { id: '42' },
        body: { alphabetical_name: existingCard.alphabetical_name },
      } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(existingCard);
    });

    it('still writes when the value actually changes', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      mockUpdateArtistInDB.mockResolvedValue({ id: 42, artist_name: 'Anohni', alphabetical_name: 'Hegarty, Antony' });
      const req = { params: { id: '42' }, body: { alphabetical_name: 'Hegarty, Antony' } } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      expect(mockUpdateArtistInDB).toHaveBeenCalledWith(42, { alphabetical_name: 'Hegarty, Antony' });
    });

    // Postgres measures `varchar(128)` in characters; a bare `.length` measures
    // UTF-16 units and counts every astral character twice, rejecting values PG
    // would store happily — undercutting the reject-over-truncate choice
    // `codePointLength` was written to protect.
    it('accepts a 128-code-point alphabetical_name containing astral characters', async () => {
      const astral = 'a'.repeat(127) + '\u{1F600}';
      expect([...astral].length).toBe(128);
      expect(astral.length).toBe(129);

      mockGetArtistCardById.mockResolvedValue(existingCard);
      mockUpdateArtistInDB.mockResolvedValue({ id: 42, artist_name: 'Anohni', alphabetical_name: astral });
      const req = { params: { id: '42' }, body: { alphabetical_name: astral } } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      expect(mockUpdateArtistInDB).toHaveBeenCalledWith(42, { alphabetical_name: astral });
    });

    it('stores the NFC-normalized value, not the raw composed form', async () => {
      mockGetArtistCardById.mockResolvedValue(existingCard);
      mockUpdateArtistInDB.mockResolvedValue({ id: 42, artist_name: 'Anohni', alphabetical_name: '\u0915\u093C' });
      // U+0958, 1 raw UTF-16 unit, normalizes to U+0915 U+093C (2 units).
      const req = { params: { id: '42' }, body: { alphabetical_name: '\u0958' } } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      // The DECOMPOSED form must reach the service. Asserting 'क़' here
      // would pass whether or not the controller normalizes.
      expect(mockUpdateArtistInDB).toHaveBeenCalledWith(42, { alphabetical_name: '\u0915\u093C' });
    });

    // BS#2156 review: the AC says the endpoint allowlists exactly
    // `alphabetical_name` and rejects anything else -- these fields must 400
    // with a precise reason, not be accepted-and-silently-dropped as if the
    // edit had taken effect.
    it.each(['code_letters', 'genre_id', 'code_artist_number'])(
      'returns 400 rather than silently dropping %s, before the existence lookup',
      async (field) => {
        const req = {
          params: { id: '42' },
          body: { alphabetical_name: 'Anohni Renamed', [field]: field === 'code_letters' ? 'ZZ' : 999 },
        } as unknown as Request;
        const res = mockResponse();

        await expect(updateArtistCard(req, res, next)).rejects.toThrow(`no write path exists for ${field}`);
        expect(mockGetArtistCardById).not.toHaveBeenCalled();
        expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
      }
    );

    it('names every rejected field when several no-write-path fields are sent together', async () => {
      const req = {
        params: { id: '42' },
        body: {
          alphabetical_name: 'Anohni Renamed',
          artist_name: 'Anohni Renamed',
          code_letters: 'ZZ',
          genre_id: 999,
          code_artist_number: 7,
        },
      } as unknown as Request;
      const res = mockResponse();

      let caught: unknown;
      try {
        await updateArtistCard(req, res, next);
      } catch (err) {
        caught = err;
      }
      const message = (caught as Error).message;
      expect(message).toContain('no write path exists for artist_name');
      expect(message).toContain('tubafrenzy-canonical');
      expect(message).toContain(
        'genre_id (no write path: genre_artist_crossreference.genre_id is set once by POST /library/artists and is never UPDATEd by any endpoint)'
      );
      expect(message).toContain(
        'code_letters (no write path: artists.code_letters is set once by POST /library/artists and is never UPDATEd by any endpoint)'
      );
      expect(message).toContain(
        'code_artist_number (no write path: genre_artist_crossreference.artist_genre_code is set once by POST /library/artists and is never UPDATEd by any endpoint)'
      );
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it('rejects a no-write-path field even when it is the only field on the body', async () => {
      const req = { params: { id: '42' }, body: { genre_id: 999 } } as unknown as Request;
      const res = mockResponse();

      await expect(updateArtistCard(req, res, next)).rejects.toThrow('no write path exists for genre_id');
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    it('returns 200 with the refreshed card shape (not the bare artists row) on success', async () => {
      const refreshed: ArtistCardMock = {
        artist_id: 42,
        artist_name: 'Anohni',
        alphabetical_name: 'Anohni Renamed',
        genre_id: 11,
        code_letters: 'AN',
        code_artist_number: 3,
      };
      mockGetArtistCardById.mockResolvedValueOnce(existingCard).mockResolvedValueOnce(refreshed);
      mockUpdateArtistInDB.mockResolvedValue({
        id: 42,
        artist_name: 'Anohni',
        alphabetical_name: 'Anohni Renamed',
      });
      const req = {
        params: { id: '42' },
        body: { alphabetical_name: 'Anohni Renamed' },
      } as unknown as Request;
      const res = mockResponse();

      await updateArtistCard(req, res, next);

      expect(mockUpdateArtistInDB).toHaveBeenCalledWith(42, {
        alphabetical_name: 'Anohni Renamed',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      // Same field set GET /library/artists/:id serves — `artist_id`, not `id`.
      expect(res.json).toHaveBeenCalledWith(refreshed);
    });
  });

  describe('getArtistReleases (BS#2156)', () => {
    const releases = [
      {
        id: 7000,
        last_modified: new Date('2026-06-01'),
        format_name: 'vinyl - LP',
        genre_id: 11,
        code_letters: 'CH',
        code_artist_number: 4,
        code_number: 3,
        code_volume_letters: null,
        album_title: 'Edits',
        alternate_artist_name: null,
      },
    ];

    // Only used to prove existence -- the response never echoes the card
    // fields, so the exact content is irrelevant, only that it's non-null.
    const anyCard: ArtistCardMock = {
      artist_id: 42,
      artist_name: 'Chuquimamani-Condori',
      alphabetical_name: 'Chuquimamani-Condori',
      genre_id: 11,
      code_letters: 'CH',
      code_artist_number: 4,
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockCountReleasesForArtist.mockResolvedValue(1);
    });

    it('returns 404 when the artist does not exist', async () => {
      mockGetArtistCardById.mockResolvedValue(null);
      const req = { params: { id: '999' }, query: {} } as unknown as Request;
      const res = mockResponse();

      await expect(getArtistReleases(req, res, next)).rejects.toThrow('Artist not found');
      expect(mockGetReleasesForArtist).not.toHaveBeenCalled();
    });

    // BS#2156 review: an artist row with no genre_artist_crossreference must
    // 404 here the same way it already does on GET/PATCH
    // /library/artists/:id (both resolve existence through
    // `getArtistCardById`'s INNER JOIN) -- a plain `artists` lookup like
    // `getArtistNameById` would 200 with an empty release page instead.
    it('returns 404 when the artist has no genre crossreference, matching GET/PATCH', async () => {
      mockGetArtistCardById.mockResolvedValue(null);
      const req = { params: { id: '42' }, query: {} } as unknown as Request;
      const res = mockResponse();

      await expect(getArtistReleases(req, res, next)).rejects.toThrow('Artist not found');
      expect(mockGetArtistCardById).toHaveBeenCalledWith(42);
      expect(mockGetReleasesForArtist).not.toHaveBeenCalled();
    });

    it('returns 200 with a default-paginated release page on success', async () => {
      mockGetArtistCardById.mockResolvedValue(anyCard);
      mockGetReleasesForArtist.mockResolvedValue(releases);
      mockCountReleasesForArtist.mockResolvedValue(1);
      const req = { params: { id: '42' }, query: {} } as unknown as Request;
      const res = mockResponse();

      await getArtistReleases(req, res, next);

      expect(mockGetReleasesForArtist).toHaveBeenCalledWith(42, 0, 50);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ artist_id: 42, releases, total: 1, page: 0, totalPages: 1 });
    });

    it('passes an explicit page/limit through and reports totalPages', async () => {
      mockGetArtistCardById.mockResolvedValue(anyCard);
      mockGetReleasesForArtist.mockResolvedValue(releases);
      mockCountReleasesForArtist.mockResolvedValue(3107);
      const req = { params: { id: '1087' }, query: { page: '2', limit: '100' } } as unknown as Request;
      const res = mockResponse();

      await getArtistReleases(req, res, next);

      expect(mockGetReleasesForArtist).toHaveBeenCalledWith(1087, 2, 100);
      expect(res.json).toHaveBeenCalledWith({
        artist_id: 1087,
        releases,
        total: 3107,
        page: 2,
        totalPages: 32,
      });
    });

    // Unbounded, this endpoint hands any catalog:read DJ every row an artist
    // has — 3,107 of them for artist 1087, freely repeatable.
    it.each([
      ['limit above the maximum', { limit: '101' }, 'limit must not exceed 100'],
      ['a zero limit', { limit: '0' }, 'limit must be a positive integer'],
      ['a negative page', { page: '-1' }, 'page must be a non-negative integer'],
      ['a non-numeric limit', { limit: 'all' }, 'limit must be a positive integer'],
      ['a non-numeric page', { page: 'first' }, 'page must be a non-negative integer'],
    ])('rejects %s with 400', async (_label, query, message) => {
      mockGetArtistCardById.mockResolvedValue(anyCard);
      const req = { params: { id: '1087' }, query } as unknown as Request;
      const res = mockResponse();

      await expect(getArtistReleases(req, res, next)).rejects.toThrow(message);
      expect(mockGetReleasesForArtist).not.toHaveBeenCalled();
    });

    it.each([
      ['page', { page: ['1', '2'] }, 'page must be a single string value'],
      ['limit', { limit: ['1', '2'] }, 'limit must be a single string value'],
    ])('rejects a repeated %s query key with 400', async (_label, query, message) => {
      const req = { params: { id: '1087' }, query } as unknown as Request;
      const res = mockResponse();

      await expect(getArtistReleases(req, res, next)).rejects.toThrow(message);
      expect(mockGetReleasesForArtist).not.toHaveBeenCalled();
    });
  });

  describe('updateRotation (BS#2113)', () => {
    const reqFor = (body: Record<string, unknown>, id = '42') => ({ params: { id }, body }) as unknown as Request;

    beforeEach(() => {
      mockIsISODate.mockImplementation((date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date));
      // Default: the service reports a successful write. The linked/unlinked
      // precondition on the snapshot trio (review finding 4) now lives
      // entirely inside `libraryService.updateRotation`'s compare-and-set —
      // this controller never reads the row itself, so there is no "target an
      // uncatalogued row" fixture to arrange here the way there used to be.
      mockUpdateRotation.mockResolvedValue({ outcome: 'updated', rotation: { id: 42, artist_name: 'Juana Molina' } });
    });

    // The message is `Invalid rotation ID` (capital ID) because this handler
    // shares `parseResourceId` with the artist and album routes rather than
    // carrying its own parser. That one is stricter than the parser this
    // endpoint originally shipped -- it also rejects '42.0', '1e3', '+42' and
    // '007' -- and one implementation per router is the point. Safe to change
    // the wording: the endpoint is new and has no clients.
    it.each(['42.0', '1e3', '+42', '007', ' 42 ', '0x2a'])(
      'returns 400 for the non-canonical id spelling %s',
      async (rawId) => {
        const res = mockResponse();

        await expect(updateRotation(reqFor({ artist_name: 'x' }, rawId), res, next)).rejects.toThrow(
          'Invalid rotation ID'
        );
        expect(mockUpdateRotation).not.toHaveBeenCalled();
      }
    );

    it('returns 400 for a non-numeric id', async () => {
      const res = mockResponse();

      await expect(updateRotation(reqFor({ artist_name: 'x' }, 'abc'), res, next)).rejects.toThrow(
        'Invalid rotation ID'
      );
      expect(mockUpdateRotation).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-positive id', async () => {
      const res = mockResponse();

      await expect(updateRotation(reqFor({ artist_name: 'x' }, '0'), res, next)).rejects.toThrow('Invalid rotation ID');
      expect(mockUpdateRotation).not.toHaveBeenCalled();
    });

    it('returns 400 when no updatable field is provided', async () => {
      const res = mockResponse();

      await expect(updateRotation(reqFor({}), res, next)).rejects.toThrow('provide at least one of');
      expect(mockUpdateRotation).not.toHaveBeenCalled();
    });

    // The issue's explicit scope correction: alphabetical_name, format, and
    // format_size have no column on `rotation` and must be rejected outright,
    // not silently dropped like an unrecognized field would be.
    describe('no-column fields are rejected, not silently dropped (BS#2156 / dj-site#1169)', () => {
      it.each([['alphabetical_name'], ['format'], ['format_size']])('rejects %s', async (field) => {
        const res = mockResponse();

        await expect(updateRotation(reqFor({ artist_name: 'ok', [field]: 'nope' }), res, next)).rejects.toThrow(
          'no rotation column exists'
        );
        expect(mockUpdateRotation).not.toHaveBeenCalled();
      });

      it('reports every rejected field at once', async () => {
        const res = mockResponse();

        await expect(
          updateRotation(reqFor({ alphabetical_name: 'a', format: 'LP', format_size: '12"' }), res, next)
        ).rejects.toThrow(/alphabetical_name.*format.*format_size/s);
      });
    });

    describe('per-field validation', () => {
      it('rejects an empty artist_name', async () => {
        const res = mockResponse();
        await expect(updateRotation(reqFor({ artist_name: '   ' }), res, next)).rejects.toThrow(
          'artist_name must be a non-empty string'
        );
        expect(mockUpdateRotation).not.toHaveBeenCalled();
      });

      it('rejects an over-length album_title (>128 chars)', async () => {
        const res = mockResponse();
        await expect(updateRotation(reqFor({ album_title: 'a'.repeat(129) }), res, next)).rejects.toThrow(
          'album_title must be 128 characters or fewer'
        );
        expect(mockUpdateRotation).not.toHaveBeenCalled();
      });

      // Postgres measures `varchar(128)` in characters; a bare `.length`
      // measures UTF-16 units and counts every astral character twice. This
      // string is 128 code points (PG stores it) but `.length === 129`, so
      // measuring the wrong unit made it creatable via `POST /library/rotation`
      // — which uses `codePointLength` — and un-editable here. A librarian
      // could not fix a typo elsewhere in the row without first shortening a
      // title the system had already accepted.
      it('accepts a 128-code-point album_title containing astral characters', async () => {
        const astral = 'a'.repeat(127) + '\u{1F600}';
        expect([...astral].length).toBe(128);
        expect(astral.length).toBe(129);

        const res = mockResponse();
        mockUpdateRotation.mockResolvedValueOnce({
          outcome: 'updated',
          rotation: { id: 42, album_title: astral },
        });

        await updateRotation(reqFor({ album_title: astral }), res, next);

        expect(mockUpdateRotation).toHaveBeenCalledWith(42, { album_title: astral });
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('rejects a malformed add_date', async () => {
        const res = mockResponse();
        await expect(updateRotation(reqFor({ add_date: '01/15/2024' }), res, next)).rejects.toThrow(
          'Incorrect Date Format: add_date'
        );
        expect(mockUpdateRotation).not.toHaveBeenCalled();
      });

      it('rejects a malformed kill_date', async () => {
        const res = mockResponse();
        await expect(updateRotation(reqFor({ kill_date: '12/31/2025' }), res, next)).rejects.toThrow(
          'Incorrect Date Format: kill_date'
        );
        expect(mockUpdateRotation).not.toHaveBeenCalled();
      });

      it('accepts an explicit null kill_date (clears the column)', async () => {
        const res = mockResponse();

        await updateRotation(reqFor({ kill_date: null }), res, next);

        expect(mockUpdateRotation).toHaveBeenCalledWith(42, { kill_date: null });
      });
    });

    // The snapshot trio is only meaningful on a rotation row with no library
    // link. `getRotationFromDB` projects COALESCE(artists.artist_name,
    // rotation.artist_name) and friends, so on a linked row the library join
    // wins and the write would be invisible on the only rotation read path —
    // while still breaking the "a library-LINKED rotation row carries NULL
    // denormalized names" invariant the flowsheet rotation-badge arms rest on.
    //
    // Review finding 4 moved the linked/unlinked decision into the service's
    // own compare-and-set, so from here the "row is linked" case is just
    // another shape the mocked service resolves to (`linked_conflict`) — the
    // controller no longer reads the row to decide this itself.
    describe('the denormalized snapshot trio is rejected on a catalogued row (BS#2080 invariant)', () => {
      beforeEach(() => {
        mockUpdateRotation.mockResolvedValue({ outcome: 'linked_conflict', albumId: 3 });
      });

      it.each([['artist_name'], ['album_title'], ['record_label']])(
        'rejects %s with a 409 naming the reason',
        async (field) => {
          const res = mockResponse();

          await expect(updateRotation(reqFor({ [field]: 'Stereolab' }), res, next)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining(field),
          });
          // Unlike the old read-then-write shape, the service IS called here —
          // it is the one deciding the row is linked, from inside its own
          // UPDATE, not from a controller-side pre-check.
          expect(mockUpdateRotation).toHaveBeenCalledWith(42, { [field]: 'Stereolab' });
        }
      );

      it('names every rejected snapshot field at once', async () => {
        const res = mockResponse();

        await expect(
          updateRotation(
            reqFor({ artist_name: 'Stereolab', album_title: 'Dots and Loops', record_label: 'Duophonic' }),
            res,
            next
          )
        ).rejects.toThrow(/artist_name.*album_title.*record_label/s);
      });

      // BS#2113 review finding 2: the remedy is field-specific, not a blanket
      // "edit the library release" — album_title/record_label really are
      // editable there, artist_name is not.
      it('honestly refuses to offer PATCH /library/:id as a remedy for artist_name', async () => {
        const res = mockResponse();

        await expect(updateRotation(reqFor({ artist_name: 'Stereolab' }), res, next)).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining(
            'artist_name has no remedy here: library.artist_name is derived from the linked artists row via ' +
              'artist_id, and no endpoint currently supports renaming an artist'
          ),
        });
      });

      it('names the real remedy for album_title and record_label', async () => {
        const res = mockResponse();

        await expect(
          updateRotation(reqFor({ album_title: 'Dots and Loops', record_label: 'Duophonic' }), res, next)
        ).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining('edit album_title, label via PATCH /library/3 instead'),
        });
      });

      it('still accepts add_date and kill_date — those have no library-join shadow', async () => {
        mockUpdateRotation.mockResolvedValue({
          outcome: 'updated',
          rotation: { id: 42, add_date: '2024-01-15', kill_date: null },
        });
        const res = mockResponse();

        await updateRotation(reqFor({ add_date: '2024-01-15', kill_date: null }), res, next);

        expect(mockUpdateRotation).toHaveBeenCalledWith(42, { add_date: '2024-01-15', kill_date: null });
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    // Not writable today — the handler builds `updates` field-by-field and the
    // service loops a hardcoded five-key array — but nothing pinned it, so a
    // refactor to `Object.assign(set, updates)` would pass the whole suite
    // while opening BS#1029's trust-gated provenance columns to client writes.
    it('drops every server-derived and non-in-scope column the client sends', async () => {
      const res = mockResponse();

      await updateRotation(
        reqFor({
          add_date: '2024-01-15',
          legacy_rotation_id: 555_000_001,
          legacy_library_release_id: 555_000_002,
          discogs_release_id: 999777,
          discogs_release_id_source: 'discogs_direct_backfill',
          lml_identity_id: 8_888_888,
          tracklist_lookup_attempted_at: '2024-01-15T00:00:00.000Z',
          album_id: 7,
          rotation_bin: 'H',
        }),
        res,
        next
      );

      expect(mockUpdateRotation).toHaveBeenCalledWith(42, { add_date: '2024-01-15' });
    });

    it('trims and forwards only the fields present in the body (true partial semantics)', async () => {
      const res = mockResponse();

      await updateRotation(
        reqFor({
          artist_name: '  Juana Molina  ',
          album_title: 'DOGA',
        }),
        res,
        next
      );

      expect(mockUpdateRotation).toHaveBeenCalledWith(42, {
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
      });
    });

    it('forwards all five in-scope fields, including kill_date, in one call', async () => {
      const res = mockResponse();

      await updateRotation(
        reqFor({
          artist_name: 'Jessica Pratt',
          album_title: 'On Your Own Love Again',
          record_label: 'Drag City',
          add_date: '2024-01-15',
          kill_date: '2024-06-01',
        }),
        res,
        next
      );

      expect(mockUpdateRotation).toHaveBeenCalledWith(42, {
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        record_label: 'Drag City',
        add_date: '2024-01-15',
        kill_date: '2024-06-01',
      });
    });

    it('returns 200 with the updated row on success', async () => {
      const res = mockResponse();
      mockUpdateRotation.mockResolvedValue({
        outcome: 'updated',
        rotation: { id: 42, artist_name: 'Juana Molina', kill_date: null },
      });

      await updateRotation(reqFor({ artist_name: 'Juana Molina' }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ id: 42, artist_name: 'Juana Molina', kill_date: null });
    });

    // Covers both "never existed" and "deleted between validation and the
    // write" — the compare-and-set service can't (and doesn't try to) tell
    // those apart from a zero-row UPDATE, so both resolve to the same
    // `not_found` outcome the controller maps to 404.
    it('returns 404 when the service reports the row not found', async () => {
      const res = mockResponse();
      mockUpdateRotation.mockResolvedValue({ outcome: 'not_found' });

      await expect(updateRotation(reqFor({ artist_name: 'Juana Molina' }, '999'), res, next)).rejects.toThrow(
        'Rotation entry not found'
      );
    });
  });
});
