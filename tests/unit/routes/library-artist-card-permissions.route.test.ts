// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/library-discogs-recheck-permissions.route.test.ts.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

// Mock jose so we can hand back an arbitrary role in the verified JWT payload
// without a real JWKS endpoint. requirePermissions's non-bypass branch is
// what actually enforces role/permission checks.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

// jest.unit.config.ts's moduleNameMapper sends `@wxyc/authentication` to
// tests/mocks/authentication.mock.ts (a stub that ignores the role/permission
// argument entirely). library.route.ts imports requirePermissions from that
// package specifier, so this route-wiring test needs the REAL implementation
// wired back in to actually exercise the catalog gates.
jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.middleware'));

import { jest as jestGlobals } from '@jest/globals';
import { jwtVerify } from 'jose';
import express from 'express';
import request from 'supertest';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

function mockRole(role: string) {
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', role },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });
}

type ArtistCard = {
  artist_id: number;
  artist_name: string;
  alphabetical_name: string;
  genre_id: number;
  code_letters: string;
  code_artist_number: number;
};

const ARTIST_CARD: ArtistCard = {
  artist_id: 1,
  artist_name: 'Jessica Pratt',
  alphabetical_name: 'Pratt, Jessica',
  genre_id: 11,
  code_letters: 'PR',
  code_artist_number: 4,
};

const mockGetArtistCardById = jestGlobals.fn<() => Promise<ArtistCard | null>>();
const mockUpdateArtistInDB =
  jestGlobals.fn<() => Promise<{ id: number; artist_name: string; alphabetical_name: string } | undefined>>();
const mockGetArtistNameById = jestGlobals.fn<() => Promise<string | null>>();
const mockGetReleasesForArtist = jestGlobals.fn<() => Promise<unknown[]>>();
const mockCountReleasesForArtist = jestGlobals.fn<() => Promise<number>>();

// Collaborator mocks below mirror the discogs-recheck route-permission test —
// only enough is stubbed here to let library.route's import chain resolve
// without touching a real DB, LML, or lru-cache.
jest.mock('../../../apps/backend/services/library.service', () => ({
  markAlbumMissing: jest.fn(),
  markAlbumFound: jest.fn(),
  getAlbumFromDB: jest.fn(),
  getCatalogLastModifiedAt: jest.fn(),
  serializeLibraryArtistViewEntry: (row: unknown) => row,
  serializeArtist: (row: unknown) => row,
  fuzzySearchLibrary: jest.fn(),
  enrichWithArtwork: jest.fn(),
  getFormatsFromDB: jest.fn(),
  getRotationFromDB: jest.fn(),
  addToRotation: jest.fn(),
  killRotationInDB: jest.fn(),
  insertAlbum: jest.fn(),
  updateArtworkUrl: jest.fn(),
  updateOnStreaming: jest.fn(),
  updateCanonicalEntity: jest.fn(),
  mapLookupToCanonicalEntity: jest.fn(),
  artistIdFromName: jest.fn(),
  getArtistNameById: mockGetArtistNameById,
  insertArtist: jest.fn(),
  insertArtistGenreCrossreference: jest.fn(),
  getArtistByCode: jest.fn(),
  getArtistById: jest.fn(),
  generateAlbumCodeNumber: jest.fn(),
  generateArtistNumber: jest.fn(),
  getGenresFromDB: jest.fn(),
  insertGenre: jest.fn(),
  insertFormat: jest.fn(),
  getFormatById: jest.fn(),
  isISODate: jest.fn(),
  resolveRotationPickerSource: jest.fn(),
  getRotationTracksFromRelease: jest.fn(),
  getLibraryRowById: jest.fn(),
  updateAlbumInDB: jest.fn(),
  artistExistsInGenre: jest.fn(),
  albumCodeNumberTaken: jest.fn(),
  recheckDiscogsAvailability: jest.fn(),
  getArtistCardById: mockGetArtistCardById,
  updateArtistInDB: mockUpdateArtistInDB,
  getReleasesForArtist: mockGetReleasesForArtist,
  countReleasesForArtist: mockCountReleasesForArtist,
}));

jest.mock('../../../apps/backend/services/labels.service', () => ({
  createLabel: jest.fn(),
  getLabelById: jest.fn(),
}));

jest.mock('../../../apps/backend/services/library-search.service', () => ({
  parseEnumQueryList: () => undefined,
  parseRotationBinsQueryList: () => undefined,
  searchLibrary: jest.fn(),
}));

