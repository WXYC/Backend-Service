import { jest } from '@jest/globals';

/**
 * The `flowsheet.service` doubles the BS#2235 operator-close suites share.
 *
 * Two files mock the same five functions and four constants with the same
 * defaults; keeping one copy means the next export the service grows is added
 * once, not once per suite that happened to import it.
 *
 * `jest.mock` factories are hoisted above imports, so a consumer loads this
 * from inside the factory via `jest.requireActual` — not a bare `require`,
 * which `@typescript-eslint/no-require-imports` rejects:
 *
 * ```ts
 * jest.mock('../../../apps/backend/services/flowsheet.service', () =>
 *   jest.requireActual<typeof import('../../mocks/flowsheet-service.mock')>(
 *     '../../mocks/flowsheet-service.mock'
 *   ).createFlowsheetServiceMock()
 * );
 * ```
 *
 * and then reaches the individual fns back through the module registry.
 */
export function createFlowsheetServiceMock() {
  return {
    getOpenShows: jest.fn<(hours?: number, limit?: number) => Promise<unknown>>(),
    getShowById: jest.fn<(id: number) => Promise<unknown>>(),
    endShow: jest.fn<(show: unknown, endedAt?: Date) => Promise<unknown>>(),
    getLatestShow: jest.fn<() => Promise<unknown>>(),
    isLatestEntryShowEnd: jest.fn<(showId: number) => Promise<boolean>>(),
    resolveShowEndInstant: jest.fn<(show: unknown) => Promise<Date>>(),
    OPEN_SHOWS_DEFAULT_WINDOW_HOURS: 168,
    OPEN_SHOWS_MAX_WINDOW_HOURS: 262_800,
    OPEN_SHOWS_DEFAULT_LIMIT: 100,
    OPEN_SHOWS_MAX_LIMIT: 500,
  };
}

/**
 * The quiet baseline every operator-close suite wants between tests: nothing
 * open, the target is not the on-air show, and a fixed end instant.
 */
export function resetFlowsheetServiceMock(mock: ReturnType<typeof createFlowsheetServiceMock>, endInstant: Date) {
  mock.getOpenShows.mockReset().mockResolvedValue({ shows: [], total_in_window: 0, older_open_show_count: 0 });
  mock.getShowById.mockReset();
  mock.endShow.mockReset();
  mock.getLatestShow.mockReset().mockResolvedValue({ id: -1 });
  mock.isLatestEntryShowEnd.mockReset().mockResolvedValue(false);
  mock.resolveShowEndInstant.mockReset().mockResolvedValue(endInstant);
}
