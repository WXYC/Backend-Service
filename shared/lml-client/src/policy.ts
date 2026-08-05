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
 *
 * CORRECTED MODEL (BS#1914). The plan's "budgetMs ≈ timeoutMs − 1000, so
 * LML's soft cutoff fires before the socket aborts" formula (still visible
 * below in the class-5 branch of `classDefaults`, kept because changing the
 * emitted wire value is a real behavior change, not a docs fix) rests on a
 * false picture of what the `X-Caller-Budget-Ms` header actually does on
 * LML's side. LML computes its effective search budget as
 * `min(header − 200ms, LML_SEARCH_BUDGET_MS)` (LML `core/search.py`
 * `resolve_effective_search_budget_ms`); prod leaves `LML_SEARCH_BUDGET_MS`
 * unset, defaulting to 4000ms. So the header can only ever TIGHTEN LML's
 * budget, never extend it — a class-5 caller's 28000ms header is mostly
 * symbolic, clamped down to ~4s same as class 2's 4000ms header (→ 3800ms
 * effective). The header's mere *presence* — not its magnitude — is also
 * what arms LML's empty-state cascade cutoff (LML#345) and enrichment-tail
 * shed (LML#930); a caller that sends NO header instead grinds on to LML's
 * own hard cap, `LML_SEARCH_HARD_TIMEOUT_MS` (default 25000ms, also unset in
 * prod). Raising the effective budget fleet-wide is an LML-side lever
 * (`LML_SEARCH_BUDGET_MS`, tracked at WXYC/library-metadata-lookup#1111,
 * itself past its own stated expiry) or a new LML per-caller trust feature —
 * out of scope for this client.
 *
 * PER-CLASS EMPTY-STATE DECISION (BS#1914), now that the real contract is
 * known:
 *
 *   - Class 5, **offline drains** (`flowsheet-metadata-backfill`,
 *     `album-level-backfill`, `catalog-popularity-freetext-resolve`,
 *     `flowsheet-linked-reenrichment`, every `*-backfill` job): KEEP sending
 *     the header. The ~4s empty-state fast-degrade is the desired behavior
 *     for a bulk drain — a hard-miss row should give up quickly and free the
 *     shared Discogs ceiling for the next row — so this is now a deliberate
 *     choice rather than an inherited accident.
 *   - Class 5, the live CDC **`enrichment-worker`**: the 4s cutoff is WRONG
 *     for this caller and is actively producing user-visible metadata gaps.
 *     This worker enriches new rotation arrivals — albums in neither
 *     `library.db` nor the library-filtered Discogs cache — whose cold
 *     non-library release resolution measures 4–20s on prod. Under the
 *     effective 4s budget, LML returns either an empty `timeout: true` body
 *     or `degraded: true, degraded_reason: 'deadline_exceeded'` with
 *     `artwork: null`, and the worker writes a terminal `enriched_no_match`.
 *     A 2026-08-04 replay of one day's 41 rotation-linked no-match playcuts,
 *     headerless, recovered 24 (59%) as full Discogs matches with artwork
 *     (see the evidence comment on BS#1914). This caller is the intended
 *     FIRST consumer of the `budgetMs: null` suppression lever below;
 *     flipping it is WXYC/Backend-Service#1978 (blocked by this ticket,
 *     ships behind its own default-off flag) — NOT done here. The sibling
 *     WXYC/Backend-Service#1977 stops recording a deadline shed as a
 *     terminal no-match (independent of the budget lever), and
 *     WXYC/Backend-Service#1979 is the one-shot drain for rows already
 *     frozen by this gap. WXYC/library-metadata-lookup#1112 tracks that the
 *     shed still discards release-resolution work LML already paid for.
 *   - Class 2: the header value (4000) is close to the effective budget
 *     (3800), so the false model was only mildly wrong here — with one
 *     pre-existing exception, tracked separately, not fixed here:
 *     `library-rotation-picker`'s per-caller override sets a budget
 *     unconditionally, while `library.service.ts` documents at length that
 *     this call site intentionally sends NO budget companion because a 4s
 *     cap collapsed its coverage. Under the corrected model the override
 *     re-imposes that same cap. See WXYC/Backend-Service#1983.
 *
 * `LookupOptions.budgetMs: null` (`index.ts`) is the lever this correction
 * adds: an explicit, distinct-from-`undefined` suppression signal that omits
 * `X-Caller-Budget-Ms` from the wire request entirely, restoring the
 * headerless path for a caller that wants LML's full cascade instead of the
 * empty-state fast-degrade. `sanitizeCallBudgetMs` (below) applies the
 * always-safe half of `sanitizeBudgetMs`'s guard — `<= 0` plus a
 * `Number.isFinite` check — to that per-call override, so a bad literal at
 * a call site can't emit a nonsensical header. It deliberately does NOT
 * apply the `>= timeoutMs` half: that branch's own rationale is rooted in
 * the same false model this correction removes, and reusing it here would
 * silently flip several real callers' wire behavior — see
 * `sanitizeCallBudgetMs`'s docstring for the specifics.
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
  // BS#2000: the V/A remediation one-shot. Same shape as its
  // `apple-music-url-backfill` donor (offline re-query of persisted
  // apple_music_url rows), inverted polarity — that job filled nulls, this one
  // re-adjudicates non-nulls against the post-LML#1139 guarded matcher.
  'va-apple-music-url-remediation',
  'concerts-genre-enrichment',
  'concerts-artist-lml-resolver',
  // BS#1826 PR 3: registered alongside the missing `caller` this label's
  // guard run surfaced at jobs/rotation-release-id-backfill/lml-fetch.ts —
  // the plan's caller→class map already commits "rotation-*-backfill" to
  // class 5; this completes that for the release-id backfill specifically.
  // `rotation-artist-backfill` (the other rotation-*-backfill job) has no
  // caller-bearing call site — it only calls `refreshForIdentities`, which
  // takes no `caller` parameter — so it needs no entry here.
  'rotation-release-id-backfill',
  // BS#1283 (epic #1280 sub-issue 3): the daily discogs_unavailable recheck
  // cron. Class 5 — batch/backfill enrichment, dedicated per-job limiter
  // (`jobs/library-discogs-unavailable-recheck/lml-limiter.ts`), never the
  // shared `defaultLimiter`.
  'library-discogs-unavailable-recheck',
  // BS#1910: closes the D4 prod-gate for LML's `/lookup` location-union
  // feature (library-metadata-lookup's
  // `plans/location-union-transparent-results.md`) — LML skips its new
  // recall-index probe only for callers it sees as low-priority
  // (`X-Caller-Class=5`); both of these jobs already send real `/lookup`
  // traffic and were previously invisible to that gate.
  // `library-artwork-url-backfill` already called through
  // `@wxyc/lml-client` (this registration was its own docstring's
  // documented deferred follow-up); `library-canonical-entity-backfill`
  // is migrated off a raw `fetch()` onto the shared client in the same PR
  // so it can carry the label at all.
  'library-artwork-url-backfill',
  'library-canonical-entity-backfill',
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
  'va-apple-music-url-remediation': 5,
  'concerts-genre-enrichment': 5,
  'concerts-artist-lml-resolver': 5,
  'rotation-release-id-backfill': 5,
  'library-discogs-unavailable-recheck': 5,
  'library-artwork-url-backfill': 5,
  'library-canonical-entity-backfill': 5,
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
      // Historical formula, kept: budgetMs = timeoutMs − 1000 (plan line 27).
      // Its original rationale ("so LML's soft cutoff fires before the
      // socket aborts") was FALSE — see the module docstring's "CORRECTED
      // MODEL" paragraph (BS#1914) for the real contract. LML clamps the
      // effective search budget to min(header − 200ms, LML_SEARCH_BUDGET_MS)
      // (prod default 4000), so this class's real empty-state cutoff is ~4s,
      // not ~28s, regardless of what timeoutMs derives here. The formula
      // itself is kept — not replaced with a flat constant — only because it
      // reliably yields a positive, sub-timeoutMs value across every sane
      // `LML_CLASS5_TIMEOUT_MS` override, and changing the emitted wire
      // value is a genuine behavior change (a caller-by-caller decision, see
      // the module docstring's "PER-CLASS EMPTY-STATE DECISION"), not a
      // docs-only fix. May still come out <= 0 for a very low
      // `LML_CLASS5_TIMEOUT_MS` override — `sanitizeBudgetMs` (applied to
      // every table entry in `buildPolicy`) catches that.
      return { timeoutMs, budgetMs: timeoutMs - 1000, limiter: 'none' };
    }
  }
}

