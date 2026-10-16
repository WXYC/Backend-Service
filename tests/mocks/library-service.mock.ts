import { jest } from '@jest/globals';

/**
 * The `library.service` rotation-surface doubles the BS#2109/BS#2113/BS#2410
 * rotation suites share.
 *
 * Three files mock `library.service` for a rotation handler, and all three
 * need the same handful of NON-function exports: the published projection
 * (`toRotationRowSummary`), the two field lists the controller reads off
 * (`ROTATION_SNAPSHOT_COLUMNS`, `ROTATION_PRECATALOG_FIELDS`), and the queue
 * ceiling the controller destructures at module load
 * (`UNCATALOGUED_ROTATION_MAX_LIMIT`). Hand-maintaining that block per suite
 * is the recurring drift hazard tracked in WXYC/Backend-Service#2209 — two of
 * the three copies already carried a comment saying so. One declaration means
 * the next column the projection grows is added once, not once per suite that
 * happened to mock the service.
 *
 * This file is still a hand-written double, so nothing here is derived from
 * `library.service` at compile time. `ROTATION_ROW_SUMMARY_KEYS` is pinned to
 * the real `UNCATALOGUED_ROTATION_PROJECTION` from
 * `tests/unit/services/library.service.uncataloguedRotation.test.ts`, which
 * reads the projection object out of `db.select`'s call args — that pin is
 * what keeps this list honest, not the spread below.
 *
 * These are **value** doubles, not `jest.fn()` stubs, deliberately: the
 * controller routes its 200 through the real `toRotationRowSummary` and its
 * 400 bound through the real ceiling, so a pass-through stub (or an omitted
 * ceiling, which makes `limit > undefined` false and 200s every over-limit
 * request) asserts a shape the endpoint does not return. Per-test function
 * stubs stay in their own suites, where their `mockResolvedValue`s live.
 *
 * `jest.mock` factories are hoisted above imports, so a consumer loads this
 * from inside the factory via `jest.requireActual` — not a bare `require`,
 * which `@typescript-eslint/no-require-imports` rejects — and spreads it over
 * its own per-suite stubs:
 *
 * ```ts
 * jest.mock('../../../apps/backend/services/library.service', () => ({
 *   ...jest.requireActual<typeof import('../../mocks/library-service.mock')>(
 *     '../../mocks/library-service.mock'
 *   ).createLibraryServiceRotationMock(),
 *   getUncataloguedRotationFromDB: mockGetUncataloguedRotationFromDB,
 *   // …
 * }));
 * ```
 *
 * Mirrors `tests/mocks/flowsheet-service.mock.ts`, which documents the same
 * hoisting constraint for the BS#2235 operator-close suites.
 */

/**
 * The published rotation wire shape, as one list. BS#2410 widened it from
 * eight columns to ten (`format_id` + `label_id`); the fake
 * `toRotationRowSummary` below and every consumer that wants to assert the
 * key set read off this single declaration.
 */
export const ROTATION_ROW_SUMMARY_KEYS = [
  'id',
  'album_id',
  'rotation_bin',
  'add_date',
  'kill_date',
  'artist_name',
  'album_title',
  'record_label',
  'format_id',
  'label_id',
] as const;

/** The text trio: what the string-validation loop and the tracklist reset key on. */
export const ROTATION_SNAPSHOT_COLUMNS_DOUBLE = ['artist_name', 'album_title', 'record_label'] as const;

/**
 * The trio plus the two pre-catalog FKs: what the linked-row rejection keys
 * on. Spread from the trio above rather than restating it, exactly as the real
 * `ROTATION_PRECATALOG_FIELDS` is — an anti-drift module should not carry its
 * own copy of the list it exists to keep in one place.
 */
export const ROTATION_PRECATALOG_FIELDS_DOUBLE = [
  ...ROTATION_SNAPSHOT_COLUMNS_DOUBLE,
  'format_id',
  'label_id',
] as const;

