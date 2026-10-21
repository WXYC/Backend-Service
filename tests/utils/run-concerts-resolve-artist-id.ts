/**
 * Child-process driver for `tests/integration/concerts-artist-resolver-support.spec.js` (BS#3563).
 *
 * The integration runner is babel-jest with no TypeScript support, so the spec cannot import the real
 * `resolveArtistId` in-process. It spawns this script under `tsx` instead, so the REAL strict and alias arms (the source
 * partition and the variant gate in `jobs/concerts-artist-resolver/query.ts`) run against the real Postgres through the
 * real `@wxyc/database` client, binding to whatever `DB_*` the parent passes.
 *
 * Usage: `tsx run-concerts-resolve-artist-id.ts '<JSON array of raw names>'`. Prints one `RESOLVE_RESULT:{...}` line
 * that maps each raw name to its `ResolveOutcome`. `@wxyc/database` logs on import, so the spec finds the result by its
 * marker rather than treating stdout as the payload.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { resolveArtistId } from '../../jobs/concerts-artist-resolver/query.js';
import type { ResolveOutcome } from '../../jobs/concerts-artist-resolver/orchestrate.js';

const main = async (): Promise<void> => {
  const arg = process.argv[2];
  if (arg === undefined || arg === '') {
    throw new Error("usage: run-concerts-resolve-artist-id.ts '<JSON array of raw names>'");
  }
  const names = JSON.parse(arg) as string[];

  const result: Array<[string, ResolveOutcome]> = [];
  for (const name of names) {
    result.push([name, await resolveArtistId(name)]);
  }
  console.log(`RESOLVE_RESULT:${JSON.stringify(Object.fromEntries(result))}`);
  await closeDatabaseConnection();
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
