/**
 * BS→LML caller classification + per-class timeout/budget policy (BS#1826).
 *
 * Every BS→LML call already carries a `caller` string label
 * (`LookupOptions.caller`, `index.ts`) — historically observability-only,
 * projected onto the `lml.lookup` Sentry span but driving no timeout or
 * fallback behavior. This module is the policy layer that closes that gap:
 * one `caller`-keyed table mapping every registered caller to a traffic
 * class (1-5), each with its own default `timeoutMs` / `budgetMs`.
 *
 * See `plans/bs1826-lml-caller-classification.md` for the full design
 * (the "Caller → class map" and "Proposed per-class budgets" tables this
 * module implements verbatim) and the PR slicing this file belongs to
 * (PR 1: policy module + thread-through-client, `caller` still optional).
 *
 * BEHAVIORAL NOTE — this is NOT a no-op deploy. The policy is keyed on
 * `caller`, and several production call sites already pass a registered
 * `caller` label today (historically for observability). The moment this
 * threading lands, those already-labeled callers pick up their class
 * `timeoutMs`/`budgetMs` defaults — e.g. interactive `library-track-search`
 * / `request-line` tighten from the 30s `TIMEOUT_MS` fallback to the class-2
 * budget. This is the intended PRD #1819 behavior (bound interactive paths),
 * and every class timeout is reversible in prod via the `LML_CLASS{1..5}_
 * TIMEOUT_MS` env knobs. Only callers that pass NO `caller` remain
 * byte-identical (30s). See the plan's "Risks / watch-items".
 *
 * This module intentionally has no side effects of its own beyond reading
 * env vars inside `resolveLmlPolicy` — no fetch, no Sentry, no limiter
 * construction. Those stay in `index.ts`, which is the actual chokepoint.
 */

import { envInt } from './index.js';

/**
 * The five BS→LML traffic classes (plan's "Proposed per-class budgets"
 * table):
 *
 *   1. Protected local catalog search — short, no-fallback-to-5xx.
 *   2. Interactive enrichment/lookup — user-adjacent, degrades gracefully.
 *   3. Identity / release-metadata reads — PG-cached reads plus the
 *      user-awaited pre-INSERT identity resolve (a per-caller override).
 *   4. Streaming availability checks — best-effort, null-on-timeout.
 *   5. Batch/backfill enrichment — long-lived, per-item error isolation.
 */
export type LmlCallerClass = 1 | 2 | 3 | 4 | 5;

/**
 * Which limiter a class's callers SHOULD use, for documentation and the
 * eventual CI guard (Step 4) — not a live override. `index.ts` continues to
 * decide the actual `LmlLimiter` instance via `options.limiter ??
 * defaultLimiter`; this field never mutates that logic. `'default'` means
 * the process-wide `defaultLimiter` is appropriate; `'none'` means either no
 * limiter participates (classes 1 and 3 hit PG-cached / low-volume
 * endpoints) or the caller MUST supply its own dedicated limiter (class 5 —
 * see the per-class budget table's "dedicated per-job limiter, never
 * defaultLimiter" note).
 */
export type LmlCallerLimiter = 'default' | 'none';

/**
 * Resolved policy for one caller: the class it belongs to plus the
 * timeout/budget/limiter/fallback defaults that class (and any per-caller
 * override) implies. `timeoutMs` is always present — every class has a
 * default. `budgetMs` is present only for classes that set the
 * `X-Caller-Budget-Ms` header (2, 5); classes 1/3/4 have "no budget header"
 * per the plan table. `limiter` and `fallback` are documentation-only (see
 * `LmlCallerLimiter`) — `index.ts` does not read them to alter transport
 * behavior in this PR.
 */
export interface LmlPolicy {
  class: LmlCallerClass;
  timeoutMs: number;
  budgetMs?: number;
  limiter?: LmlCallerLimiter;
  /** One-line description of what happens when this class's budget is exceeded. */
  fallback?: string;
}

