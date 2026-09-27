/**
 * Side-effect-free SQL-fragment builders for streaming-column conflict sets:
 * `buildStreamingFieldConflictSet` (the BS#1923 TOCTOU fix, extracted out of
 * `enrich.ts` by BS#1945) and `fillOrUpgradeSearchUrl` (the BS#2179
 * fill-null-plus-upgrade-past-a-placeholder CASE, extracted out of
 * `jobs/flowsheet-no-match-recheck/writer.ts`). Each was a module-local of a
 * single consumer; BS#2693/#2703 need both from two further writers, so they
 * live here rather than being re-approximated a third time.
 *
 * NEITHER has import-time side effects: this module touches only
 * `drizzle-orm`'s `sql` tag (a pure query-fragment builder — importing it opens
 * no socket, starts no timer). No `db` singleton, no LML HTTP client, no
 * `@wxyc/*` import of any kind.
 *
 * **Reached by the `@wxyc/database/streaming-merge-sql` SUBPATH, never the
 * package barrel.** `src/index.ts` re-exports `./client.js`, which THROWS at
 * import time on missing `DB_HOST`/`DB_NAME`/`DB_USERNAME`/`DB_PASSWORD` while
 * constructing the pool — routing these builders through the barrel would
 * destroy exactly the property the paragraph above describes, and with it the
 * reason BS#1945 extracted the first one. So the subpath carries its own
 * `exports` entry and its own tsup entry (precedent:
 * `@wxyc/observability/metrics`), plus both test-side halves that precedent
 * carries. They do different jobs, and only one is load-bearing for CI:
 * `jest.unit.config.ts`'s `moduleNameMapper` is REQUIRED (its patterns are
 * exact, so `^@wxyc/database$` does not match this subpath, and without an
 * entry jest resolves against a `shared/database/dist` the unit-tests job never
 * builds — measured: the import throws `Cannot find module`).
 * `tests/tsconfig.json`'s `paths` is for `tsc`/editor resolution over
 * `tests/**`, since `moduleResolution: "Node"` ignores `exports` and would look
 * for a `streaming-merge-sql.d.ts` that no build emits — but nothing in CI
 * type-checks `tests/**` (`isolatedModules: true` makes ts-jest
 * transpile-only), so that half buys correctness in the editor, not a gate.
 * Do not rely on ts-jest to catch a type error in a test.
 *
 * That side-effect freedom is also what lets the module be built as its own
 * dual esm+cjs tsup entry and `require`d, as compiled CJS, by a plain
 * `.spec.js` integration test:
 * `tests/integration/enrichment-worker-streaming-toctou.spec.js` runs THIS REAL
 * function's output against a live Postgres instead of a hand-duplicated SQL
 * mirror. Before BS#1945, hand-editing the function in `enrich.ts` without
 * updating that mirror left the integration spec green against stale SQL; now
 * the spec imports the genuine article, so there is no second copy to drift.
 *
 * `apps/enrichment-worker/streaming-merge-sql.ts` stays behind as a pure
 * re-export, which is what keeps that property true across this move: the spec
 * still requires `apps/enrichment-worker/dist/streaming-merge-sql.cjs`,
 * `enrich.ts` still imports `./streaming-merge-sql.js`, and
 * `tests/unit/apps/enrichment-worker/enrich.test.ts` — which pins
 * `buildStreamingFieldConflictSet`'s exact `.sql`/`.values` output — still
 * imports it from `apps/enrichment-worker/enrich`. None of the three changed.
 *
 * @see WXYC/Backend-Service#1923 (the TOCTOU fix `buildStreamingFieldConflictSet` implements)
 * @see WXYC/Backend-Service#1945 (its extraction out of `enrich.ts`)
 * @see WXYC/Backend-Service#2179 (`fillOrUpgradeSearchUrl`'s originating review finding)
 * @see WXYC/Backend-Service#2693 (the lift to this shared home)
 */

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * `@wxyc/shared`'s `StreamingResolutionStatus` (`api.yaml`
 * `components.schemas.StreamingResolutionStatus`), restated here rather than
 * imported as a type from `@wxyc/lml-client` the way it was in
 * `apps/enrichment-worker`.
 *
 * No file under `shared/database/src` imports any `@wxyc/*` package: this is
 * the lowest package in the workspace graph, and `lint:prebuild` builds it
 * BEFORE `@wxyc/lml-client`, so a `dts: true` entry here that referenced
 * lml-client's types would need a `dist/index.d.ts` that does not exist yet.
 * A three-value string union costs nothing to restate, and restating it keeps
 * this package's dependency set unchanged by the lift.
 *
 * The copy is not trusted on faith, and the guard is deliberately NOT a
 * type-level assertion in a test — `tests/**` is outside `npm run typecheck`
 * and ts-jest is transpile-only here, so such an assertion silently always
 * passes (measured). Two things fire instead:
 *
 *   - `tests/unit/shared/database/streaming-merge-sql.test.ts` parses the union
 *     out of THIS FILE's source and compares it to `@wxyc/shared`'s runtime
 *     `StreamingResolutionStatus` const, so drift on either side fails a test
 *     with a legible diff;
 *   - `apps/enrichment-worker/streaming-merge-sql.ts`, the re-export shim, holds
 *     a mutual-assignability assertion against `@wxyc/lml-client`'s type. That
 *     file IS inside `npm run typecheck` (`apps/**`), which is the only place a
 *     type-level check on this pair is actually enforced.
 *
 * Same bargain, for the same reason, as
 * `scripts/lib/spotify-album-slot-repair.ts`'s `REASK_ATTEMPT_CAP` mirror:
 * restate the value, then make drift fail CI.
 */