export function createLibraryServiceRotationMock() {
  return {
    ROTATION_SNAPSHOT_COLUMNS: ROTATION_SNAPSHOT_COLUMNS_DOUBLE,
    ROTATION_PRECATALOG_FIELDS: ROTATION_PRECATALOG_FIELDS_DOUBLE,
    UNCATALOGUED_ROTATION_MAX_LIMIT: 500,
    toRotationRowSummary: (row: Record<string, unknown> | null | undefined) =>
      Object.fromEntries(ROTATION_ROW_SUMMARY_KEYS.map((key) => [key, row?.[key]])),
  };
}

/**
 * Every function export of `library.service`, each stubbed as a bare
 * `jest.fn()` by `createLibraryServiceMock`. Pinned to the real module by
 * `tests/unit/mocks/library-service.mock.test.ts`, which fails when an export
 * is missing from here — so a new service export is added in this file once,
 * not once per suite that mounts the library controller.
 */
const LIBRARY_SERVICE_FUNCTION_EXPORTS = [
  'getCatalogLastModifiedAt',
  'toReconciledIdentity',
  'serializeReconciledIdentity',
  'getFormatsFromDB',
  'insertFormat',
  'getFormatById',
  'getRotationFromDB',
  'classifyLmlResolveError',
  'addToRotation',
  'deriveLibraryUrlIdentity',
  'replaceLibraryUrls',
  'reconcileLibraryUrlsToLml',
  'setLibraryUrls',
  'listRotationCardsFromDB',
  'addRotationCard',
  'renameRotationCard',
  'deleteRotationCardFromDB',
  'updateRotation',
  'getUncataloguedRotationFromDB',
  'getRotationRowFromDB',
  'linkRotationToAlbum',
  'killRotationInDB',
  'insertAlbum',
  'getDiscogsReleaseIdByLegacyId',
  '__resetRotationLmlLookupCacheForTests',
  '__rotationLmlCacheSizesForWarm',
  'resolveRotationPickerSource',
  'isVariousArtistsName',
  'projectInlineTracklist',
  '__resetReleaseTracklistCacheForTests',
  '__releaseTracklistCacheSizesForWarm',
  'getRotationTracksFromRelease',
  'resolveDiscogsReleasePrefill',
  'libraryRowExists',
  'getDiscogsReleaseIdByLibraryId',
  'getCompilationTracks',
  'writeCompilationTracks',
  'getCompilationTrackSuggestions',
  'updateOnStreaming',
  'updateArtworkUrl',
  'mapLookupToCanonicalEntity',
  'updateCanonicalEntity',
  'classifyArtworkEnrichOutcome',
  'enrichWithArtwork',
  'runCatalogTrackSearchCascade',
  'fuzzySearchLibrary',
  'getArtistNameById',
  'searchArtistsInGenre',
  'artistIdFromName',
  'conflictingArtistIdForRename',
  'insertArtistWithGenreCrossreference',
  'getArtistByCode',
  'getArtistsByCode',
  'browseArtistsInCodeBucket',
  'getArtistById',
  'getArtistCardById',
  'getArtistCardByIdInGenre',
  'getArtistDependentCounts',
  'updateArtistInDB',
  'assertRefileLettersAllowed',
  'refileArtistInGenre',
  'deleteArtistFromDB',
  'getReleasesForArtist',
  'countReleasesForArtist',
  'getArtistCrossReferences',
  'countArtistCrossReferences',
  'getReleaseCrossReferences',
  'countReleaseCrossReferences',
  'getDeletedArchivePage',
  'countDeletedArchiveBatches',
  'isRestorableEntityKind',
  'librarySlotKey',
  'librarySlotVolumeLetterMatchSql',
  'peekArtistShelf',
  'findLibrarySlotOccupant',
  'nullDanglingSetNullReferences',
  'dropOrphanedCascadeRows',
  'restoreDeletedBatch',
  'generateAlbumCodeNumber',
  'generateArtistNumber',
  'updateAlbumInDB',
  'getLibraryRowById',
  'recheckDiscogsAvailability',
  'getFlowsheetPlayImpact',
  'deleteAlbumFromDB',
  'albumCodeNumberTaken',
  'artistExistsInGenre',
  'getAlbumFromDB',
  'getAlbumIdByLegacyId',
  'getAlbumByLegacyId',
  'getDiscogsUnavailableFlagsById',
  'markAlbumMissing',
  'markAlbumFound',
  'getGenresFromDB',
  'genreExists',
  'insertGenre',
  'isISODate',
  'searchLibrary',
  'findSimilarArtist',
  'searchAlbumsByTitle',
  'libraryServiceCachesForPeriodicEmit',
  '__resetTrackSearchCacheForTests',
  'searchLibraryByTrackRaw',
  'searchLibraryByTrack',
  'searchByArtist',
  'searchLibraryByCTARaw',
  'searchLibraryByCTA',
  'filterResultsByArtist',
] as const;

