// Each integration spec file gets its own module registry and so its own getTestDb() pool, and none of them ends
// it. The pool's idle timeout is what releases a finished file's connections (WXYC/Backend-Service#2904), so it
// must stay short enough that the pools of recently finished files don't pile up against max_connections.
const mockPostgres = jest.fn(() => ({ end: jest.fn() }));
jest.mock('postgres', () => mockPostgres);

describe('getTestDb pool options', () => {
  it('closes idle connections within two seconds', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTestDb } = require('../../utils/db');
    getTestDb();
    const options = (mockPostgres.mock.calls[0] as unknown[])[0] as { idle_timeout: unknown };
    // 0 means "never close idle connections" to postgres.js, so it must fail along with null and undefined.
    expect(typeof options.idle_timeout).toBe('number');
    expect(options.idle_timeout as number).toBeGreaterThan(0);
    expect(options.idle_timeout as number).toBeLessThanOrEqual(2);
  });
});
