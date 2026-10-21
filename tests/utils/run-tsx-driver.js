/**
 * Runs a TypeScript driver under `tsx` in a child process, for integration specs.
 *
 * The integration runner is babel-jest with no TypeScript support, so a spec that needs the REAL production code
 * spawns a small driver in `tests/utils/` instead (`run-catalog-export-flag-reconcile.ts`,
 * `run-concerts-resolve-artist-id.ts`). The child binds to the same test database as the spec. `@wxyc/database` logs
 * on import, so the driver prints its payload on one `<MARKER>:<json>` line, and this helper returns that JSON parsed.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * @param {string} driver Path to the `.ts` driver.
 * @param {string[]} args Arguments for the driver.
 * @param {{ marker: string, timeoutMs: number, env?: Record<string, string> }} options `env` is merged over the
 *   spec's database settings.
 * @returns {unknown} The parsed JSON after the marker.
 */
function runTsxDriver(driver, args, { marker, timeoutMs, env = {} }) {
  const output = execFileSync('npx', ['tsx', driver, ...args], {
    env: {
      ...process.env,
      DB_HOST: process.env.DB_HOST || 'localhost',
      DB_PORT: process.env.DB_PORT || process.env.CI_DB_PORT || '5433',
      DB_NAME: process.env.DB_NAME || 'wxyc_db',
      DB_USERNAME: process.env.DB_USERNAME || 'test-user',
      DB_PASSWORD: process.env.DB_PASSWORD || 'test-pw',
      WXYC_SCHEMA_NAME: process.env.WXYC_SCHEMA_NAME || 'wxyc_schema',
      SENTRY_DSN: '',
      ...env,
    },
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const match = output.match(new RegExp(`^${marker}:(.*)$`, 'm'));
  if (!match) {
    throw new Error(`${path.basename(driver)} produced no ${marker} line:\n${output}`);
  }
  return JSON.parse(match[1]);
}

module.exports = { runTsxDriver };
