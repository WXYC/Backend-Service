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
 * This file covers what the NEW HOME introduces and needs the module LOADED to
 * check:
 *
 *   1. the `@wxyc/database/streaming-merge-sql` subpath resolves under
 *      `jest.unit.config.ts`'s `moduleNameMapper` — its patterns are exact, so
 *      `^@wxyc/database$` does not match the subpath, and without its own entry
 *      this import throws `Cannot find module` (verified by deleting it).
 *      `tests/tsconfig.json`'s matching `paths` entry is for `tsc`/editor
 *      resolution over `tests/**` and is NOT what makes this pass — nothing in CI
 *      type-checks `tests/**`, and `isolatedModules: true` makes ts-jest
 *      transpile-only;
 *   2. the subpath does NOT resolve to `tests/mocks/database.mock.ts`, so callers
 *      get the real builders rather than a double, and it is the same module object
 *      the `apps/enrichment-worker` shim re-exports;
 *   3. every value of the status union reaches a branch of its OWN.
 *
 * The guards that must survive the module being UNLOADABLE — import-freedom, the
 * union-vs-`@wxyc/shared` comparison, and the shim's no-second-definition property —
 * live in `streaming-merge-sql.source.test.ts`, which imports neither module. Every
 * violation of those three also breaks the import, so asserting them here would only
 * ever produce `Tests: 0 total` and a stack trace pointing somewhere else.
 */

import { StreamingResolutionStatus as SharedStatus } from '@wxyc/shared/dtos';

import {
  buildStreamingFieldConflictSet,
  fillOrUpgradeSearchUrl,
  NO_FALLBACK,
  type StreamingResolutionStatus as LocalStatus,
} from '@wxyc/database/streaming-merge-sql';
// `@wxyc/database` (the barrel) is mapped to `tests/mocks/database.mock.ts`, whose
// columns render as their own names — which is what lets `renderSql` read a fragment
// built over them. Importing the REAL `shared/database/src/schema` instead yields
// genuine drizzle `Column` objects, and `renderSql` throws on them by design ("an
// unhandled shape is a bug in the renderer, never a silently empty string"). Same
// import as `tests/unit/jobs/flowsheet-no-match-recheck/writer.test.ts`.
import { album_metadata } from '@wxyc/database';
import { renderSql } from '../../../utils/render-sql';
import * as shim from '../../../../apps/enrichment-worker/streaming-merge-sql';

describe('@wxyc/database/streaming-merge-sql subpath', () => {
  it('resolves through the subpath specifier and exports the real builders', () => {
    // A mapper miss throws `Cannot find module` at import (verified by deleting the
    // entry), and `tests/mocks/database.mock.ts` exports no such symbols — so
    // reaching these names at all proves both that the subpath resolved and that it
    // did not land on the double.
    expect(typeof buildStreamingFieldConflictSet).toBe('function');
    expect(typeof fillOrUpgradeSearchUrl).toBe('function');
    expect(NO_FALLBACK).toBeNull();
  });

  it('is the very same module `apps/enrichment-worker` re-exports', () => {
    // Reference identity, not an output comparison: comparing rendered SQL would
    // only re-pin what `tests/unit/apps/enrichment-worker/enrich.test.ts` owns. The
    // shim's no-second-definition property is asserted structurally in
    // `streaming-merge-sql.source.test.ts`, because identity is vacuous for
    // `NO_FALLBACK` (both sides are `null`).
    expect(shim.buildStreamingFieldConflictSet).toBe(buildStreamingFieldConflictSet);
    expect(shim.fillOrUpgradeSearchUrl).toBe(fillOrUpgradeSearchUrl);
  });
});

describe('buildStreamingFieldConflictSet branch coverage of the status union', () => {
  it('routes every declared value to its OWN branch', () => {
    // The first draft of this case asserted nothing: `const status: LocalStatus =
    // value` is erased by `isolatedModules: true`, and `toBeDefined()` on the two
    // legs is satisfied by any branch — so adding a fourth verdict to BOTH unions
    // left it green while that verdict fell silently through to the
    // `// incomingStatus === 'unresolved'` else-branch. That is precisely the "a
    // branch has quietly become unreachable" outcome the shim's type-level guard
    // exists to prevent, so this case has to DISTINGUISH branches, not merely reach
    // them.
    const statuses: LocalStatus[] = Object.values(SharedStatus);
    const rendered = statuses.map((status) =>
      renderSql(
        buildStreamingFieldConflictSet(
          album_metadata.spotify_status,
          album_metadata.spotify_url,
          status,
          'https://open.spotify.com/album/x',
          NO_FALLBACK
        ).status
      )
    );

    // Distinctness is the real assertion: a value with no branch of its own collides
    // with whichever branch it falls into.
    expect(new Set(rendered).size).toBe(rendered.length);
    // And each names its own verdict, so a collision cannot be masked by two
    // branches that merely differ in some unrelated way.
    statuses.forEach((status, index) => {
      expect(rendered[index]).toContain(`'${status}'`);
    });
  });

  it('leaves the status column alone when no verdict was consulted this round', () => {
    // `undefined` is not a member of the union and has its own branch, which the
    // distinctness check above cannot see. It is also the COMMON case for the two
    // writers BS#2693/#2703 fix, so it is worth its own assertion here.
    const { status } = buildStreamingFieldConflictSet(
      album_metadata.spotify_status,
      album_metadata.spotify_url,
      undefined,
      null,
      NO_FALLBACK
    );
    expect(renderSql(status)).toBe('album_metadata.spotify_status');
  });
});
