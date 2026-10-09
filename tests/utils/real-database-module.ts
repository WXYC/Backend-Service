/**
 * A `@wxyc/database` module double that keeps the real, client-free parts of
 * the package: the Drizzle schema plus every pure module the barrel re-exports
 * that a service under unit test imports (`ny-time`, `staff-name`, `sqlstate`). `db` is a
 * client-less `drizzle({})` that builds SQL but never connects.
 *
 * Use it from specs that render and assert the real SQL a service builds. Use
 * the hand-written double `tests/mocks/database.mock.ts` (mapped in by
 * `jest.unit.config.ts`) when a spec only needs table-qualified column
 * sentinels.
 *
 * Add a new pure export from `shared/database/src` here once, not to each spec.
 *
 * `jest.mock` factories are hoisted and may not close over imports, so require
 * the helper inside the factory:
 *
 *   jest.mock('@wxyc/database', () =>
 *     jest.requireActual('../../utils/real-database-module').realDatabaseModule({ db: scriptedDb }),
 *   );
 *
 * A spec that also needs the real drizzle-orm must call `jest.unmock('drizzle-orm')`.
 *
 * @param overrides - Spread last, so they win: a spy for a schema export or a stand-in `db`.
 */
export function realDatabaseModule(overrides: Record<string, unknown> = {}): Record<string, any> {
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  return {
    ...jest.requireActual('../../shared/database/src/schema'),
    ...jest.requireActual('../../shared/database/src/ny-time'),
    ...jest.requireActual('../../shared/database/src/staff-name'),
    ...jest.requireActual('../../shared/database/src/sqlstate'),
    db: drizzle({}),
    ...overrides,
  };
}
