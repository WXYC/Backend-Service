// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors library-delete-permissions.route.test.ts.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

// jest.unit.config.ts's moduleNameMapper sends `@wxyc/authentication` to
// tests/mocks/authentication.mock.ts, which ignores role/permission checks
// entirely — swap in the real implementation so this test actually exercises
// the catalog:write gate.
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

const mockGetFlowsheetPlayImpact = jestGlobals.fn<() => Promise<unknown>>();

// Only enough of the service is stubbed to let library.route's import chain
// resolve without touching a real DB, LML, or lru-cache — mirrors
// library-delete-permissions.route.test.ts's list.
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
  deleteAlbumFromDB: jest.fn(),
  getFlowsheetPlayImpact: mockGetFlowsheetPlayImpact,
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
 * BS#2592. Gated `catalog:['read']`, not `catalog:['write']`: the DELETE this
 * read precedes is write-gated because it ACTS, while this endpoint only
 * counts, and a caller who learns a number still has to clear the DELETE's own
 * bar to use it. Cardinality is read, contents are write — the same rule
 * `GET /artists/:id`'s dependent counts follow (BS#2597).
 *
 * `catalog:['read']` is held by all four roles, `member` included, so NO role
 * is rejected and the per-role cases below are authorization assertions rather
 * than a mix of allow and deny. That is deliberate, not a weakened test: what
 * still has teeth is the unauthenticated 401. If a future change re-narrows
 * this endpoint, the role cases are where that must become visible, so they
 * enumerate every role individually instead of asserting once and trusting the
 * chain — `requirePermissions` checks each role's own flat grant set and the
 * member < dj < musicDirector < stationManager chain is an invariant on the
 * grant data, not a runtime fallback.
 */
describe('GET /library/:id/flowsheet-play-counts — permission tier (BS#2592)', () => {
  beforeEach(() => {
    mockGetFlowsheetPlayImpact
      .mockReset()
      .mockResolvedValue({ outcome: 'found', direct: 0, rotationLinked: 0, legacyLinked: 0 });
  });

  test('a musicDirector-role token is authorized', async () => {
    mockRole('musicDirector');
    const res = await request(app).get('/library/1/flowsheet-play-counts').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetFlowsheetPlayImpact).toHaveBeenCalledWith(1);
  });

  test('a stationManager-role token is authorized', async () => {
    mockRole('stationManager');
    const res = await request(app).get('/library/1/flowsheet-play-counts').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetFlowsheetPlayImpact).toHaveBeenCalledWith(1);
  });

  test('a dj-role token is authorized', async () => {
    mockRole('dj');
    const res = await request(app).get('/library/1/flowsheet-play-counts').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetFlowsheetPlayImpact).toHaveBeenCalledWith(1);
  });

  // `member` is the pre-DJ tier and it holds `catalog:['read']`, so it reaches
  // this endpoint. Acceptable only because these are flowsheet plays and
  // `/playlists/recentEntries` already serves those unauthenticated — pinned
  // here so the consequence of the tier is stated where someone changing it
  // will see it, rather than inferred from the grant matrix.
  test('a member-role token is authorized — read is the pre-DJ tier too', async () => {
    mockRole('member');
    const res = await request(app).get('/library/1/flowsheet-play-counts').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetFlowsheetPlayImpact).toHaveBeenCalledWith(1);
  });

  // The one case that still rejects, and therefore the only proof left that
  // `requirePermissions` is actually mounted on this route rather than the
  // handler being reachable bare.
  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).get('/library/1/flowsheet-play-counts');
    expect(res.status).toBe(401);
    expect(mockGetFlowsheetPlayImpact).not.toHaveBeenCalled();
  });
});