export type StreamingResolutionStatus = 'verified' | 'absent' | 'unresolved';

/** A field with no synthesized search-URL fallback (Apple Music, BS#1192) never falls back — its non-verified branches keep/null the live URL directly instead of substituting a fresh search URL. */
export const NO_FALLBACK = null;

/**
 * One field's `onConflictDoUpdate` `set` fragments (BS#1923): SQL `CASE`
 * expressions over the LIVE `statusCol`/`urlCol` values, translating
 * `mergeStreamingField`'s rules (`enrich.ts`) so the merge and the write are
 * the same atomic statement — no separate SELECT that could go stale during
 * the LML round-trip.
 *
 * `incomingStatus`/`incomingUrl` are plain JS values fixed for this call
 * (this round's LML verdict) — only the "current persisted state" side of
 * the merge needs to become SQL, since that is the side a concurrent writer
 * could have changed since this call started. Per incoming verdict:
 *
 *   - `undefined` (never consulted this round): status is left unchanged
 *     (whatever the live row already holds). A field WITH a search-URL
 *     fallback still recomputes it fresh whenever the live status isn't
 *     `'verified'` — unrelated to whether this field was asked this round;
 *     that mirrors the pre-#1915 last-writer-wins fallback recompute. A
 *     field with no fallback (Apple Music) leaves its url unchanged too.
 *   - `'verified'`: status becomes `'verified'` unconditionally (rule 3 of
 *     `mergeStreamingField` supersedes a prior `'absent'`); url adopts
 *     `incomingUrl` UNLESS the live row is already `'verified'`, in which
 *     case the live url is kept — a verified field is never downgraded,
 *     evaluated against the row as it stands at write time, not a stale
 *     snapshot.
 *   - `'absent'`: status becomes `'absent'` unless the live row is already
 *     `'verified'` (kept). url becomes the fallback (or NULL with no
 *     fallback) in that same non-verified branch — `current.status ===
 *     'absent'` (keep) and adopting `'absent'` fresh collapse to the same
 *     final url here, so one branch covers both.
 *   - `'unresolved'`: status becomes `'unresolved'` unless the live row is
 *     already `'verified'` OR already `'absent'` (both terminal, kept). url
 *     recomputes the fresh fallback in the non-verified branch for a field
 *     WITH a fallback (same recompute as the `undefined` case); for Apple
 *     Music (no fallback) the url never changes for an `'unresolved'`
 *     verdict, in every reachable branch — so it is left as the live column
 *     untouched.
 *
 * Every `${statusCol} = 'verified'` (and `'absent'`) comparison below is
 * written out at its use site rather than factored into a shared
 * sub-fragment — a flat template per branch, directly inspectable by a test
 * via `.sql`/`.values` without needing to recurse through nested `SQL`
 * objects (see `buildStreamingFieldConflictSet`'s unit tests). These
 * predicates read the LIVE row (evaluated by Postgres against the
 * pre-UPDATE row, same as every other `set` expression in an
 * `ON CONFLICT DO UPDATE`) — this is exactly what closes the TOCTOU window:
 * whatever a concurrent CDC verify wrote before this UPDATE commits is what
 * these CASEs see.
 */