/**
 * The registered caller labels, one entry per distinct label observed in
 * the tree today (verified via `grep -rhoE "caller:\s*['\"][a-zA-Z0-9_-]+"`.
 * across `apps/**`/`jobs/**`/`shared/**`) plus the labels this plan
 * introduces: `proxy-library-search` (the currently-unlabeled
 * `proxy.controller.ts:710` `searchLibrary` call, class 1 — the PRD's
 * protected-search win), `library-add-album-streaming` /
 * `library-update-album-streaming` (splitting the streaming-check call at
 * `library.controller.ts` off of its sibling metadata `lookup` call, which
 * needs a different class), and `proxy` (the shared label for the
 * currently-hard-coded-30s `getRelease`/`getArtistDetails`/`resolveEntity`
 * reads).
 *
 * `ALL_LML_CALLERS` is the single source of truth this type is derived
 * from — tests iterate over it so "every registered caller resolves to
 * exactly one class" can't drift from the type itself.
 */
export const ALL_LML_CALLERS = [
  // Class 1 — protected local catalog search.
  'proxy-library-search',
  // Class 2 — interactive enrichment/lookup.
  'library-track-search',
  'library-rotation-picker',
  'proxy-album-metadata',
  'library-enrich-artwork',
  'artwork-discogs-fallback',
  'request-line',
  'library-add-album',
  'library-update-album',
  'flowsheet-linkage',
  // `library-canonical-entity` is class 2 (warm_cache write-through through
  // the shared defaultLimiter — see the CALLER_CLASS note), not a budget-less
  // class-3 read.
  'library-canonical-entity',
  // Class 3 — identity / release-metadata reads.
  'add_to_rotation',
  'proxy',
  // Class 4 — streaming availability checks.
  'library-add-album-streaming',
  'library-update-album-streaming',
  // Class 5 — batch/backfill enrichment.
  'metadata-service',
  'enrichment-worker',
  'flowsheet-metadata-backfill',
  'album-level-backfill',
  'catalog-popularity-freetext-resolve',
  'flowsheet-linked-reenrichment',
  'flowsheet-artwork-repair',
  'flowsheet-reenrichment',
  'streaming-url-upgrade',
  'apple-music-url-backfill',
  'concerts-genre-enrichment',
  'concerts-artist-lml-resolver',
] as const;

export type LmlCaller = (typeof ALL_LML_CALLERS)[number];

const CALLER_CLASS: Record<LmlCaller, LmlCallerClass> = {
  'proxy-library-search': 1,
  'library-track-search': 2,
  'library-rotation-picker': 2,
  'proxy-album-metadata': 2,
  'library-enrich-artwork': 2,
  'artwork-discogs-fallback': 2,
  'request-line': 2,
  'library-add-album': 2,
  'library-update-album': 2,
  'flowsheet-linkage': 2,
  add_to_rotation: 3,
  proxy: 3,
  // Class 2, not 3: this is a `warm_cache` write-through that can reach the
  // Discogs cascade and runs through the shared `defaultLimiter` — class-2
  // semantics (soft budget header + short timeout), not a budget-less
  // class-3 PG-cached read. Class 3 would hold a defaultLimiter permit for
  // the full 8s with no LML soft-cutoff, back-pressuring concurrent
  // interactive lookups (BS#994/#995). The prior LIBRARY_LML_BUDGET_MS (5s
  // budget) is thus preserved in spirit as class 2's 4s budget / 5s timeout.
  'library-canonical-entity': 2,
  'library-add-album-streaming': 4,
  'library-update-album-streaming': 4,
  'metadata-service': 5,
  'enrichment-worker': 5,
  'flowsheet-metadata-backfill': 5,
  'album-level-backfill': 5,
  'catalog-popularity-freetext-resolve': 5,
  'flowsheet-linked-reenrichment': 5,
  'flowsheet-artwork-repair': 5,
  'flowsheet-reenrichment': 5,
  'streaming-url-upgrade': 5,
  'apple-music-url-backfill': 5,
  'concerts-genre-enrichment': 5,
  'concerts-artist-lml-resolver': 5,
};

