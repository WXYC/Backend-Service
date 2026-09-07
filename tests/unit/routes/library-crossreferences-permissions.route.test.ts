// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/library-artist-card-permissions.route.test.ts.
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
import type { ArtistCrossReferenceRow, ReleaseCrossReferenceRow } from '../../../apps/backend/services/library.service';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

function mockRole(role: string) {
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', role },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });
}

const mockGetArtistCrossReferences = jestGlobals.fn<() => Promise<ArtistCrossReferenceRow[]>>();
const mockCountArtistCrossReferences = jestGlobals.fn<() => Promise<number>>();
const mockGetReleaseCrossReferences = jestGlobals.fn<() => Promise<ReleaseCrossReferenceRow[]>>();
const mockCountReleaseCrossReferences = jestGlobals.fn<() => Promise<number>>();

// Collaborator mocks below mirror the artist-card route-permission test --
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
  getArtistNameById: jest.fn(),
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
  getArtistCardById: jest.fn(),
  updateArtistInDB: jest.fn(),
  getReleasesForArtist: jest.fn(),
  countReleasesForArtist: jest.fn(),
  getArtistCrossReferences: mockGetArtistCrossReferences,
  countArtistCrossReferences: mockCountArtistCrossReferences,
  getReleaseCrossReferences: mockGetReleaseCrossReferences,
  countReleaseCrossReferences: mockCountReleaseCrossReferences,
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
 * The two legacy cross-reference listings are `catalog:['write']` READS.
 *
 * `mainmenu.jsp:32-38` wraps both links in `<c:if
 * test="${user.hasAdminAccess()}">` -- unlike Missing Releases and the
 * rotation links immediately below them, which sit outside it. `catalog:
 * ['write']` is the grant that selects musicDirector + stationManager, the
 * same pair that flag names. Without this test, relaxing the gate to
 * `catalog:['read']` and handing every DJ and `member` a screen the legacy
 * system gated would leave the rest of the suite green -- the controller
 * tests drive the handlers directly.
 */
describe('Legacy cross-reference routes -- permission tier', () => {
  beforeEach(() => {
    mockGetArtistCrossReferences.mockReset().mockResolvedValue([]);
    mockCountArtistCrossReferences.mockReset().mockResolvedValue(0);
    mockGetReleaseCrossReferences.mockReset().mockResolvedValue([]);
    mockCountReleaseCrossReferences.mockReset().mockResolvedValue(0);
  });

  describe.each([
    ['/library/crossreferences/artists', () => mockGetArtistCrossReferences],
    ['/library/crossreferences/releases', () => mockGetReleaseCrossReferences],
  ])('GET %s (catalog:write)', (path, reader) => {
    test.each(['stationManager', 'musicDirector'])('a %s-role token is authorized', async (role) => {
      mockRole(role);
      const res = await request(app).get(path).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
      expect(reader()).toHaveBeenCalled();
    });

    test.each(['dj', 'member'])('a %s-role token (catalog:read only) is rejected', async (role) => {
      mockRole(role);
      const res = await request(app).get(path).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(403);
      expect(reader()).not.toHaveBeenCalled();
    });

    test('a request with no Authorization header is rejected', async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(reader()).not.toHaveBeenCalled();
    });

    // The empty collection is the JSP's "There are no ... Cross-References"
    // state, and it is a 200 rather than a 404 -- asserted here alongside the
    // gate so a permission change cannot be mistaken for an empty result.
    test('an empty collection answers 200 with an empty page', async () => {
      mockRole('musicDirector');
      const res = await request(app).get(path).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ results: [], total: 0, page: 0, totalPages: 0 });
    });
  });

  // Registration order: `/crossreferences/*` must not fall through to a
  // templated route. `GET /:id/compilation-tracks` is the only other
  // two-segment GET on this router; it carries `catalog:['read']`, so a
  // shadowed route would show up as a `dj` token succeeding above rather than
  // as a 404. This pins the literal directly.
  test('the two literals are distinct routes, not one templated handler', async () => {
    mockRole('musicDirector');
    await request(app).get('/library/crossreferences/artists').set('Authorization', 'Bearer test-token');
    await request(app).get('/library/crossreferences/releases').set('Authorization', 'Bearer test-token');
    expect(mockGetArtistCrossReferences).toHaveBeenCalledTimes(1);
    expect(mockGetReleaseCrossReferences).toHaveBeenCalledTimes(1);
  });
});
