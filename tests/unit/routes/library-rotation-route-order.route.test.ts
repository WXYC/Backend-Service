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
 * original #2164 note could never actually collide — only a literal
 * registered for the SAME method as the parameterized route can be shadowed.
 * The order assertion was kept because that future was cheap to arrive at and
 * expensive to debug, and the classifier below is deliberately narrow so it
 * flags only genuinely shadowable paths.
 *
 * **That future arrived in WXYC/Backend-Service#2410**, which registers
 * `GET /rotation/:id` alongside the literal `GET /rotation/uncatalogued` —
 * the first genuine same-method hazard on this router, and exactly the case
 * the narrow classifier exists to flag. The header reasoning above is still
 * correct as written; what changed is that the assertions are now scoped BY
 * METHOD, because "registered earlier in the stack" only shadows within one
 * method.
 *
 * Two levels of coverage:
 *   1. Structural — inspect the Express router's own `.stack` to assert the
 *      registration order directly, per method.
 *   2. Behavioral — a request to the literal `/rotation/:rotation_id/tracks`
 *      path still reaches its own handler rather than being captured by
 *      `/rotation/:id`, and `GET /rotation/uncatalogued` still reaches the
 *      queue handler rather than the new single-row read.
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
const mockGetUncataloguedRotationFromDB = jestGlobals.fn<() => Promise<unknown[]>>();
const mockGetRotationRowFromDB = jestGlobals.fn<() => Promise<unknown>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  // Real projection and real field lists, not stubs: the controller routes
  // its 200 through `toRotationRowSummary` and reads the two field lists for
  // its validation loop and its 409 message, so a pass-through mock would
  // assert a shape the endpoint does not return. One shared declaration
  // rather than a per-suite copy — value and helper exports drifting out of
  // these hand-maintained mocks is WXYC/Backend-Service#2209.
  ...jest
    .requireActual<typeof import('../../mocks/library-service-rotation.mock')>(
      '../../mocks/library-service-rotation.mock'
    )
    .createLibraryServiceRotationMock(),
  getUncataloguedRotationFromDB: mockGetUncataloguedRotationFromDB,
  getRotationRowFromDB: mockGetRotationRowFromDB,
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

describe('library.route rotation ordering (BS#2113, BS#2410)', () => {
  // Scoped by method: a Layer whose Route does not handle the request method
  // never matches, so `/rotation/uncatalogued` (GET) is shadowable by
  // `/rotation/:id`'s GET registration and untouchable by its PATCH one.
  // Asserting across all methods at once would have flagged the pre-#2410
  // router — where the only parameterized registration was a PATCH — as a
  // defect it did not have.
  test.each([['get'], ['patch']])(
    'every literal one-segment /rotation/<name> %s route is registered before the same-method /rotation/:id',
    (method) => {
      const layers = rotationLayers().filter((l) => l.methods.includes(method));
      const paramLayerIndex = layers.findIndex((l) => l.path === PARAM_PATH);

      expect(paramLayerIndex).toBeGreaterThan(-1);

      const shadowableIndices = layers
        .map((l, i) => ({ i, path: l.path }))
        .filter((l) => isShadowableByRotationIdParam(l.path))
        .map((l) => l.i);

      for (const index of shadowableIndices) {
        expect(index).toBeLessThan(paramLayerIndex);
      }
    }
  );

  // The GET arm above is only load-bearing while a shadowable literal exists
  // to order against. Before #2410 there was none and the assertion was
  // vacuous; this pins that at least one genuinely-shadowable same-method
  // literal is present, so a router that lost `/rotation/uncatalogued` can't
  // quietly satisfy the ordering test by having nothing left to shadow.
  test('the GET pair is a real same-method hazard, not a vacuous assertion', () => {
    const getLayers = rotationLayers().filter((l) => l.methods.includes('get'));

    expect(getLayers.filter((l) => isShadowableByRotationIdParam(l.path)).map((l) => l.path)).toContain(
      '/rotation/uncatalogued'
    );
    expect(getLayers.some((l) => l.path === PARAM_PATH)).toBe(true);
  });

  test('registers exactly one handler per method on /rotation/:id (GET read, PATCH write)', () => {
    const layers = rotationLayers();
    const paramLayers = layers.filter((l) => l.path === '/rotation/:id');

    // One Layer per `library_route.<method>()` call, so the two registrations
    // are two entries rather than one entry with two methods.
    expect(
      paramLayers
        .map((l) => l.methods)
        .flat()
        .sort()
    ).toEqual(['get', 'patch']);
  });

  test('a request to the literal /rotation/:rotation_id/tracks path still reaches its own handler', async () => {
    mockRole('dj');
    mockGetRotationTracksFromRelease.mockResolvedValue([]);
    mockResolveRotationPickerSource.mockResolvedValue({ releaseId: 5, inlineTracklist: null });

    const res = await request(app).get('/library/rotation/5/tracks').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(mockUpdateRotation).not.toHaveBeenCalled();
  });

  // The behavioral half of the same-method hazard: ordering asserted on the
  // stack is one thing, dispatch actually honouring it is another.
  test('GET /rotation/uncatalogued reaches the queue handler, not the new single-row read', async () => {
    mockRole('dj');
    mockGetUncataloguedRotationFromDB.mockReset().mockResolvedValue([]);
    mockGetRotationRowFromDB.mockReset();

    const res = await request(app).get('/library/rotation/uncatalogued').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(mockGetUncataloguedRotationFromDB).toHaveBeenCalledTimes(1);
    expect(mockGetRotationRowFromDB).not.toHaveBeenCalled();
  });
});

describe('GET /library/rotation/:id — permission tier (BS#2410, catalog:read)', () => {
  beforeEach(() => {
    mockGetRotationRowFromDB.mockReset().mockResolvedValue({ id: 5, album_id: null, artist_name: 'Juana Molina' });
  });

  // Deliberately a LOWER tier than the PATCH on the same path: the single-row
  // read matches its read siblings (`GET /rotation`,
  // `GET /rotation/uncatalogued`), not the editor.
  test('a dj-role token (catalog:read only) is authorized', async () => {
    mockRole('dj');
    const res = await request(app).get('/library/rotation/5').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(mockGetRotationRowFromDB).toHaveBeenCalledWith(5);
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).get('/library/rotation/5');

    expect(res.status).toBe(401);
    expect(mockGetRotationRowFromDB).not.toHaveBeenCalled();
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