/**
 * BS#992 exception, preserved as a per-caller override within class 2
 * rather than a 6th class (plan Design decision #2/#3). Hardcoded — not an
 * env lever — per the plan's explicit call-out: "carry it as a code-constant
 * override... unless we deliberately add `LML_CLASS2_ROTATION_TIMEOUT_MS`."
 * Mirrors the pre-existing `ROTATION_LML_LOOKUP_TIMEOUT_MS` in
 * `apps/backend/services/library.service.ts`.
 */
const ROTATION_PICKER_TIMEOUT_MS = 10000;
const ROTATION_PICKER_BUDGET_MS = 9000;

/**
 * #1828's constant, preserved as a class-2 per-caller `budgetMs` override
 * (plan Design decision #3) rather than folding into the class-2 default —
 * `library-enrich-artwork` is the most droppable of the interactive
 * callers. Mirrors the pre-existing `LIBRARY_SEARCH_LML_BUDGET_MS` env var
 * in `apps/backend/services/library.service.ts`.
 */
const LIBRARY_ENRICH_ARTWORK_BUDGET_ENV = 'LIBRARY_SEARCH_LML_BUDGET_MS';
const LIBRARY_ENRICH_ARTWORK_BUDGET_FALLBACK_MS = 2000;

/**
 * `add_to_rotation`'s class-3 identity override. Mirrors the pre-existing
 * `RESOLVE_IDENTITY_TIMEOUT_MS` fallback in `index.ts`'s `resolveIdentity` —
 * both read the same `LML_RESOLVE_TIMEOUT_MS` env lever so the ops lever
 * introduced by BS#1380 survives this policy layer unchanged.
 */
const ADD_TO_ROTATION_TIMEOUT_ENV = 'LML_RESOLVE_TIMEOUT_MS';
const ADD_TO_ROTATION_TIMEOUT_FALLBACK_MS = 2000;

const CLASS_FALLBACK: Record<LmlCallerClass, string> = {
  1: 'on timeout/error return local/empty, never 5xx',
  2: 'degrade to unenriched/free-text',
  3: 'null-on-timeout; daily cron reconciles',
  4: 'persist null; read path synthesizes search URL',
  5: 'per-item error isolation; retry next cycle',
};

/**
 * Read each class's `timeoutMs` (and, for class 2, its dedicated
 * `budgetMs`) from the new `LML_CLASS{1..5}_TIMEOUT_MS` / `LML_CLASS2_
 * BUDGET_MS` env knobs, falling back to the plan's proposed defaults. Read
 * fresh on every call (not cached at module scope) so `_resetLmlPolicyForTest`
 * can exercise env changes without a process restart — mirrors the
 * `_resetLmlClientLimitersForTest` pattern in `index.ts`.
 */
function classDefaults(cls: LmlCallerClass): { timeoutMs: number; budgetMs?: number; limiter: LmlCallerLimiter } {
  switch (cls) {
    case 1:
      return { timeoutMs: envInt('LML_CLASS1_TIMEOUT_MS', 3000), limiter: 'none' };
    case 2: {
      const timeoutMs = envInt('LML_CLASS2_TIMEOUT_MS', 5000);
      const budgetMs = envInt('LML_CLASS2_BUDGET_MS', 4000);
      return { timeoutMs, budgetMs, limiter: 'default' };
    }
    case 3:
      // No budget header on class-3 reads (plan table: "—"). `timeoutMs`
      // here is the 8 s PG-cached-read default; `add_to_rotation`'s 2 s
      // identity override is layered on top below.
      return { timeoutMs: envInt('LML_CLASS3_TIMEOUT_MS', 8000), limiter: 'none' };
    case 4:
      return { timeoutMs: envInt('LML_CLASS4_TIMEOUT_MS', 5000), limiter: 'default' };
    case 5: {
      const timeoutMs = envInt('LML_CLASS5_TIMEOUT_MS', 29000);
      // Codebase convention: budgetMs ≈ timeoutMs − 1000 (plan line 27) so
      // LML's soft cutoff fires before the socket aborts.
      return { timeoutMs, budgetMs: Math.max(0, timeoutMs - 1000), limiter: 'none' };
    }
  }
}

