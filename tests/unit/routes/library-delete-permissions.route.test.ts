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
// wired back in to actually exercise the catalog:write gate.
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

const mockDeleteAlbumFromDB = jestGlobals.fn<() => Promise<{ outcome: string }>>();

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
  recheckDiscogsAvailability: jest.fn(),
  deleteAlbumFromDB: mockDeleteAlbumFromDB,
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
 * BS#2112. `DELETE /library/:id` is the most destructive endpoint in this
 * service — it removes a catalog row and cascades away its rotation history,
 * metadata, and reviews, with no undo. It is gated to `catalog:['write']`
 * (musicDirector+), the same bar as `updateAlbum`/`addAlbum`.
 *
 * The bar deliberately is NOT `catalog:['read']`, which the sibling
 * `/:id/missing` and `/:id/found` routes use so DJs can flag a stack while
 * pulling records (BS#393). Those are reversible one-column flags; this is
 * not. A future refactor that copies the neighbouring routes' lighter bar
 * would hand every DJ an irreversible catalog delete — hence this test.
 *
 * `jest.requireActual` above defeats the unit-suite auth stub so the real
 * `requirePermissions` gate is what answers here.
 */
describe('DELETE /library/:id — permission tier (BS#2112)', () => {
  beforeEach(() => {
    mockDeleteAlbumFromDB.mockReset().mockResolvedValue({ outcome: 'deleted' });
  });

  test('a musicDirector-role token is authorized', async () => {
    mockRole('musicDirector');
    const res = await request(app).delete('/library/1').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(204);
    expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(1);
  });

  test('a stationManager-role token is authorized', async () => {
    mockRole('stationManager');
    const res = await request(app).delete('/library/1').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(204);
    expect(mockDeleteAlbumFromDB).toHaveBeenCalledWith(1);
  });

  test('a dj-role token (catalog:read only) is rejected', async () => {
    mockRole('dj');
    const res = await request(app).delete('/library/1').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
  });

  test('a member-role token (catalog:read only) is rejected', async () => {
    mockRole('member');
    const res = await request(app).delete('/library/1').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).delete('/library/1');
    expect(res.status).toBe(401);
    expect(mockDeleteAlbumFromDB).not.toHaveBeenCalled();
  });
});
