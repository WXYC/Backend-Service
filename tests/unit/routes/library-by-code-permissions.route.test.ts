// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/library-missing-found-permissions.route.test.ts.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

// Mock jose so we can hand back an arbitrary role in the verified JWT payload
// without a real JWKS endpoint. requirePermissions's non-bypass branch is
// what actually enforces role/permission checks. Note: integration tests run
// with AUTH_BYPASS=true, whose branch short-circuits to next() before any
// permission check runs, so they cannot exercise this route's auth tier --
// hence this real-middleware unit test.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

// jest.unit.config.ts's moduleNameMapper sends `@wxyc/authentication` to
// tests/mocks/authentication.mock.ts (a stub that ignores the role/permission
// argument entirely). library.route.ts imports requirePermissions from that
// package specifier, so this route-wiring test needs the REAL implementation
// wired back in to actually exercise the catalog:read gate.
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

// Collaborator mocks below mirror tests/unit/controllers/library.controller.test.ts
// (the resolveArtistByCode coverage itself already lives there) -- only enough
// is stubbed here to let library.route's import chain resolve without
// touching a real DB, LML, or lru-cache.
type ArtistConflictRow = { artist_id: number; artist_name: string; code_letters: string };
const mockGetArtistsByCode = jestGlobals.fn<() => Promise<ArtistConflictRow[]>>();
const mockGenreExists = jestGlobals.fn<() => Promise<boolean>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  getArtistsByCode: mockGetArtistsByCode,
  genreExists: mockGenreExists,
  // Stub out other exports referenced at import time by library.controller.
  getAlbumFromDB: jest.fn(),
  getAlbumByLegacyId: jest.fn(),
  markAlbumMissing: jest.fn(),
  markAlbumFound: jest.fn(),
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
  isLmlConfigured: () => false,
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
 * BS#2149 review finding 3: GET /library/artists/by-code was gated to
 * catalog:write, the same bar as the create-flow helpers `search` and
 * `peek-code`, even though it's a pure read. Relaxed to catalog:read --
 * shelf-code data is already DJ-readable on `GET /library/query` and
 * `GET /djs/bin`, and this route returns strictly less than `/library/query`
 * already does. `search` and `peek-code` are unchanged (still catalog:write).
 */
describe('GET /library/artists/by-code — permission tier (BS#2149)', () => {
  beforeEach(() => {
    mockGetArtistsByCode
      .mockReset()
      .mockResolvedValue([{ artist_id: 9, artist_name: 'Built to Spill', code_letters: 'BU' }]);
    mockGenreExists.mockReset().mockResolvedValue(true);
  });

  const query = { genre_id: '11', code_letters: 'BU', code_number: '60' };

  test('a dj-role token (catalog:read) is authorized', async () => {
    mockRole('dj');
    const res = await request(app)
      .get('/library/artists/by-code')
      .query(query)
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetArtistsByCode).toHaveBeenCalledWith('BU', 11, 60);
  });

  test('a member-role token (catalog:read, same tier as dj) is authorized', async () => {
    mockRole('member');
    const res = await request(app)
      .get('/library/artists/by-code')
      .query(query)
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
  });

  test('a musicDirector-role token (catalog:read+write) is authorized', async () => {
    mockRole('musicDirector');
    const res = await request(app)
      .get('/library/artists/by-code')
      .query(query)
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).get('/library/artists/by-code').query(query);
    expect(res.status).toBe(401);
    expect(mockGetArtistsByCode).not.toHaveBeenCalled();
  });
});
