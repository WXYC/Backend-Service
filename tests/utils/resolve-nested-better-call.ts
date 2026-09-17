import fs from 'fs';
import path from 'path';

/**
 * Walks up from `startFile` looking for the nearest ancestor directory whose
 * `package.json` has `name === expectedName` — i.e. the package root that
 * owns `startFile`, without assuming any particular depth (an entry point
 * can be `dist/index.cjs`, `dist/index.mjs`, or something else entirely
 * depending on the package's own build output, which is not this repo's to
 * pin).
 */
function findPackageRoot(startFile: string, expectedName: string): string {
  let dir = path.dirname(startFile);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === expectedName) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `walked up from "${startFile}" to the filesystem root without finding a package.json named "${expectedName}"`
      );
    }
    dir = parent;
  }
}

/**
 * Resolves a `better-call` module path from the copy PRODUCTION actually
 * loads at runtime — better-auth's own nested dependency, pinned to an EXACT
 * version (`node_modules/better-auth/package.json`'s `"better-call": "1.3.7"`
 * as of writing) — rather than the root `better-call` devDependency this
 * repo's own `package.json` floats at a wider range for type-checking
 * purposes (`^1.4.0` admits `1.4.0` as of writing).
 *
 * No first-party module imports `better-call` directly — the fleet only
 * reaches it through `better-auth`'s own dependency — so a bare
 * `require.resolve('better-call')` from a test file resolves the ROOT copy,
 * which nothing in production loads. That copy can drift independently of
 * the nested one (a `npm update` in this repo's root moves it; a
 * `better-auth` version bump moves the nested one; neither move touches the
 * other), so a drift detector or parity harness built against the root copy
 * is watching a file production never executes — see BS#2558 (PR #2566
 * review Finding 2), which is exactly the failure mode this function exists
 * to close: it resolves relative to better-auth's OWN install location, so
 * whichever copy npm actually nested there is the one every caller of this
 * function gets.
 *
 * @param subpath - e.g. `'node'` for the `better-call/node` export. Omit for
 *   the package's own `.` entry point.
 */
export function resolveNestedBetterCall(subpath?: string): string {
  const specifier = subpath ? `better-call/${subpath}` : 'better-call';
  try {
    const betterAuthEntry = require.resolve('better-auth');
    const betterAuthRoot = findPackageRoot(betterAuthEntry, 'better-auth');
    return require.resolve(specifier, { paths: [betterAuthRoot] });
  } catch (error) {
    // Fail loudly and specifically (BS#2558 PR #2566 review Finding 3): a
    // reader hitting this needs to know it's a real signal — better-auth's
    // own dependency layout changed, or it stopped nesting a nonmatching
    // better-call at all (npm dedupes it away once the root range and
    // better-auth's pin happen to agree on a version) — not a broken test to
    // delete. The second case is actually fine (there's no longer a copy to
    // drift from the root one), but it needs a human to confirm that and
    // update/remove this helper's callers accordingly, not a silently green
    // suite that stopped checking anything.
    throw new Error(
      `resolveNestedBetterCall(${subpath ? `'${subpath}'` : ''}): could not resolve "${specifier}" starting ` +
        `from better-auth's own package root. This looks for ` +
        `node_modules/better-auth/node_modules/better-call — the copy better-auth pins internally and ` +
        `production actually loads (see this function's doc comment) — not the root better-call ` +
        `devDependency. Either "better-auth" itself failed to resolve (is it installed? run \`npm install\`), ` +
        `or better-auth no longer nests its own better-call copy (its pinned version may now match the root ` +
        `range closely enough for npm to dedupe them — if so, this helper and its callers need re-evaluating, ` +
        `not silencing). Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
