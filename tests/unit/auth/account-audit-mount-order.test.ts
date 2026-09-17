/**
 * Source-text mount-order assertion for the account-audit prefix mount and
 * flat-mount dispatch layers (BS#2537, parent epic #2534 decision 3), in
 * the `tests/unit/auth/rate-limiting.test.ts` idiom: Express 5.2.1 removed
 * `app._router` (lazy `router` getter now), and `apps/auth/app.ts` runs
 * `app.listen()` plus DB sweeps in a module-scope IIFE, so the app object
 * cannot be imported under the unit suite at all — reading the file as text
 * is the only option, matching every other route-wiring assertion in this
 * repo.
 *
 * The audit mount MUST register above `resolve-organization`,
 * `provision-user`, and the station-signup admin router — Express dispatches
 * in registration order, so a mount placed anywhere after the first of these
 * silently zeroes coverage on exactly the highest-value routes.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { STATION_SIGNUP_ADMIN_OPS } from '../../../apps/auth/audit-coverage';

describe('account-audit prefix mount ordering', () => {
  const authAppSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');
  const auditMountIndex = authAppSource.indexOf("app.use('/auth/admin', adminPrefixAuditMiddleware())");

  it('registers the audit prefix mount at all', () => {
    expect(auditMountIndex).toBeGreaterThan(-1);
  });

  // Item 18 (simplify pass, code review BS#2537 PR #2545 follow-up):
  // indexOf computations hoisted to describe scope, and the five
  // "registers above X" cases collapsed into one it.each table.
  const needles: Record<string, number> = {
    "'/auth/admin/resolve-organization'": authAppSource.indexOf("'/auth/admin/resolve-organization'"),
    "'/auth/admin/provision-user'": authAppSource.indexOf("'/auth/admin/provision-user'"),
    'app.use(STATION_SIGNUP_ADMIN_PREFIX, stationSignupAdminRouter)': authAppSource.indexOf(
      'app.use(STATION_SIGNUP_ADMIN_PREFIX, stationSignupAdminRouter)'
    ),
    "app.use('/auth', toNodeHandler(auth))": authAppSource.indexOf("app.use('/auth', toNodeHandler(auth))"),
    // The redundant-with-arm-1 documentation claim from decision 3: the
    // limiter is declared far below line 227, so registering above
    // resolve-organization already implies registering above it.
    'const authMutationRateLimit = rateLimit(': authAppSource.indexOf('const authMutationRateLimit = rateLimit('),
  };

  it.each(Object.entries(needles))('registers above %s', (_needle, index) => {
    expect(index).toBeGreaterThan(-1);
    expect(auditMountIndex).toBeLessThan(index);
  });

  const limiterIndex = needles['const authMutationRateLimit = rateLimit('];
  const catchAllIndex = needles["app.use('/auth', toNodeHandler(auth))"];

  // Item 7 (simplify pass): the ~20-layer-per-mount loop collapsed into two
  // calls, one per FLAT_MOUNTS partition. These call sites are the stable
  // needles now — no embedded newlines/indentation to keep in sync with
  // app.ts's own formatting.
  it('registers the public account-audit mount ahead of the rate limiter', () => {
    const publicMountIndex = authAppSource.indexOf('mountPublicAccountAudit(app);');
    expect(publicMountIndex).toBeGreaterThan(-1);
    expect(publicMountIndex).toBeLessThan(limiterIndex);
  });

  it('registers the authenticated account-audit mount after the rate limiter and ahead of the catch-all', () => {
    const authenticatedMountIndex = authAppSource.indexOf('mountAuthenticatedAccountAudit(app);');
    expect(authenticatedMountIndex).toBeGreaterThan(-1);
    expect(authenticatedMountIndex).toBeGreaterThan(limiterIndex);
    expect(authenticatedMountIndex).toBeLessThan(catchAllIndex);
  });

  // Item 3 (simplify pass, code review BS#2537 PR #2545 follow-up): closes
  // the drift-check blind spot the six hand-listed station-signup
  // ADMIN_ACTIONS entries used to be — nothing previously caught app.ts
  // registering a station-signup op this file forgot to list, or vice
  // versa. Same source-text read this describe block already does.
  it('STATION_SIGNUP_ADMIN_OPS names exactly the ops app.ts registers via stationSignupAdminRoute', () => {
    const registeredOps = [...authAppSource.matchAll(/stationSignupAdminRoute\('([a-z-]+)'/g)].map((m) => m[1]);
    expect(registeredOps.length).toBeGreaterThan(0);
    expect([...registeredOps].sort()).toEqual([...STATION_SIGNUP_ADMIN_OPS].sort());
  });
});