/**
 * BS#1842: guard against two operator-misconfiguration edges in a caller's
 * final `{ timeoutMs, budgetMs }` pair, after class defaults AND per-caller
 * overrides are both applied:
 *
 *   - `budgetMs <= 0` — e.g. a low `LML_CLASS5_TIMEOUT_MS` override drives
 *     the derived `timeoutMs - 1000` non-positive. `buildLookupHeaders`
 *     sends `X-Caller-Budget-Ms` whenever `budgetMs !== undefined` — a `0`
 *     header would instruct LML to soft-cut before any work happens.
 *   - `budgetMs >= timeoutMs` — the socket aborts before (or exactly when)
 *     the soft budget would fire, so the header can never take effect. Class
 *     2's `LML_CLASS2_TIMEOUT_MS` / `LML_CLASS2_BUDGET_MS` env knobs are read
 *     independently (no cross-check at the env layer), so this is reachable
 *     from ops config alone, no code change required.
 *
 * Both edges warn (never throw — a live request path must not crash on a
 * misconfigured env var) and fall back to "no budget header" (`undefined`),
 * matching the documented `envInt`-style warn-on-invalid convention used
 * throughout this package. A well-formed `0 < budgetMs < timeoutMs` passes
 * through unchanged.
 *
 * Policy-table-only. BS#1914 (per-call overrides) deliberately does NOT
 * reuse this function wholesale — see `sanitizeCallBudgetMs` below for why,
 * and why that's a narrower guard rather than this one exported as-is.
 */
