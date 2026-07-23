/**
 * Source-grep regression test for BS#1222: the two fire-and-forget CDC
 * startup calls in `apps/backend/app.ts` (`startCdcDispatcher` and
 * `setupCdcWebSocket`) must attach a `.catch` handler that logs to stderr
 * and reports to Sentry, so a DB-unreachable startup failure isn't silently
 * swallowed by the bare `void` call.
 *
 * Mirrors the `server-timeout.test.ts` / `healthcheck-shape.test.ts` style:
 * app.ts calls `app.listen(...)` unconditionally at module load, so
 * importing it directly would spin up a real server + DB connection. We
 * assert the source shape instead.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const appSource = readFileSync(resolve(__dirname, '../../../apps/backend/app.ts'), 'utf-8');

describe('CDC startup error handling (BS#1222)', () => {
  it('attaches a .catch to the startCdcDispatcher() call', () => {
    const match = appSource.match(/void startCdcDispatcher\(\)\.catch\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\);/);
    expect(match).not.toBeNull();
    if (!match) return;

    const catchBody = match[1];
    expect(catchBody).toMatch(/console\.error\(/);
    expect(catchBody).toMatch(/Sentry\.captureException\(/);
    expect(catchBody).toMatch(/subsystem:\s*['"]cdc['"]/);
  });

  it('attaches a .catch to the setupCdcWebSocket(server) call', () => {
    const match = appSource.match(/void setupCdcWebSocket\(server\)\.catch\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\);/);
    expect(match).not.toBeNull();
    if (!match) return;

    const catchBody = match[1];
    expect(catchBody).toMatch(/console\.error\(/);
    expect(catchBody).toMatch(/Sentry\.captureException\(/);
    expect(catchBody).toMatch(/subsystem:\s*['"]cdc['"]/);
  });

  it('does not leave either call as a bare unhandled void call', () => {
    expect(appSource).not.toMatch(/void startCdcDispatcher\(\);/);
    expect(appSource).not.toMatch(/void setupCdcWebSocket\(server\);/);
  });
});