/**
 * The non-function, non-rotation value exports. Numeric and string constants
 * carry their real values; the lookup tables the restore path walks are empty
 * stand-ins, since no mocked-service suite reads them. What matters is that
 * none is `undefined` (see the guard test).
 */
const LIBRARY_SERVICE_VALUE_DOUBLES = {
  LIBRARY_VIEW_PROJECTION_RAW: {},
  ARTIST_CODE_BUCKET_MAX_LIMIT: 500,
  DELETE_ARTIST_LOCK_TIMEOUT_MS: 750,
  REFILE_ARTIST_LOCK_TIMEOUT_MS: 750,
  RESTORE_BATCH_ADVISORY_LOCK_KEY: 20260919,
  RESTORE_BATCH_LOCK_TIMEOUT_MS: 750,
  SET_NULL_REFERENCES: {},
  DEFERRED_SET_NULL_REFERENCES: {},
  CASCADE_DROP_REFERENCES: {},
  REFUSE_REFERENCES: {},
  RESTORE_PLAN_REPLAYED_TABLE_NAMES: [] as readonly string[],
  RESTORE_PLAN_TABLE_NAMES: [] as readonly string[],
  RESTORABLE_ENTITY_KINDS: [] as readonly string[],
  NON_BLOCKING_DIGITAL_ASSET_STATUS: 'rejected',
  DELETE_ALBUM_LOCK_TIMEOUT_MS: 750,
};

/** Stand-in with the real constructor shape, so `instanceof` arms are exercisable against the mocked module. */
class RotationCardBinMismatchErrorDouble extends Error {
  constructor(cardId: number, cardBin: string, rotationBin: string) {
    super(
      `Rotation card ${cardId} is filed in bin '${cardBin}', but the rotation row is bound for bin '${rotationBin}'`
    );
    this.name = 'RotationCardBinMismatchError';
  }
}

type FunctionExportName = (typeof LIBRARY_SERVICE_FUNCTION_EXPORTS)[number];

/**
 * The full `library.service` export surface as a `jest.mock` factory result:
 * `jest.fn()` for every function, real values for the constants, the rotation
 * value doubles above, identity pass-throughs for the two serializers, and the
 * `RotationCardBinMismatchError` stand-in. `overrides` swaps in a suite's own
 * `jest.fn()` handles, so per-test behaviour stays in the suite:
 *
 * ```ts
 * jest.mock('../../../apps/backend/services/library.service', () =>
 *   jest.requireActual<typeof import('../../mocks/library-service.mock')>(
 *     '../../mocks/library-service.mock'
 *   ).createLibraryServiceMock({ getAlbumFromDB: mockGetAlbumFromDB })
 * );
 * ```
 */
export function createLibraryServiceMock(overrides: Partial<Record<string, unknown>> = {}) {
  const functionStubs = Object.fromEntries(LIBRARY_SERVICE_FUNCTION_EXPORTS.map((name) => [name, jest.fn()])) as Record<
    FunctionExportName,
    jest.Mock
  >;
  return {
    ...functionStubs,
    ...LIBRARY_SERVICE_VALUE_DOUBLES,
    ...createLibraryServiceRotationMock(),
    serializeLibraryArtistViewEntry: (row: unknown) => row,
    serializeArtist: (row: unknown) => row,
    RotationCardBinMismatchError: RotationCardBinMismatchErrorDouble,
    ...overrides,
  };
}
