/**
 * BS#2109 route-ordering guardrail for `GET /library/rotation/uncatalogued`.
 *
 * Express matches route layers in registration order, so a templated
 * `/rotation/:something` GET registered ahead of the literal
 * `/rotation/uncatalogued` would swallow the queue endpoint and hand
 * `'uncatalogued'` to the parameterized handler as an id. The ordering is
 * correct as written — and WXYC/Backend-Service#2113's `PATCH /rotation/:id`
 * cannot collide with it in any case, differing in both method and segment
 * count — but the acceptance criteria ask for the guardrail explicitly, and
 * #2113 adds a parameterized route to this very block.
 *
 * Two assertions:
 *   1. Static — over the registered layer list, the literal path precedes
 *      any single-segment `/rotation/:param` GET.
 *   2. Functional — a real request for `/library/rotation/uncatalogued`
 *      reaches `getUncataloguedRotation`, not some `:id`-shaped handler.
 *
 * Collaborator mocks below mirror
 * `tests/unit/routes/library-genres-permissions.route.test.ts` — only enough
 * is stubbed to let `library.route`'s import chain resolve without touching a
 * real DB, LML, or lru-cache. `@wxyc/authentication` resolves to
 * `tests/mocks/authentication.mock.ts` via jest.unit.config.ts's
 * moduleNameMapper, whose `requirePermissions` only checks for an
 * Authorization header — permission tiers are not what this file tests.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetUncataloguedRotationFromDB = jest.fn<() => Promise<unknown[]>>();

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
  getUncataloguedRotationFromDB: mockGetUncataloguedRotationFromDB,
  linkRotationToAlbum: jest.fn(),
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

type RouteLayer = { route?: { path?: unknown; methods?: Record<string, boolean> } };

/** Registered GET paths, in registration order. */
function registeredGetPaths(): string[] {
  const stack = (library_route as unknown as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer) => layer.route?.methods?.get)
    .map((layer) => layer.route?.path)
    .filter((path): path is string => typeof path === 'string');
}

describe('GET /library/rotation/uncatalogued — route registration order (BS#2109)', () => {
  test('the literal path is registered ahead of any single-segment /rotation/:param GET', () => {
    const paths = registeredGetPaths();

    const literalIndex = paths.indexOf('/rotation/uncatalogued');
    expect(literalIndex).toBeGreaterThanOrEqual(0);

    const shadowingIndex = paths.findIndex((path) => /^\/rotation\/:[^/]+$/.test(path));
    if (shadowingIndex >= 0) {
      expect(literalIndex).toBeLessThan(shadowingIndex);
    }
  });

  test('a request for the literal path reaches getUncataloguedRotation, not a :id handler', async () => {
    const rows = [{ id: 7007, album_id: null, artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' }];
    mockGetUncataloguedRotationFromDB.mockReset().mockResolvedValue(rows);

    const res = await request(app).get('/library/rotation/uncatalogued').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(mockGetUncataloguedRotationFromDB).toHaveBeenCalledTimes(1);
  });

  test('a hypothetical /rotation/:id GET registered after the literal still cannot shadow it', async () => {
    // Simulates WXYC/Backend-Service#2113 landing its parameterized route in
    // this block: as long as it is registered AFTER, the literal wins. The
    // sub-app is disposable — the real router is untouched.
    const shadowApp = express();
    const shadowRouter = express.Router();
    const paramHandler = jest.fn((_req: express.Request, res: express.Response) => res.status(200).json('param'));
    shadowRouter.get('/rotation/uncatalogued', (_req, res) => {
      res.status(200).json('literal');
    });
    shadowRouter.get('/rotation/:rotation_id', paramHandler);
    shadowApp.use('/library', shadowRouter);

    const res = await request(shadowApp).get('/library/rotation/uncatalogued');

    expect(res.body).toBe('literal');
    expect(paramHandler).not.toHaveBeenCalled();
  });
});
