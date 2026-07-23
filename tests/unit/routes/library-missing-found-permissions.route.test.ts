// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/authentication/auth.middleware.test.ts.
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
// tests/mocks/authentication.mock.ts (a stub whose requirePermissions only
// checks for an Authorization header, ignoring the role/permission argument
// entirely). library.route.ts imports requirePermissions from that package
// specifier, so this route-wiring test needs the REAL implementation wired
// back in to actually exercise the catalog:read vs catalog:write gate.
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
// (the markMissing/markFound coverage for these controllers already lives
// there) -- only enough is stubbed here to let library.route's import chain
// resolve without touching a real DB, LML, or lru-cache.
const mockMarkAlbumMissing = jestGlobals.fn<() => Promise<{ id: number } | undefined>>();
const mockMarkAlbumFound = jestGlobals.fn<() => Promise<{ id: number } | undefined>>();
const mockGetAlbumFromDB = jestGlobals.fn<() => Promise<Record<string, unknown> | undefined>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  markAlbumMissing: mockMarkAlbumMissing,
  markAlbumFound: mockMarkAlbumFound,
  getAlbumFromDB: mockGetAlbumFromDB,
  getCatalogLastModifiedAt: jest.fn(),
  // Stub out other exports referenced at import time by library.controller.
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
 * BS#393: PATCH /library/:id/missing and /found were gated to catalog:write
 * (musicDirector+), which excluded DJs (catalog:read only per
 * shared/authentication/src/auth.roles.ts) from marking a stack
 * missing/found while pulling records. Relaxed to catalog:read.
 */
describe('PATCH /library/:id/missing and /found — permission tier (BS#393)', () => {
  beforeEach(() => {
    mockMarkAlbumMissing.mockReset().mockResolvedValue({ id: 1 });
    mockMarkAlbumFound.mockReset().mockResolvedValue({ id: 1 });
    mockGetAlbumFromDB.mockReset().mockResolvedValue({ id: 1, missing: false });
  });

  test('a dj-role token is authorized for PATCH /:id/missing', async () => {
    mockRole('dj');
    const res = await request(app).patch('/library/1/missing').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockMarkAlbumMissing).toHaveBeenCalledWith(1);
  });

  test('a dj-role token is authorized for PATCH /:id/found', async () => {
    mockRole('dj');
    const res = await request(app).patch('/library/1/found').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockMarkAlbumFound).toHaveBeenCalledWith(1);
  });

  test('a member-role token (catalog:read only, same as dj) is authorized for /:id/missing', async () => {
    mockRole('member');
    const res = await request(app).patch('/library/1/missing').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).patch('/library/1/missing');
    expect(res.status).toBe(401);
    expect(mockMarkAlbumMissing).not.toHaveBeenCalled();
  });
});