jest.mock('@wxyc/lml-client', () => ({
  checkStreamingAvailability: jest.fn(),
  lookupMetadata: jest.fn(),
  isLmlConfigured: () => true,
  envInt: (_name: string, fallback: number) => fallback,
}));

jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: jest.fn() },
}));

jest.mock('../../../apps/backend/controllers/requestLine.controller', () => ({
  searchLibraryEndpoint: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(200).json([]),
}));

import { library_route } from '../../../apps/backend/routes/library.route';

const app = express();
app.use(express.json());
app.use('/library', library_route);

/**
 * BS#2156 artist-card routes: the two GETs are `catalog:['read']` (DJ and
 * above) and the PATCH is `catalog:['write']` (musicDirector and above).
 *
 * Without these, every artist-card test drives the routes through the
 * privileged integration token or calls the controller directly, so relaxing
 * the PATCH to `catalog:['read']` — letting any DJ edit a catalog artist's
 * `alphabetical_name` (the only field this endpoint can still write; a
 * follow-up review pulled `artist_name` off it entirely -- see
 * `library.controller.ts`'s `updateArtistCard` doc comment) — would leave the
 * whole suite green.
 */
describe('BS#2156 artist-card routes — permission tiers', () => {
  beforeEach(() => {
    mockGetArtistCardById.mockReset().mockResolvedValue(ARTIST_CARD);
    mockUpdateArtistInDB
      .mockReset()
      .mockResolvedValue({ id: 1, artist_name: 'Jessica Pratt', alphabetical_name: 'Pratt, Jessica' });
    mockGetArtistNameById.mockReset().mockResolvedValue('Jessica Pratt');
    mockGetReleasesForArtist.mockReset().mockResolvedValue([]);
    mockCountReleasesForArtist.mockReset().mockResolvedValue(0);
  });

  describe('GET /library/artists/:id (catalog:read)', () => {
    test.each(['stationManager', 'musicDirector', 'dj', 'member'])('a %s-role token is authorized', async (role) => {
      mockRole(role);
      const res = await request(app).get('/library/artists/1').set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
      expect(mockGetArtistCardById).toHaveBeenCalledWith(1);
    });

    test('a request with no Authorization header is rejected', async () => {
      const res = await request(app).get('/library/artists/1');
      expect(res.status).toBe(401);
      expect(mockGetArtistCardById).not.toHaveBeenCalled();
    });
  });

  describe('GET /library/artists/:id/releases (catalog:read)', () => {
    test.each(['stationManager', 'musicDirector', 'dj', 'member'])('a %s-role token is authorized', async (role) => {
      mockRole(role);
      const res = await request(app).get('/library/artists/1/releases').set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
      expect(mockGetReleasesForArtist).toHaveBeenCalledWith(1, 0, 50);
    });

    test('a request with no Authorization header is rejected', async () => {
      const res = await request(app).get('/library/artists/1/releases');
      expect(res.status).toBe(401);
      expect(mockGetReleasesForArtist).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /library/artists/:id (catalog:write)', () => {
    // `alphabetical_name`, not `artist_name`: these tests exist to pin the
    // PERMISSION tier, and `artist_name` is no longer writable on this
    // endpoint at all (BS#2156 follow-up review) -- sending it would 400
    // regardless of role and defeat the point of a 200-on-authorized case.
    test.each(['stationManager', 'musicDirector'])('a %s-role token is authorized', async (role) => {
      mockRole(role);
      const res = await request(app)
        .patch('/library/artists/1')
        .set('Authorization', 'Bearer test-token')
        .send({ alphabetical_name: 'Pratt, Jessica' });
      expect(res.status).toBe(200);
      expect(mockUpdateArtistInDB).toHaveBeenCalled();
    });

    test.each(['dj', 'member'])('a %s-role token (catalog:read only) is rejected', async (role) => {
      mockRole(role);
      const res = await request(app)
        .patch('/library/artists/1')
        .set('Authorization', 'Bearer test-token')
        .send({ alphabetical_name: 'Renamed By A DJ' });
      expect(res.status).toBe(403);
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });

    test('a request with no Authorization header is rejected', async () => {
      const res = await request(app).patch('/library/artists/1').send({ alphabetical_name: 'Renamed Anonymously' });
      expect(res.status).toBe(401);
      expect(mockUpdateArtistInDB).not.toHaveBeenCalled();
    });
  });
});
