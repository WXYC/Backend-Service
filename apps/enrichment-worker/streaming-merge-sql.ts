/**
 * Side-effect-free SQL-fragment builder for the streaming-field TOCTOU fix
 * (BS#1923), extracted out of `enrich.ts` (BS#1945).
 *
 * `buildStreamingFieldConflictSet` has NO import-time side effects: this
 * module touches only `drizzle-orm`'s `sql` tag (a pure query-fragment
 * builder — importing it opens no socket, starts no timer) and a type-only
 * reference to `@wxyc/lml-client`'s `StreamingResolutionStatus` (erased at
 * compile time, so it carries no runtime dependency on the LML client
 * either). No `@wxyc/database` `db` singleton, no LML HTTP client.
 *
 * That is exactly what lets this module be built as its own tsup entry
 * (`tsup.config.ts`, dual esm+cjs — same recipe as
 * `jobs/artist-unicode-dedup/merge.ts`) and `require`d directly, as compiled
 * `dist/streaming-merge-sql.cjs`, by a plain `.spec.js` integration test:
 * `tests/integration/enrichment-worker-streaming-toctou.spec.js` runs THIS
 * REAL function's output against a live Postgres instead of a
 * hand-duplicated SQL mirror. Before BS#1945, hand-editing this function in
 * `enrich.ts` without updating that mirror left the integration spec green
 * against stale SQL; now the spec imports the genuine article, so there is
 * no second copy to drift.
 *
 * `enrich.ts` re-imports and re-exports `buildStreamingFieldConflictSet`
 * unchanged, so `tests/unit/apps/enrichment-worker/enrich.test.ts` — which
 * pins this function's exact `.sql`/`.values` output — keeps importing it
 * from the same `apps/enrichment-worker/enrich` path with no test changes.
 *
 * @see WXYC/Backend-Service#1923 (the TOCTOU fix this builder implements)
 * @see WXYC/Backend-Service#1945 (this extraction)
 */

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { StreamingResolutionStatus } from '@wxyc/lml-client';

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
