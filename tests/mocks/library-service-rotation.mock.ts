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
 *   ...jest.requireActual<typeof import('../../mocks/library-service-rotation.mock')>(
 *     '../../mocks/library-service-rotation.mock'
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
