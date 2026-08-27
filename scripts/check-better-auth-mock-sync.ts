/**
 * Fails if the better-auth access mocks have drifted from the real library.
 *
 * Why this exists: `jest.unit.config.ts` maps `better-auth/plugins/access` and
 * `better-auth/plugins/organization/access` to hand-written mocks (ts-jest
 * can't transform better-auth's ESM). Every unit assertion about roles —
 * including auth.roles.test.ts's pin of `stationManager`'s statements against
 * `adminAc.statements` — therefore runs against the mock, and would compare
 * the mock to itself. This check is the other half: it imports the REAL
 * modules and the mocks and compares them, so a better-auth upgrade that
 * changes the org-admin set or `authorize` semantics fails here instead of
 * silently invalidating the unit suite.
 *
 * The comparison logic lives in `@wxyc/authentication`'s `access-mock-parity`
 * (linted, typechecked, and unit-tested in tests/unit/scripts/) because
 * `scripts/**` is excluded from ESLint and `npm run typecheck`. This runner is
 * deliberately thin, and any import/resolution failure is a FAILED check —
 * never a skip, or the tripwire silently disarms itself.
 *
 * Run: npm run check:better-auth-mock-sync
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compareAccessModules } from '../shared/authentication/src/access-mock-parity';
import * as accessMock from '../tests/mocks/better-auth-access.mock';
import * as orgAccessMock from '../tests/mocks/better-auth-org-access.mock';

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve better-auth from the workspace that actually declares it. A bare
// import from scripts/ resolves through the root node_modules only by npm
// hoisting — an undeclared contract that a future version conflict in another
// workspace would break, with no diff anywhere near this file.
const requireFromAuthPackage = createRequire(path.join(here, '..', 'shared', 'authentication', 'package.json'));

async function main(): Promise<void> {
  let realAccess: unknown;
  let realOrgAccess: unknown;

  try {
    const accessPath = requireFromAuthPackage.resolve('better-auth/plugins/access');
    const orgAccessPath = requireFromAuthPackage.resolve('better-auth/plugins/organization/access');
    realAccess = await import(accessPath);
    realOrgAccess = await import(orgAccessPath);
  } catch (error) {
    console.error('FAIL: could not load the real better-auth access modules.');
    console.error('This is a failed check, not a skip — the mock-parity tripwire cannot run.');
    console.error(error);
    process.exit(1);
  }

  const findings = compareAccessModules(
    {
      access: realAccess as Parameters<typeof compareAccessModules>[0]['access'],
      orgAccess: realOrgAccess as Parameters<typeof compareAccessModules>[0]['orgAccess'],
    },
    {
      access: accessMock as unknown as Parameters<typeof compareAccessModules>[1]['access'],
      orgAccess: orgAccessMock as unknown as Parameters<typeof compareAccessModules>[1]['orgAccess'],
    }
  );

  if (findings.length > 0) {
    console.error(`FAIL: better-auth mocks have drifted from the installed library (${findings.length} finding(s)):\n`);
    for (const finding of findings) {
      console.error(`  [${finding.kind}] ${finding.detail}\n`);
    }
    console.error('Update tests/mocks/better-auth-*.mock.ts to match, then re-check the role');
    console.error('statement pins in tests/unit/authentication/auth.roles.test.ts — a changed');
    console.error("org-admin set changes what stationManager can do, and that's a decision, not a merge conflict.");
    process.exit(1);
  }

  console.log('✓ better-auth access mocks match the installed library');
}

main().catch((error) => {
  console.error('FAIL: mock-sync check threw unexpectedly.');
  console.error(error);
  process.exit(1);
});
