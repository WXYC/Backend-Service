/**
 * Child-process driver for `tests/integration/catalog-export-flag-reconcile.spec.js` (BS#2334).
 *
 * The integration runner is babel-jest with no TypeScript support, so the spec cannot import the real
 * `reconcileCatalogExportFlag` in-process. It spawns this script under `tsx` instead, so the REAL service runs against
 * the real Postgres through the real `@wxyc/database` client, binding to whatever `DB_*` the parent passes.
 *
 * Usage: `tsx run-catalog-export-flag-reconcile.ts <ENV_VAR_NAME>` (the flag's value is read from that env var, exactly
 * as in production). Prints one `RECONCILE_RESULT:{...}` line, `{ ok: true }` or `{ ok: false, message }` (the message includes the driver `cause`), and exits 0
 * whenever the script itself ran; a rejection from the reconciler is data for the spec, not a crash. `@wxyc/database`
 * logs on import, so the spec finds the result by its marker rather than treating stdout as the payload.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { reconcileCatalogExportFlag } from '../../apps/backend/services/catalog-export-flag-reconcile.service.js';

const main = async (): Promise<void> => {
  const flagName = process.argv[2];
  if (flagName === undefined || flagName === '') {
    throw new Error('usage: run-catalog-export-flag-reconcile.ts <ENV_VAR_NAME>');
  }

  let result: { ok: true } | { ok: false; message: string };
  try {
    await reconcileCatalogExportFlag(flagName);
    result = { ok: true };
  } catch (err) {
    // drizzle wraps the driver error in a "Failed query" error; the Postgres message is on `cause`.
    const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
    result = { ok: false, message: `${err instanceof Error ? err.message : String(err)}${cause}` };
  }
  console.log(`RECONCILE_RESULT:${JSON.stringify(result)}`);
  await closeDatabaseConnection();
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
