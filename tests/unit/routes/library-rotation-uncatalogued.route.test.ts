/**
 * BS#2109 route-ordering guardrail for `GET /library/rotation/uncatalogued`.
 *
 * Express matches route layers in registration order, so a templated
 * `/rotation/:something` GET registered ahead of the literal
 * `/rotation/uncatalogued` would swallow the queue endpoint and hand
 * `'uncatalogued'` to the parameterized handler as an id.
 *
 * **The hazard stopped being hypothetical in WXYC/Backend-Service#2410.**
 * #2113's `PATCH /rotation/:id` could not collide with this GET in any case
 * — it differs in method, and Express falls through a layer whose Route does
 * not handle the request method. #2410's `GET /rotation/:id` is the first
 * parameterized route on this router that shares BOTH the method and the
 * segment count, so the assertions below are now load-bearing rather than
 * vacuous, and they assert the parameterized GET exists rather than skipping
 * when it doesn't.
 *
 * Three assertions:
 *   1. Static — over the registered layer list, the literal path precedes
 *      the single-segment `/rotation/:param` GET, which must exist.
 *   2. Functional — a real request for `/library/rotation/uncatalogued`
 *      reaches `getUncataloguedRotation`, not the `:id`-shaped handler.
 *   3. Functional — a real request for `/library/rotation/<digits>` does
 *      reach the `:id` handler, so assertion 2 is proving an ordering rather
 *      than the absence of a competitor.
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
const mockGetRotationRowFromDB = jest.fn<() => Promise<unknown>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  // The projection, the two field lists, and the queue ceiling come from the
  // shared rotation double (WXYC/Backend-Service#2209) rather than being
  // restated here. This suite mounts the whole `library.route`, so it loads a
  // controller that destructures `UNCATALOGUED_ROTATION_MAX_LIMIT` at module
  // load — omitting it left the ceiling `undefined`, which is the drift its
  // two sibling suites already guarded against by hand. (`GET /rotation/:id`
  // itself does NOT route through `toRotationRowSummary`: its service query
  // already projects the published column set — see `getRotationRowFromDB`.)
  ...jest
    .requireActual<typeof import('../../mocks/library-service-rotation.mock')>(
      '../../mocks/library-service-rotation.mock'
    )
    .createLibraryServiceRotationMock(),
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
  getRotationRowFromDB: mockGetRotationRowFromDB,
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

describe('GET /library/rotation/uncatalogued — route registration order (BS#2109, BS#2410)', () => {
  test('the literal path is registered ahead of the single-segment /rotation/:param GET', () => {
    const paths = registeredGetPaths();

    const literalIndex = paths.indexOf('/rotation/uncatalogued');
    expect(literalIndex).toBeGreaterThanOrEqual(0);

    // BS#2410 registers `GET /rotation/:id`. The competitor is no longer
    // hypothetical, so its absence is a failure rather than a skip: an
    // `if (shadowingIndex >= 0)` guard would pass just as happily on a
    // router that lost the single-row read entirely.
    const shadowingIndex = paths.findIndex((path) => /^\/rotation\/:[^/]+$/.test(path));
    expect(shadowingIndex).toBeGreaterThanOrEqual(0);
    expect(literalIndex).toBeLessThan(shadowingIndex);
  });

  test('a request for the literal path reaches getUncataloguedRotation, not the :id handler', async () => {
    const rows = [{ id: 7007, album_id: null, artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' }];
    mockGetUncataloguedRotationFromDB.mockReset().mockResolvedValue(rows);
    mockGetRotationRowFromDB.mockReset();

    const res = await request(app).get('/library/rotation/uncatalogued').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(mockGetUncataloguedRotationFromDB).toHaveBeenCalledTimes(1);
    expect(mockGetRotationRowFromDB).not.toHaveBeenCalled();
  });

  // The negative above only means something if the parameterized GET is
  // reachable at all. Without this, deleting `GET /rotation/:id` from the
  // router would leave the whole block green.
  test('a numeric single segment does reach the :id handler (BS#2410)', async () => {
    const row = { id: 7007, album_id: null, artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' };
    mockGetUncataloguedRotationFromDB.mockReset();
    mockGetRotationRowFromDB.mockReset().mockResolvedValue(row);

    const res = await request(app).get('/library/rotation/7007').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(mockGetRotationRowFromDB).toHaveBeenCalledWith(7007);
    expect(mockGetUncataloguedRotationFromDB).not.toHaveBeenCalled();
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
