/**
 * Unit tests for `shared/database/src/streaming-merge-sql.ts` (BS#2693's lift
 * of the streaming conflict-set builders out of `apps/enrichment-worker` and
 * `jobs/flowsheet-no-match-recheck`).
 *
 * The SQL those two builders emit is already pinned elsewhere, and both suites
 * are deliberately UNMODIFIED by the lift — a move that needed its callers'
 * tests edited would not be a move:
 *
 *   - `tests/unit/apps/enrichment-worker/enrich.test.ts` pins
 *     `buildStreamingFieldConflictSet`'s exact `.sql`/`.values` for all four
 *     incoming verdicts, reaching it through `enrich.ts`'s re-export of the
 *     `apps/enrichment-worker/streaming-merge-sql.ts` shim;
 *   - `tests/unit/jobs/flowsheet-no-match-recheck/writer.test.ts` pins
 *     `fillOrUpgradeSearchUrl`'s rendered CASE per column;
 *   - `tests/integration/enrichment-worker-streaming-toctou.spec.js` runs the
 *     compiled builder against real Postgres.
 *
 * This file therefore covers only what the NEW HOME introduces, none of which
 * any existing test touches:
 *
 *   1. the `@wxyc/database/streaming-merge-sql` subpath resolves under
 *      `jest.unit.config.ts`'s `moduleNameMapper` — its patterns are exact, so
 *      `^@wxyc/database$` does not match the subpath, and without its own entry
 *      this import throws `Cannot find module` (verified by deleting it).
 *      `tests/tsconfig.json`'s matching `paths` entry is for `tsc`/editor
 *      resolution over `tests/**` and is NOT what makes this pass — nothing in
 *      CI type-checks `tests/**`, and `isolatedModules: true` makes ts-jest
 *      transpile-only;
 *   2. the subpath does NOT resolve to `tests/mocks/database.mock.ts`, so
 *      callers get the real builders rather than a double;
 *   3. the module imports nothing but `drizzle-orm` — the side-effect-freedom
 *      BS#1945 extracted it for, and the reason it is reached by a subpath
 *      instead of the barrel (which re-exports `client.ts`, throwing at import
 *      time on missing DB env vars);
 *   4. the locally-restated `StreamingResolutionStatus` still matches
 *      `@wxyc/shared`'s, so a fourth verdict added upstream fails CI here
 *      rather than silently leaving a branch unreachable.
 */

import { readFileSync } from 'fs';
import path from 'path';

import { StreamingResolutionStatus as SharedStatus } from '@wxyc/shared/dtos';

import {
  buildStreamingFieldConflictSet,
  fillOrUpgradeSearchUrl,
  NO_FALLBACK,
  type StreamingResolutionStatus as LocalStatus,
} from '@wxyc/database/streaming-merge-sql';
import { album_metadata } from '../../../../shared/database/src/schema';
import * as shim from '../../../../apps/enrichment-worker/streaming-merge-sql';

describe('@wxyc/database/streaming-merge-sql subpath', () => {
  it('resolves through the subpath specifier and exports the real builders', () => {
    // (1) + (2). A mapper miss throws at import; the database mock exports no
    // such symbols, so reaching these names at all proves the subpath did not
    // land on the double.
    expect(typeof buildStreamingFieldConflictSet).toBe('function');
    expect(typeof fillOrUpgradeSearchUrl).toBe('function');
    expect(NO_FALLBACK).toBeNull();
  });

  it('is the very same module `apps/enrichment-worker` re-exports', () => {
    // Reference identity, not an output comparison: it proves the shim adds no
    // second definition, which is the drift BS#1945 removed and this move had to
    // preserve. Comparing rendered SQL would only re-pin what
    // `tests/unit/apps/enrichment-worker/enrich.test.ts` already owns.
    expect(shim.buildStreamingFieldConflictSet).toBe(buildStreamingFieldConflictSet);
    expect(shim.fillOrUpgradeSearchUrl).toBe(fillOrUpgradeSearchUrl);
    expect(shim.NO_FALLBACK).toBe(NO_FALLBACK);
  });
});

// Read once; two describes below assert against the module's own text. Source-level
// rather than behavioural, because under jest the `@wxyc/database` barrel is mapped
// to a mock and so cannot throw — the import-freedom property has to be asserted
// about the imports themselves. Same read-the-source approach as the
// `tests/unit/database/schema.*.test.ts` family.
const source = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'shared', 'database', 'src', 'streaming-merge-sql.ts'),
  'utf8'
);

describe('streaming-merge-sql import-time side effects', () => {
  // (3).
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)';/gm)].map((match) => match[1]);

  it('imports only drizzle-orm', () => {
    expect(specifiers).toEqual(['drizzle-orm']);
  });

  it('never reaches the pool-constructing client, directly or via the barrel', () => {
    // `client.ts` throws on missing DB_HOST/DB_NAME/DB_USERNAME/DB_PASSWORD, so
    // either route would make the builders un-importable without a database.
    expect(specifiers).not.toContain('./client.js');
    expect(specifiers).not.toContain('./index.js');
    expect(specifiers.filter((specifier) => specifier.startsWith('@wxyc/'))).toEqual([]);
  });
});

describe('locally-restated StreamingResolutionStatus', () => {
  // (4). `shared/database` imports no `@wxyc/*` package — it is the lowest
  // package in the graph and `lint:prebuild` builds it before
  // `@wxyc/lml-client` — so the union is restated there rather than imported.
  //
  // The union is read OUT OF THE MODULE'S SOURCE rather than re-typed here. A
  // third hand-copy would only ever compare itself to `@wxyc/shared` and would
  // pass while the module drifted — which is exactly what an earlier draft of
  // this file did, verified by adding a fourth value to the module and watching
  // all seven cases stay green. A type-level `extends` assertion is no use in
  // this tier either (`isolatedModules: true` → ts-jest transpiles without
  // checking, so `const x: false = true` compiles); the type-level half of this
  // guard lives in `apps/enrichment-worker/streaming-merge-sql.ts`, inside
  // `npm run typecheck`.
  const unionMatch = /^export type StreamingResolutionStatus = (.+);$/m.exec(source);
  const declaredValues = (unionMatch?.[1] ?? '').split('|').map((part) => part.trim().replace(/^'|'$/g, ''));

  it('declares the union in the shape this guard can read', () => {
    // Fail loudly on a reformat rather than silently matching nothing and
    // comparing two empty lists.
    expect(unionMatch).not.toBeNull();
    expect(declaredValues.length).toBeGreaterThan(0);
  });

  it('declares exactly the values @wxyc/shared does', () => {
    expect([...declaredValues].sort()).toEqual(Object.values(SharedStatus).sort());
  });

  it('is the type the builder accepts, for every declared value', () => {
    for (const value of Object.values(SharedStatus)) {
      const status: LocalStatus = value;
      const built = buildStreamingFieldConflictSet(
        album_metadata.spotify_status,
        album_metadata.spotify_url,
        status,
        'https://open.spotify.com/album/x',
        NO_FALLBACK
      );
      expect(built.status).toBeDefined();
      expect(built.url).toBeDefined();
    }
  });
});