export function buildStreamingFieldConflictSet(
  statusCol: AnyColumn,
  urlCol: AnyColumn,
  incomingStatus: StreamingResolutionStatus | undefined,
  incomingUrl: string | null,
  fallbackUrl: string | null
): { status: SQL; url: SQL } {
  const hasFallback = fallbackUrl !== NO_FALLBACK;

  if (incomingStatus === undefined) {
    return {
      status: sql`${statusCol}`,
      url: hasFallback
        ? sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${fallbackUrl} END`
        : sql`${urlCol}`,
    };
  }

  if (incomingStatus === 'verified') {
    return {
      status: sql`'verified'`,
      url: sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${incomingUrl} END`,
    };
  }

  if (incomingStatus === 'absent') {
    return {
      status: sql`CASE WHEN ${statusCol} = 'verified' THEN ${statusCol} ELSE 'absent' END`,
      url: sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${fallbackUrl} END`,
    };
  }

  // incomingStatus === 'unresolved'
  return {
    status: sql`CASE WHEN ${statusCol} = 'verified' OR ${statusCol} = 'absent' THEN ${statusCol} ELSE 'unresolved' END`,
    url: hasFallback ? sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${fallbackUrl} END` : sql`${urlCol}`,
  };
}

/**
 * Fill-null PLUS upgrade-if-placeholder, for the four streaming-search columns
 * only (BS#2179 review HIGH 1). Lifted verbatim from
 * `jobs/flowsheet-no-match-recheck/writer.ts`, where it was a module-local.
 *
 * A plain `COALESCE(column, incoming)` is a guaranteed no-op wherever the
 * candidate row already carries a synthesized search URL in these columns, and
 * several writers' cohorts do: `apps/enrichment-worker/enrich.ts`'s unlinked
 * no-match write pre-populates all four UNCONDITIONALLY, and
 * `jobs/flowsheet-metadata-backfill/enrich.ts` COALESCEs a synthesized
 * `open.spotify.com/search/…` into `album_metadata.spotify_url` without
 * touching `artwork_url`. Against a column that is never NULL, COALESCE can
 * never let a real Discogs-sourced link land.
 *
 * This CASE generalizes COALESCE: it fills a NULL exactly like COALESCE does,
 * AND additionally prefers `incoming` when the STORED value is itself one of
 * the exact synthesized placeholders (detected by prefix) — which a genuinely
 * verified URL never is. A `null` incoming always falls through to the stored
 * value, so a verified link already in the column is never downgraded. Mirrors
 * `jobs/streaming-url-upgrade/resolve.ts`'s `isSearchShaped` never-downgrade
 * guard, generalized to a fill-null write instead of that job's
 * search-shaped-only write.
 *
 * **`prefix` stays a parameter; the prefix TABLE stays with its callers.** The
 * placeholder vocabulary (`SEARCH_URL_PREFIX` in that same writer) is
 * search-URL vocabulary, not write mechanics, and its own doc comment records
 * that it is deliberately NOT `@wxyc/metadata`'s `synthesizeSearchUrls` — which
 * covers 3 of these 4 columns and omits spotify (BS#1184/#1192). Giving those
 * strings a third home with no drift guard would invite exactly the divergence
 * that comment warns about, so callers pass their own prefix and pin it with a
 * parity test.
 *
 * **Signature note.** The original took `AnyPgColumn` (`drizzle-orm/pg-core`);
 * here it takes `AnyColumn`, matching `buildStreamingFieldConflictSet` so the
 * module has one column vocabulary and no `pg-core` import. This is a widening,
 * so no existing caller can break, and it costs nothing real — the body only
 * interpolates the column into a `sql` template, exactly as the other builder
 * does with `AnyColumn`.
 */
export const fillOrUpgradeSearchUrl = (column: AnyColumn, incoming: string | null, prefix: string): SQL =>
  sql`CASE WHEN ${incoming} IS NOT NULL AND (${column} IS NULL OR ${column} LIKE ${prefix + '%'}) THEN ${incoming} ELSE ${column} END`;
