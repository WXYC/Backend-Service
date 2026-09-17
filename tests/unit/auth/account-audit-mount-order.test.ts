/**
 * Source-text mount-order assertion for the account-audit prefix mount
 * (BS#2537, parent epic #2534 decision 3), in the `tests/unit/auth/rate-limiting.test.ts`
 * idiom: Express 5.2.1 removed `app._router` (lazy `router` getter now), and
 * `apps/auth/app.ts` runs `app.listen()` plus DB sweeps in a module-scope
 * IIFE, so the app object cannot be imported under the unit suite at all —
 * reading the file as text is the only option, matching every other
 * route-wiring assertion in this repo.
 *
 * The audit mount MUST register above `resolve-organization`,
 * `provision-user`, and the station-signup admin router — Express dispatches
 * in registration order, so a mount placed anywhere after the first of these
 * silently zeroes coverage on exactly the highest-value routes.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('account-audit prefix mount ordering', () => {
  const authAppSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');
  const auditMountIndex = authAppSource.indexOf("app.use('/auth/admin', adminPrefixAuditMiddleware())");

  it('registers the audit prefix mount at all', () => {
    expect(auditMountIndex).toBeGreaterThan(-1);
  });

  it('registers above /auth/admin/resolve-organization', () => {
    const resolveOrgIndex = authAppSource.indexOf("'/auth/admin/resolve-organization'");
    expect(resolveOrgIndex).toBeGreaterThan(-1);
    expect(auditMountIndex).toBeLessThan(resolveOrgIndex);
  });

  it('registers above /auth/admin/provision-user', () => {
    const provisionIndex = authAppSource.indexOf("'/auth/admin/provision-user'");
    expect(provisionIndex).toBeGreaterThan(-1);
    expect(auditMountIndex).toBeLessThan(provisionIndex);
  });

  it('registers above the station-signup admin router mount', () => {
    const stationRouterIndex = authAppSource.indexOf('app.use(STATION_SIGNUP_ADMIN_PREFIX, stationSignupAdminRouter)');
    expect(stationRouterIndex).toBeGreaterThan(-1);
    expect(auditMountIndex).toBeLessThan(stationRouterIndex);
  });

  it('registers above the better-auth catch-all', () => {
    const catchAllIndex = authAppSource.indexOf("app.use('/auth', toNodeHandler(auth))");
    expect(catchAllIndex).toBeGreaterThan(-1);
    expect(auditMountIndex).toBeLessThan(catchAllIndex);
  });

  // The redundant-with-arm-1 documentation claim from decision 3: the
  // limiter is declared far below line 227, so registering above
  // resolve-organization already implies registering above it.
  it('registers above the auth-mutation rate limiter', () => {
    const limiterIndex = authAppSource.indexOf('const authMutationRateLimit = rateLimit(');
    expect(limiterIndex).toBeGreaterThan(-1);
    expect(auditMountIndex).toBeLessThan(limiterIndex);
  });

  // L5 (code review BS#2537 PR #2545): pin the two FLAT_MOUNTS loop
  // positions themselves, not just the single-mount adminPrefixAuditMiddleware
  // registration above. app.ts has TWO identical `for (const mount of
  // FLAT_MOUNTS) {` headers, distinguished only by which side of
  // `mount.resolveActor` they skip — the public loop (`if (mount.resolveActor)
  // continue`) must sit ahead of the rate limiter (decision 11's
  // DoS-amplifier argument), and the authenticated loop (`if
  // (!mount.resolveActor) continue`) must sit after it and still ahead of
  // the better-auth catch-all.
  const limiterIndex = authAppSource.indexOf('const authMutationRateLimit = rateLimit(');
  const catchAllIndex = authAppSource.indexOf("app.use('/auth', toNodeHandler(auth))");

  it('registers the public FLAT_MOUNTS loop ahead of the rate limiter', () => {
    const publicLoopIndex = authAppSource.indexOf(
      'for (const mount of FLAT_MOUNTS) {\n  if (mount.resolveActor) continue;'
    );
    expect(publicLoopIndex).toBeGreaterThan(-1);
    expect(publicLoopIndex).toBeLessThan(limiterIndex);
  });

  it('registers the authenticated FLAT_MOUNTS loop after the rate limiter and ahead of the catch-all', () => {
    const authenticatedLoopIndex = authAppSource.indexOf(
      'for (const mount of FLAT_MOUNTS) {\n  if (!mount.resolveActor) continue;'
    );
    expect(authenticatedLoopIndex).toBeGreaterThan(-1);
    expect(authenticatedLoopIndex).toBeGreaterThan(limiterIndex);
    expect(authenticatedLoopIndex).toBeLessThan(catchAllIndex);
  });
});