/**
 * Build the full caller → policy table from the current `process.env`.
 * Exposed indirectly via `LML_CALLER_POLICY` (computed once at module
 * load, matching every other env-derived constant in this package) and
 * `_resetLmlPolicyForTest` (rebuilds in place after a test mutates env).
 */
function buildPolicy(): Record<LmlCaller, LmlPolicy> {
  const table = {} as Record<LmlCaller, LmlPolicy>;

  for (const caller of ALL_LML_CALLERS) {
    const cls = CALLER_CLASS[caller];
    const defaults = classDefaults(cls);
    table[caller] = {
      class: cls,
      timeoutMs: defaults.timeoutMs,
      budgetMs: defaults.budgetMs,
      limiter: defaults.limiter,
      fallback: CLASS_FALLBACK[cls],
    };
  }

  // Per-caller overrides, layered on top of the class defaults above.
  table['library-rotation-picker'] = {
    ...table['library-rotation-picker'],
    timeoutMs: ROTATION_PICKER_TIMEOUT_MS,
    budgetMs: ROTATION_PICKER_BUDGET_MS,
  };
  table['library-enrich-artwork'] = {
    ...table['library-enrich-artwork'],
    budgetMs: envInt(LIBRARY_ENRICH_ARTWORK_BUDGET_ENV, LIBRARY_ENRICH_ARTWORK_BUDGET_FALLBACK_MS),
  };
  table.add_to_rotation = {
    ...table.add_to_rotation,
    timeoutMs: envInt(ADD_TO_ROTATION_TIMEOUT_ENV, ADD_TO_ROTATION_TIMEOUT_FALLBACK_MS),
  };

  return table;
}

/**
 * The full caller → policy table, built from `process.env` at module load.
 * A plain mutable object (not a getter) so it matches the `Record<LmlCaller,
 * ...>` shape the plan specifies; `_resetLmlPolicyForTest` mutates it in
 * place for tests that need to observe an env change without re-importing
 * the module.
 */
export const LML_CALLER_POLICY: Record<LmlCaller, LmlPolicy> = buildPolicy();

/**
 * Test-only: rebuild `LML_CALLER_POLICY` from the current `process.env`.
 * Production code never calls this — the table is intentionally built once
 * at module load, matching the rest of this package's env-derived
 * constants. Mirrors `_resetLmlClientLimitersForTest` in `index.ts`.
 */
export function _resetLmlPolicyForTest(): void {
  Object.assign(LML_CALLER_POLICY, buildPolicy());
}

/**
 * Resolve the policy for a registered caller. Throws for any caller not in
 * `ALL_LML_CALLERS` — a loud failure at the one place every caller MUST be
 * registered, rather than a silent `class: unknown` default that would let
 * a new call site skip classification. New callers register themselves by
 * adding a label to `ALL_LML_CALLERS` + `CALLER_CLASS` above.
 *
 * `index.ts`'s internal defaulting (still-optional `caller` in this PR)
 * does NOT call this directly — see the "soft" lookup note in `index.ts`
 * for why an as-yet-unregistered or mistyped `caller` string must not
 * crash a live request path before `caller` becomes a compile-time-checked
 * `LmlCaller` (PR 2). This function is the public, throwing contract for
 * callers that already know they're passing a valid `LmlCaller`.
 */
export function resolveLmlPolicy(caller: LmlCaller): LmlPolicy {
  const policy = LML_CALLER_POLICY[caller];
  if (!policy) {
    throw new Error(
      `lml.client: unregistered LML caller "${caller}" — register it in ALL_LML_CALLERS + CALLER_CLASS ` +
        `(shared/lml-client/src/policy.ts, BS#1826) before using it.`
    );
  }
  return policy;
}
