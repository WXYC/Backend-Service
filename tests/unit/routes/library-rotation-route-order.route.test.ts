/**
 * BS#2113: `PATCH /library/rotation/:id` must be registered AFTER every
 * literal one-segment `/rotation/<name>` route on this router — a
 * parameterized route registered earlier would shadow a more specific
 * literal path (e.g. a future `PATCH /rotation/uncatalogued` from
 * WXYC/Backend-Service#2109, which lands in this same route block).
 *
 * SCOPE OF THE HAZARD. Express does NOT match on path alone: in the router's
 * dispatch loop a Layer whose Route does not handle the request method sets
 * `match = false` and dispatch falls through to the next layer. So the
 * `GET /rotation/uncatalogued` vs. `PATCH /rotation/:id` pair cited in the
 * original #2164 note could never actually collide — only a future literal
 * registered for the SAME method as the parameterized route can be shadowed.
 * The order assertion is kept because that future is cheap to arrive at
 * (#2109 adding a `PATCH /rotation/uncatalogued`, say) and expensive to
 * debug, but the classifier below is deliberately narrow so it flags only
 * genuinely shadowable paths.
 *
 * Two levels of coverage:
 *   1. Structural — inspect the Express router's own `.stack` to assert the
 *      registration order directly.
 *   2. Behavioral — a request to the literal `/rotation/:rotation_id/tracks`
 *      path still reaches its own handler rather than being captured by
 *      `/rotation/:id`.
 *
 * Mirrors the mock scaffolding of
 * tests/unit/routes/library-discogs-recheck-permissions.route.test.ts —
 * only enough is stubbed to let library.route's import chain resolve
 * without touching a real DB, LML, or lru-cache.
 */
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

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

const mockGetRotationTracksFromRelease = jestGlobals.fn<() => Promise<unknown[] | null>>();
const mockResolveRotationPickerSource = jestGlobals.fn<() => Promise<unknown>>();
// The linked/unlinked precondition (BS#2113 review finding 4) is now a
// compare-and-set inside the service, so it resolves an outcome rather than
// a bare row — see `library.controller.test.ts` for the full shape.
type UpdateRotationOutcome =
  | { outcome: 'updated'; rotation: Record<string, unknown> }
  | { outcome: 'not_found' }
  | { outcome: 'linked_conflict'; albumId: number };
const mockUpdateRotation = jestGlobals.fn<() => Promise<UpdateRotationOutcome>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
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
  resolveRotationPickerSource: mockResolveRotationPickerSource,
  getRotationTracksFromRelease: mockGetRotationTracksFromRelease,
  getLibraryRowById: jest.fn(),
  updateAlbumInDB: jest.fn(),
  artistExistsInGenre: jest.fn(),
  albumCodeNumberTaken: jest.fn(),
  recheckDiscogsAvailability: jest.fn(),
  updateRotation: mockUpdateRotation,
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

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };

const PARAM_PATH = '/rotation/:id';

/**
 * Is `path` a route that `/rotation/:id` could shadow?
 *
 * Only if it is exactly ONE literal segment below `/rotation`. `:id` matches
 * a single path segment, so:
 *   - `/rotation` itself is above it, not under it — unreachable.
 *   - `/rotation/:rotation_id/tracks` (and a hypothetical
 *     `/rotation/:id/notes`) is two segments deep — also unreachable, and
 *     flagging it would fail this suite for a change with no defect in it.
 *     That over-broad classification is what this predicate replaced.
 *   - a parameterized sibling (`/rotation/:other`) is not a literal, so
 *     ordering it is meaningless — the first one registered wins either way.
 */
function isShadowableByRotationIdParam(path: string): boolean {
  return /^\/rotation\/[^/:][^/]*$/.test(path);
}

function rotationLayers() {
  return (library_route.stack as RouteLayer[])
    .map((layer) => layer.route)
    .filter(
      (route): route is NonNullable<RouteLayer['route']> => route !== undefined && route.path.startsWith('/rotation')
    )
    .map((route) => ({ path: route.path, methods: Object.keys(route.methods) }));
}

describe('rotation route shadowing classifier (BS#2113)', () => {
  test.each([
    ['/rotation/uncatalogued', true],
    ['/rotation/catalog', true],
    ['/rotation', false],
    ['/rotation/:id', false],
    ['/rotation/:other', false],
    ['/rotation/:rotation_id/tracks', false],
    ['/rotation/:id/notes', false],
    ['/rotation/uncatalogued/notes', false],
  ])('classifies %s as shadowable=%s', (path, expected) => {
    expect(isShadowableByRotationIdParam(path)).toBe(expected);
  });
});

describe('library.route rotation ordering (BS#2113)', () => {
  test('every literal one-segment /rotation/<name> route is registered before /rotation/:id', () => {
    const layers = rotationLayers();
    const paramLayerIndex = layers.findIndex((l) => l.path === PARAM_PATH);

    expect(paramLayerIndex).toBeGreaterThan(-1);

    // No shadowable literal exists on this router today — `/rotation` and
    // `/rotation/:rotation_id/tracks` are both out of `:id`'s reach — so this
    // assertion is vacuously true until #2109 (or a successor) adds one.
    // The classifier itself is pinned by the table above so it can't rot in
    // the meantime.
    const shadowableIndices = layers
      .map((l, i) => ({ i, path: l.path }))
      .filter((l) => isShadowableByRotationIdParam(l.path))
      .map((l) => l.i);

    for (const index of shadowableIndices) {
      expect(index).toBeLessThan(paramLayerIndex);
    }
  });

  test('registers exactly one PATCH handler on /rotation/:id', () => {
    const layers = rotationLayers();
    const paramLayers = layers.filter((l) => l.path === '/rotation/:id');

    expect(paramLayers).toHaveLength(1);
    expect(paramLayers[0].methods).toEqual(['patch']);
  });

  test('a request to the literal /rotation/:rotation_id/tracks path still reaches its own handler', async () => {
    mockRole('dj');
    mockGetRotationTracksFromRelease.mockResolvedValue([]);
    mockResolveRotationPickerSource.mockResolvedValue({ releaseId: 5, inlineTracklist: null });

    const res = await request(app).get('/library/rotation/5/tracks').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(mockUpdateRotation).not.toHaveBeenCalled();
  });
});

describe('PATCH /library/rotation/:id — permission tier (BS#2113, catalog:write)', () => {
  beforeEach(() => {
    mockUpdateRotation
      .mockReset()
      .mockResolvedValue({ outcome: 'updated', rotation: { id: 5, artist_name: 'Juana Molina' } });
  });

  test('a musicDirector-role token is authorized', async () => {
    mockRole('musicDirector');
    const res = await request(app)
      .patch('/library/rotation/5')
      .set('Authorization', 'Bearer test-token')
      .send({ artist_name: 'Juana Molina' });

    expect(res.status).toBe(200);
    expect(mockUpdateRotation).toHaveBeenCalledWith(5, { artist_name: 'Juana Molina' });
  });

  test('a dj-role token (catalog:read only) is rejected', async () => {
    mockRole('dj');
    const res = await request(app)
      .patch('/library/rotation/5')
      .set('Authorization', 'Bearer test-token')
      .send({ artist_name: 'Juana Molina' });

    expect(res.status).toBe(403);
    expect(mockUpdateRotation).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).patch('/library/rotation/5').send({ artist_name: 'Juana Molina' });

    expect(res.status).toBe(401);
    expect(mockUpdateRotation).not.toHaveBeenCalled();
  });
});
