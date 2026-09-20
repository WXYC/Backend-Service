// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors library-crossreferences-permissions.route.test.ts.
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
import type { DeletedArchiveBatch, RestoreBatchOutcome } from '../../../apps/backend/services/library.service';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

function mockRole(role: string) {
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', role },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });
}

const mockGetDeletedArchivePage = jestGlobals.fn<() => Promise<DeletedArchiveBatch[]>>();
const mockCountDeletedArchiveBatches = jestGlobals.fn<() => Promise<number>>();
const mockRestoreDeletedBatch = jestGlobals.fn<() => Promise<RestoreBatchOutcome>>();

// Collaborator mocks below mirror library-crossreferences-permissions.route.test.ts
// -- only enough is stubbed here to let library.route's import chain resolve
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
  insertArtistWithGenreCrossreference: jest.fn(),
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
  getArtistCrossReferences: jest.fn(),
  countArtistCrossReferences: jest.fn(),
  getReleaseCrossReferences: jest.fn(),
  countReleaseCrossReferences: jest.fn(),
  getDeletedArchivePage: mockGetDeletedArchivePage,
  countDeletedArchiveBatches: mockCountDeletedArchiveBatches,
  restoreDeletedBatch: mockRestoreDeletedBatch,
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
 * GET /library/deleted (BS#2561 / F2a) is a `catalog: ['write']` READ, same
 * bar as `/crossreferences/*` and `/bmi-performance-list` above it in
 * `library.route.ts` -- it exposes deleted-card contents plus the deleter's
 * identity, which `library_delete_denylist`'s docstring treats as audit data.
 * `catalog: ['read']` would put it in front of every DJ. Acceptance criterion
 * from the BS#2561 issue: "Write-gating pinned by a test: a catalog: ['read']
 * principal is refused."
 */
describe('GET /library/deleted -- permission tier', () => {
  beforeEach(() => {
    mockGetDeletedArchivePage.mockReset().mockResolvedValue([]);
    mockCountDeletedArchiveBatches.mockReset().mockResolvedValue(0);
  });

  test.each(['stationManager', 'musicDirector'])('a %s-role token is authorized', async (role) => {
    mockRole(role);
    const res = await request(app).get('/library/deleted').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetDeletedArchivePage).toHaveBeenCalled();
  });

  test.each(['dj', 'member'])('a %s-role token (catalog:read only) is rejected', async (role) => {
    mockRole(role);
    const res = await request(app).get('/library/deleted').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockGetDeletedArchivePage).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).get('/library/deleted');
    expect(res.status).toBe(401);
    expect(mockGetDeletedArchivePage).not.toHaveBeenCalled();
  });

  test('an empty archive answers 200 with an empty page', async () => {
    mockRole('musicDirector');
    const res = await request(app).get('/library/deleted').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], total: 0, page: 0, totalPages: 0 });
  });
});

/**
 * POST /library/deleted/:batchId/restore (BS#2585 / F2b) shares this file
 * rather than starting a second one: the ~130 lines of collaborator mocks above
 * exist so `library.route.ts`'s import chain resolves without a DB, and the
 * restore is the write half of the same `/library/deleted` family, at the same
 * `catalog: ['write']` bar. A second file would fork that scaffolding, and the
 * two copies would drift the first time the route module grows an import.
 *
 * The tier argument is stronger here than for the listing, and the same: this
 * verb writes catalog rows back, so `catalog: ['read']` would put a catalog
 * mutation in front of every DJ.
 */
describe('POST /library/deleted/:batchId/restore -- permission tier', () => {
  const BATCH_ID = '11111111-2222-4333-8444-555555555555';
  const url = `/library/deleted/${BATCH_ID}/restore`;

  beforeEach(() => {
    mockRestoreDeletedBatch.mockReset().mockResolvedValue({ outcome: 'restored', entities: [] });
  });

  test.each(['stationManager', 'musicDirector'])('a %s-role token is authorized', async (role) => {
    mockRole(role);
    const res = await request(app).post(url).set('Authorization', 'Bearer test-token').send({});
    expect(res.status).toBe(200);
    expect(mockRestoreDeletedBatch).toHaveBeenCalled();
  });

  test.each(['dj', 'member'])('a %s-role token (catalog:read only) is rejected', async (role) => {
    mockRole(role);
    const res = await request(app).post(url).set('Authorization', 'Bearer test-token').send({});
    expect(res.status).toBe(403);
    expect(mockRestoreDeletedBatch).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(401);
    expect(mockRestoreDeletedBatch).not.toHaveBeenCalled();
  });

  // The literal `/deleted` head and literal `/restore` tail mean no templated
  // route on this router can swallow this URL, but the resolution arm still has
  // to survive Express's body parsing to reach the service.
  test('carries the resolution arm through to the service', async () => {
    mockRole('musicDirector');
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer test-token')
      .send({ resolution: 'next_free_code' });
    expect(res.status).toBe(200);
    expect(mockRestoreDeletedBatch).toHaveBeenCalledWith(BATCH_ID, 'next_free_code');
  });
});