function sanitizeBudgetMs(caller: LmlCaller, timeoutMs: number, budgetMs: number | undefined): number | undefined {
  if (budgetMs === undefined) return undefined;
  if (budgetMs <= 0) {
    console.warn(
      `lml.client: policy for caller "${caller}" computed budgetMs=${budgetMs} (<= 0); omitting the ` +
        'X-Caller-Budget-Ms header instead of soft-cutting immediately. Check LML_CLASS{2,5}_TIMEOUT_MS / ' +
        'LML_CLASS2_BUDGET_MS env overrides.'
    );
    return undefined;
  }
  if (budgetMs >= timeoutMs) {
    console.warn(
      `lml.client: policy for caller "${caller}" has budgetMs=${budgetMs} >= timeoutMs=${timeoutMs}; the soft ` +
        'budget could never fire before the socket aborts, so omitting the X-Caller-Budget-Ms header. Check ' +
        'LML_CLASS{2,5}_TIMEOUT_MS / LML_CLASS2_BUDGET_MS env overrides.'
    );
    return undefined;
  }
  return budgetMs;
}

/**
 * BS#1914: the per-call analogue of `sanitizeBudgetMs` above, deliberately
 * narrower — it does NOT reject `budgetMs >= timeoutMs`.
 *
 * `sanitizeBudgetMs`'s `>= timeoutMs` branch reasons from the header's raw
 * VALUE ("the soft budget could never fire before the socket aborts") —
 * exactly the false model this ticket exists to correct. Under LML's real
 * `min(header − 200ms, LML_SEARCH_BUDGET_MS)` clamp, a header that's
 * nominally `>= timeoutMs` still collapses to LML's tiny effective budget
 * (~4s in prod) and fires it comfortably before any socket abort — the
 * cutoff WAS working; the raw-value comparison was measuring the wrong
 * thing entirely. Reusing that branch for per-call overrides would flip
 * real production callers from "sends the header" to "omits it" — the
 * OPPOSITE of the BS#1914 decision record's "class-5 offline drains keep
 * the header" call — for cases like:
 *
 *   - `jobs/rotation-release-id-backfill` / `jobs/library-discogs-
 *     unavailable-recheck`: both pass an explicit `timeoutMs: 8000`
 *     (`*_TIMEOUT_MS` env, default 8000) with no `budgetMs` of their own, so
 *     they inherit the class-5 policy default (`28000` at today's defaults).
 *     `28000 >= 8000` on every single call.
 *   - `jobs/album-level-backfill` / `jobs/flowsheet-linked-reenrichment` /
 *     `jobs/catalog-popularity-freetext-resolve`: each computes
 *     `timeoutMs = batchSize * 5000 + 5000` and passes an explicit
 *     `budgetMs` (`BULK_BUDGET_MS_DEFAULT`, `25000`) — `budgetMs >=
 *     timeoutMs` whenever `batchSize <= 4`, which includes every run's
 *     trailing partial batch.
 *
 * So only the always-safe `<= 0` branch applies here, plus a
 * `Number.isFinite` check `sanitizeBudgetMs` doesn't need: every value that
 * reaches it comes from `envInt` (guaranteed finite) or a hardcoded
 * constant, but a per-call literal computed at a call site has no such
 * guarantee, and an unguarded `NaN` would reach the wire as literally
 * `X-Caller-Budget-Ms: NaN`.
 *
 * Whether the `>= timeoutMs` branch belongs on the POLICY table either is
 * an open question this function deliberately leaves unresolved — see the
 * discussion on WXYC/Backend-Service#1914.
 */
export function sanitizeCallBudgetMs(caller: string, budgetMs: number | undefined): number | undefined {
  if (budgetMs === undefined) return undefined;
  if (!Number.isFinite(budgetMs)) {
    console.warn(
      `lml.client: caller "${caller}" resolved to a non-finite budgetMs=${budgetMs}; omitting the ` +
        'X-Caller-Budget-Ms header. Check the per-call `budgetMs` override for a bad computation (e.g. NaN).'
    );
    return undefined;
  }
  if (budgetMs <= 0) {
    console.warn(
      `lml.client: caller "${caller}" resolved to budgetMs=${budgetMs} (<= 0); omitting the X-Caller-Budget-Ms ` +
        'header instead of soft-cutting immediately. Check the per-call `budgetMs` override.'
    );
    return undefined;
  }
  return budgetMs;
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

  // BS#1842: sanitize every entry's final budgetMs AFTER class defaults and
  // per-caller overrides are both applied — a misconfig can originate from
  // either layer (a class-level env knob, or an override's own env knob).
  for (const caller of ALL_LML_CALLERS) {
    table[caller].budgetMs = sanitizeBudgetMs(caller, table[caller].timeoutMs, table[caller].budgetMs);
  }

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
