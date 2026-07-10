/**
 * Node ESM "am I invoked directly?" helper. Reused across the zero-dep static
 * checks under `scripts/` (`check-auth-tables-doc.mjs`,
 * `check-bulk-update-analyze.mjs`, `check-legacy-entry-id-writes.mjs`) — each
 * one used to hand-roll the same ~10 lines of `realpathSync` + `fileURLToPath`
 * boilerplate.
 *
 * Why realpathSync on both sides: macOS's `/tmp` -> `/private/tmp` symlink
 * (and any similar dev-loop path) can make a legitimate self-invocation look
 * like an ES-module import, which would skip the entry point and silently
 * exit 0. Canonicalizing both `process.argv[1]` and `import.meta.url` before
 * comparison avoids that trap.
 *
 * The helper stays zero-dep (no npm, only `node:` builtins) so a script that
 * imports it doesn't drag in a workspace resolve — the whole point of the
 * `scripts/*.mjs` family is to run before `npm ci` in the pre-push hook.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Returns `true` when the script whose `import.meta.url` is passed in was
 * invoked directly (e.g. `node scripts/foo.mjs`), and `false` when it was
 * loaded as an import (e.g. from a test that dynamic-imports the module).
 *
 * Failures during path canonicalization (missing argv[1], broken symlink,
 * permission error) are swallowed and treated as "not invoked directly" so a
 * script that gets imported in an unusual environment doesn't crash before
 * its exports are usable.
 *
 * @param {string} importMetaUrl — pass `import.meta.url` verbatim.
 * @returns {boolean}
 */
export function isInvokedDirectly(importMetaUrl) {
  try {
    const argvPath = realpathSync(resolve(process.argv[1] ?? ''));
    const selfPath = realpathSync(fileURLToPath(importMetaUrl));
    return argvPath === selfPath;
  } catch {
    return false;
  }
}
