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
import { ADMIN_PREFIX, STATION_SIGNUP_ADMIN_OPS } from '../../../apps/auth/audit-coverage';
import { statementIndex } from '../../utils/statement-index';

describe('account-audit prefix mount ordering', () => {
  const authAppSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');
  // Match the STATEMENT, not the first occurrence of the text. `app.ts`'s
  // body-parser comment (near the top of the file, well before the real
  // mount) cites this exact call expression verbatim, so a bare `indexOf`
  // finds the comment instead — every "registers above X" case below then
  // passes unconditionally, since the comment's offset precedes every
  // needle in the file regardless of where the real mount actually sits.
  // `statementIndex` (tests/utils/statement-index.ts, shared with
  // tests/unit/auth/rate-limiting.test.ts, which hit the identical bug
  // against the identical line) anchors at line start after optional
  // indentation, which excludes comment lines.
  const auditMountIndex = statementIndex(
    authAppSource,
    String.raw`app\.use\('/auth/admin', adminPrefixAuditMiddleware\(\)\);`
  );

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
    // L5 (code review BS#2537 PR #2545, second round): widened from
    // [a-z-]+ — an op name with a digit/underscore/uppercase character
    // would have been invisible to that charset, silently shrinking
    // registeredOps and making the parity assertion vacuously pass on a
    // partial match instead of catching real drift.
    const registeredOps = [...authAppSource.matchAll(/stationSignupAdminRoute\('([\w-]+)'/g)].map((m) => m[1]);
    expect(registeredOps.length).toBeGreaterThan(0);
    expect([...registeredOps].sort()).toEqual([...STATION_SIGNUP_ADMIN_OPS].sort());
  });

  // L5 (code review BS#2537 PR #2545, second round): app.ts and
  // audit-coverage.ts each declare their OWN STATION_SIGNUP_ADMIN_PREFIX
  // constant (app.ts's is '/auth'-qualified for its own app.use() call;
  // audit-coverage.ts's is bare, matching that module's own path
  // convention) — same name, same concept, two separate literals with
  // nothing structurally tying them together. This pins that app.ts's
  // value is always exactly '/auth' + audit-coverage.ts's bare prefix, so
  // the two can't silently drift apart.
  it("app.ts's STATION_SIGNUP_ADMIN_PREFIX equals '/auth' + audit-coverage.ts's station-signup prefix", () => {
    const match = authAppSource.match(/const STATION_SIGNUP_ADMIN_PREFIX = '([^']+)';/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(`/auth${ADMIN_PREFIX}/station-signup`);
  });

  // BS#2604 (parent epic #2534): the three dedicated limiters covering the
  // fourteen authenticated flat-mount paths must register ABOVE
  // `mountAuthenticatedAccountAudit(app)` — Express matches-and-terminates in
  // registration order, so a limiter mounted below the audit dispatch would
  // still let every over-budget request pay for that middleware's
  // unconditional getSession call and its account_audit_event INSERT on its
  // way to a 429, bounding none of the cost the ticket exists to bound.
  // Nothing in Express enforces this by itself, so it is pinned here
  // explicitly, same idiom as the admin-prefix limiter's ordering pin in
  // tests/unit/auth/rate-limiting.test.ts. statementIndex, not bare indexOf:
  // these three `app.use(...)` call sites also appear, in prose, inside
  // this file's own comments above (e.g. "a limiter mounted below the audit
  // dispatch"), which a bare `indexOf` could latch onto instead of the real
  // statement.
  describe('BS#2604 authenticated flat-mount limiter ordering', () => {
    const authenticatedMountIndex = authAppSource.indexOf('mountAuthenticatedAccountAudit(app);');

    const rateLimiterNeedles: Record<string, number> = {
      "app.use('/auth/update-user', updateUserRateLimit)": statementIndex(
        authAppSource,
        String.raw`app\.use\('/auth/update-user',\s*updateUserRateLimit\)`
      ),
      'app.use(path, sensitiveAuthMutationRateLimit)': statementIndex(
        authAppSource,
        String.raw`app\.use\(path, sensitiveAuthMutationRateLimit\);`
      ),
      'app.use(path, organizationMutationRateLimit)': statementIndex(
        authAppSource,
        String.raw`app\.use\(path, organizationMutationRateLimit\);`
      ),
    };

    it('registers the authenticated mount at all', () => {
      expect(authenticatedMountIndex).toBeGreaterThan(-1);
    });

    it.each(Object.entries(rateLimiterNeedles))(
      'mounts %s ahead of mountAuthenticatedAccountAudit(app)',
      (_needle, index) => {
        expect(index).toBeGreaterThan(-1);
        expect(index).toBeLessThan(authenticatedMountIndex);
      }
    );
  });
});
