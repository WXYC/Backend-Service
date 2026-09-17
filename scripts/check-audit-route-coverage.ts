/**
 * Fails if any account-modifying route is in neither the audited set nor the
 * allowlist (BS#2537, parent epic #2534 decision 4).
 *
 * Two arms, both against `apps/auth/audit-coverage.ts`'s shared
 * audited/allowlist classification (the same module `apps/auth/app.ts`
 * imports for its mounts, so a mount and this check cannot drift from each
 * other):
 *
 *   1. Runtime-imports the REAL `auth` object and enumerates
 *      `Object.values(auth.api)` (`.path` + `.options.method`, stamped by
 *      `toAuthEndpoints`) — this is why the check runs under `tsx`, not
 *      `jest`: `jest.unit.config.ts` maps better-auth to hand-written mocks,
 *      so a unit test would never see a route a library upgrade adds.
 *   2. Source-text sweep of every `apps/auth/*.ts` file's hand-written
 *      `app.post/put/patch/delete('/auth…')` or `router.post/put/patch/delete('/auth…')`
 *      registrations (non-anchored, whitespace-tolerant — several register
 *      indented inside conditionals). `auth.api` cannot see these; they are
 *      not better-auth endpoints. L1 (code review BS#2537 PR #2545):
 *      widened from `app.ts`-only and `app.` -only so a future
 *      `app.use('/auth/x', router)` with absolute paths on `router` isn't
 *      invisible to this arm. A relative path on a sub-router mounted
 *      under a prefix (e.g. `stationSignupAdminRouter.post('/reveal', ...)`)
 *      still isn't matched — those don't start with `/auth` — and stay
 *      covered by the mount-order source-text test instead, per the
 *      module's own design note on `EXPLICIT_CALL_SITES`.
 *
 * Run: `npm run check:audit-coverage` (dotenvx-wrapped, for pre-push —
 * importing `auth` pulls `@wxyc/database`, and
 * `shared/database/src/client.ts` throws at import without DB env) or
 * `npm run check:audit-coverage:ci` (bare, CI supplies dummy DB env in the
 * step's own `env:` block — postgres-js connects lazily and this script
 * never queries).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth } from '@wxyc/authentication';
import {
  findUncoveredAuthApiEndpoints,
  findUncoveredExpressRoutes,
  type AuthApiEndpoint,
} from '../apps/auth/audit-coverage';

const here = path.dirname(fileURLToPath(import.meta.url));

function reachableAuthApiEndpoints(): AuthApiEndpoint[] {
  const endpoints: AuthApiEndpoint[] = [];
  for (const value of Object.values(auth.api as Record<string, unknown>)) {
    const endpoint = value as { path?: string; options?: { method?: string | readonly string[] } };
    // Mirrors better-call's own router construction (router.mjs): an
    // endpoint with no `.path` (SERVER_ONLY or otherwise) is never mounted,
    // so excluding it here is not a coverage gap — it can never receive an
    // HTTP request to audit.
    if (!endpoint.path) continue;
    const method = endpoint.options?.method;
    endpoints.push({ path: endpoint.path, methods: Array.isArray(method) ? method : [method ?? 'GET'] });
  }
  return endpoints;
}

const HAND_WRITTEN_ROUTE_PATTERN = /(?:app|router)\.(?:post|put|patch|delete)\s*\(\s*(['"`])(\/auth[^'"`]*)\1/g;

function handWrittenAuthRoutes(): string[] {
  const authDir = path.join(here, '..', 'apps', 'auth');
  const bare = new Set<string>();
  for (const entry of readdirSync(authDir)) {
    if (!entry.endsWith('.ts')) continue;
    const source = readFileSync(path.join(authDir, entry), 'utf-8');
    for (const match of source.matchAll(HAND_WRITTEN_ROUTE_PATTERN)) {
      bare.add(match[2].replace(/^\/auth/, ''));
    }
  }
  return [...bare];
}

function main(): void {
  const uncoveredAuthApi = findUncoveredAuthApiEndpoints(reachableAuthApiEndpoints());
  const uncoveredExpress = findUncoveredExpressRoutes(handWrittenAuthRoutes());

  if (uncoveredAuthApi.length === 0 && uncoveredExpress.length === 0) {
    console.log('✓ account-audit coverage: every route is audited or allowlisted');
    return;
  }

  console.error('FAIL: account-audit coverage has drifted.');
  if (uncoveredAuthApi.length > 0) {
    console.error(`\nbetter-auth endpoints in neither the audited set nor the allowlist (${uncoveredAuthApi.length}):`);
    for (const p of uncoveredAuthApi) console.error(`  ${p}`);
  }
  if (uncoveredExpress.length > 0) {
    console.error(
      `\nhand-written Express routes in neither the audited set nor the allowlist (${uncoveredExpress.length}):`
    );
    for (const p of uncoveredExpress) console.error(`  ${p}`);
  }
  console.error('\nAdd the new route to FLAT_MOUNTS/ADMIN_PREFIX coverage in apps/auth/audit-coverage.ts');
  console.error('if it modifies an account, or to ALLOWLIST with a comment naming why it does not.');
  process.exitCode = 1;
}

main();
