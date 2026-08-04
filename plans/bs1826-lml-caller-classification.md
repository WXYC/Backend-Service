# BS#1826 — BS→LML caller classification + per-class timeout/fallback policy

Parent epic: [#876](https://github.com/WXYC/Backend-Service/issues/876) (BS↔LML single coordinator). Slice of PRD [#1819](https://github.com/WXYC/Backend-Service/issues/1819) (protect local catalog search from LML enrichment degradation). Directly absorbs the one-off `LIBRARY_SEARCH_LML_BUDGET_MS` constant left behind by [#1828](https://github.com/WXYC/Backend-Service/issues/1828) (`apps/backend/services/library.service.ts:627`; the comment at `:625` says "fold into #1826's per-class policy layer when that lands").

## Problem

Every BS→LML call already passes a `caller` string label (`LookupOptions.caller`, `shared/lml-client/src/index.ts:436`) — 18 distinct labels in tree — but the label is **observability-only**: it is projected onto the `lml.lookup` Sentry span and drives no timeout or fallback behavior. Timeout/budget is instead set by ~6 scattered module-level constants (`LIBRARY_LML_BUDGET_MS`, `PROXY_LML_BUDGET_MS`, `LIBRARY_INTERACTIVE_LML_BUDGET_MS`, `LIBRARY_SEARCH_LML_BUDGET_MS`, `METADATA_SERVICE_LML_BUDGET_MS`, `ROTATION_LML_LOOKUP_TIMEOUT_MS`) plus per-job ad-hoc values, and the non-`/lookup` reads (`getRelease`, `getArtistDetails`, `resolveEntity`, `searchTrackReleases`, `searchLibrary`) hard-code the 30 s `TIMEOUT_MS` with no budget at all.

Consequence: a new call site inherits whatever default the method happens to use, with no forcing function to classify it. Protected local search and a batch backfill can share the same 30 s budget. The PRD wants the opposite: local catalog search must be a short, protected class that cannot be starved by enrichment/batch work.

## Goal / end state

One `caller`-keyed **policy layer** in `@wxyc/lml-client` maps every caller to one of 5 traffic classes, each with its own `timeoutMs` / `budgetMs` / limiter / fallback default. Every current BS→LML call site is classified; a CI guard fails when a new call site uses an unregistered `caller` (or omits it on a budget-bearing method). The scattered per-callsite budget constants collapse into the policy table.

Deliberately **not** in scope (owned elsewhere / other PRD slices): LML-side lane isolation/admission control (LML repo); event-driven enrichment (Epic C); the local-first playcut assembly (#1827); the freetext play-floor (#1822). This is the BS-side classification chokepoint only.

## Design decisions (resolved during research)

1. **Chokepoint shape → hybrid: keep the 14 transport methods, add one `caller`-keyed policy table.** Not a per-class method split. The same method serves multiple classes distinguished only by `caller` (e.g. `bulkLookupMetadata` is called by the live enrichment-worker _and_ three offline drains), so a per-class method split would fork each method 3–4×. Call sites are already keyed by string label, which is the grain the policy fits.
2. **5 classes** (from the PRD): (1) protected local catalog search, (2) interactive enrichment/lookup, (3) identity/release-metadata reads, (4) streaming availability checks, (5) batch/backfill enrichment.
3. **#1828's constant is absorbed as a class-2 per-caller override, not a 6th class.** `library-enrich-artwork` is class 2 but the "most droppable" of the interactive callers; keep its stricter 2 s budget as `{ class: 2, budgetMsOverride: 2000 }` so the #1828 tuning survives.
4. **Policy lives _below_ the `LmlLookupCoordinator`, in the client.** Batch jobs bypass the coordinator, so putting policy in the client is the only place all callers pass through. The coordinator continues to supply `caller` and inherits the class default.
5. **Guard → grep-based CI script** modeled on `scripts/check-legacy-entry-id-writes.mjs` (wired in `.github/workflows/test.yml:192`), because typecheck **does not cover `jobs/**`** (per repo convention) and eslint ignores `scripts/**`/`*.mjs`. Belt-and-suspenders: also make `caller` a required typed union so `apps/**`+`shared/**` fail at compile time.

## Proposed per-class budgets

Anchored to the client's 30 s `AbortController` (`TIMEOUT_MS`, `index.ts:76`) and the 35 s Express server timeout (`apps/backend/app.ts`). Codebase convention at the time this plan was written: `budgetMs ≈ timeoutMs − 1000` (the LML-side soft cutoff fires before the socket aborts).

> **BS#1914 correction (2026-08-04):** the sentence above is false, and so is the "28000" `budgetMs` cell for class 5 below. See "BS#1914 — the real `X-Caller-Budget-Ms` contract, and the per-class decision" at the end of this document for the corrected model. Nothing about the wire values changed (the header sent is still 28000 for class 5, 4000 for class 2) — only the understanding of what those values do, plus a new suppression lever, changed. Read that section before trusting the word "budget" anywhere above this line.

| #   | Class                             | timeoutMs                                                          | budgetMs                                                                        | limiter                                           | fallback default                               |
| --- | --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| 1   | Protected local catalog search    | 3000                                                               | — (no budget header on `/library/search`)                                       | none (PG-cached)                                  | on timeout/error return local/empty, never 5xx |
| 2   | Interactive enrichment/lookup     | 5000 (rotation picker keeps 10000)                                 | 4000 (picker 9000); `library-enrich-artwork` override 2000                      | `defaultLimiter`                                  | degrade to unenriched/free-text                |
| 3   | Identity / release-metadata reads | 2000 identity (user-awaited pre-INSERT); 8000 PG-cached reads      | —                                                                               | none                                              | null-on-timeout; daily cron reconciles         |
| 4   | Streaming availability checks     | 5000                                                               | — (no budget header on `/streaming-check`)                                      | `defaultLimiter`                                  | persist null; read path synthesizes search URL |
| 5   | Batch/backfill enrichment         | 29000 single / batch-scaled for bulk (`batchSize×perItem + slack`) | 28000 (header value only — LML clamps this to ~4s effective; see BS#1914 below) | dedicated per-job limiter, never `defaultLimiter` | per-item error isolation; retry next cycle     |

Rotation picker's 10 s is a documented BS#992 exception preserved as a per-caller override within class 2, not a new class.

## Caller → class map (the registered table)

| caller label                                                                                                                                                                                                                                                                                 | class             | current constant it replaces                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `proxy-library-search` (catalog `searchLibrary`, currently unlabeled)                                                                                                                                                                                                                        | 1                 | none (hard 30 s today)                                                       |
| `library-track-search`                                                                                                                                                                                                                                                                       | 2                 | `LIBRARY_INTERACTIVE_LML_BUDGET_MS`                                          |
| `library-rotation-picker`                                                                                                                                                                                                                                                                    | 2 (10 s override) | `ROTATION_LML_LOOKUP_TIMEOUT_MS`                                             |
| `proxy-album-metadata`                                                                                                                                                                                                                                                                       | 2                 | `PROXY_LML_BUDGET_MS`                                                        |
| `library-enrich-artwork`                                                                                                                                                                                                                                                                     | 2 (2 s override)  | `LIBRARY_SEARCH_LML_BUDGET_MS` (#1828)                                       |
| `artwork-discogs-fallback`                                                                                                                                                                                                                                                                   | 2                 | none (hard 30 s)                                                             |
| `request-line`                                                                                                                                                                                                                                                                               | 2                 | none (hard 30 s)                                                             |
| `library-add-album` / `library-update-album` (metadata)                                                                                                                                                                                                                                      | 2                 | `LIBRARY_LML_BUDGET_MS`                                                      |
| `library-add-album-streaming` / `library-update-album-streaming` (streaming-check) — **new distinct labels**                                                                                                                                                                                 | 4                 | none today (hard 30 s; `checkStreamingAvailability` takes no budget arg)     |
| `add_to_rotation` (`resolveIdentity`)                                                                                                                                                                                                                                                        | 3                 | client-internal `RESOLVE_IDENTITY_TIMEOUT_MS` (env `LML_RESOLVE_TIMEOUT_MS`) |
| `proxy` release/artist reads (`getRelease`/`getArtistDetails`/`resolveEntity`)                                                                                                                                                                                                               | 3                 | none (hard 30 s)                                                             |
| `library-canonical-entity`                                                                                                                                                                                                                                                                   | 3                 | `LIBRARY_LML_BUDGET_MS` (5 s → class-3 8 s — intended shift, see risks)      |
| `metadata-service` (fire-on-insert)                                                                                                                                                                                                                                                          | 5                 | `METADATA_SERVICE_LML_BUDGET_MS`                                             |
| `flowsheet-linkage`                                                                                                                                                                                                                                                                          | 2                 | (coordinator default)                                                        |
| `enrichment-worker`                                                                                                                                                                                                                                                                          | 5                 | `ENRICHMENT_LML_BUDGET_MS` (has a downstream TTL derivation — see Step 3)    |
| all `jobs/*` (`flowsheet-metadata-backfill`, `album-level-backfill`, `catalog-popularity-freetext-resolve`, `flowsheet-linked-reenrichment`, `flowsheet-artwork-repair`, `flowsheet-reenrichment`, `streaming-url-upgrade`, `apple-music-url-backfill`, `rotation-*-backfill`, `concerts-*`) | 5                 | per-job constants (keep batch-scaled)                                        |

**One label ↔ one class (load-bearing for the `Record`-keyed table).** The policy table is `Record<LmlCaller, Policy>`, so a caller label maps to exactly one class. The library add/update flow issues _two_ parallel LML calls with different criticality — the metadata `lmlLookupCoordinator.lookup(...)` (`library.controller.ts:108/162`, class 2) and `checkStreamingAvailability(...)` (`library.controller.ts:106/831`, class 4) — so they **must carry distinct caller labels** (`library-add-album` vs `library-add-album-streaming`). The `LIBRARY_LML_BUDGET_MS` constant at `library.controller.ts:108/833` today bounds only the metadata `lookup`; the streaming call currently takes no budget and rides the 30 s default.

Ambiguities to confirm at implementation: `proxy-album-metadata` and `flowsheet-linkage` straddle class 2/3 — keep class 2 (live request context, short budget). `proxy-library-search` is currently unlabeled at `proxy.controller.ts:710` and must be given the class-1 label.

## Implementation plan (TDD, per-step)

**Step 1 — Policy module (`shared/lml-client/src/policy.ts`), test-first.**

- `export type LmlCallerClass = 1 | 2 | 3 | 4 | 5` (or named union).
- `export const LML_CALLER_POLICY: Record<LmlCaller, { class, timeoutMs, budgetMs?, limiter?, budgetMsOverride?, fallback }>` — the table above.
- `export function resolveLmlPolicy(caller: LmlCaller): LmlPolicy`.
- `export type LmlCaller = <union of the ~20 registered labels>`.
- **Env-lever preservation is explicit, not blanket.** Class 2 absorbs _three_ distinct env-backed budgets that all default 5000 today (`LIBRARY_LML_BUDGET_MS`, `PROXY_LML_BUDGET_MS`, `LIBRARY_INTERACTIVE_LML_BUDGET_MS`); a single class-2 default can only bind one env name, so the plan **retires** the other two rather than silently dropping them. Preserved as per-caller `budgetMsOverride` env reads (the pattern `library-enrich-artwork`/`LIBRARY_SEARCH_LML_BUDGET_MS` already uses): `LIBRARY_SEARCH_LML_BUDGET_MS` (artwork 2 s), `LML_RESOLVE_TIMEOUT_MS` (class-3 identity). New global knobs: `LML_CLASS{1..5}_TIMEOUT_MS`. The class-2 default binds a new `LML_CLASS2_BUDGET_MS` (5000). `ROTATION_LML_LOOKUP_TIMEOUT_MS` is a **hardcoded** 10 s const (`library.service.ts:609`, no `envInt` today — BS#992 exception); carry it as a code-constant override, not an implied env lever, unless we deliberately add `LML_CLASS2_ROTATION_TIMEOUT_MS`. Every retired env name is listed in `docs/env-vars.md` with its replacement.
- Unit tests: every registered caller resolves to exactly one class; overrides applied; unknown caller throws (or returns a loud default — decide in review).

**Step 2 — Thread policy through the client.** In `lmlFetch`/`postLookup` and each of the 14 methods, compute `const p = resolveLmlPolicy(caller); timeoutMs = opts.timeoutMs ?? p.timeoutMs; budgetMs = opts.budgetMs ?? p.budgetMs; limiter = opts.limiter ?? p.limiter`. Make `caller` **required** (typed `LmlCaller`) on budget-bearing methods. Existing explicit `timeoutMs`/`budgetMs` args keep winning (per-call override) so no behavior changes until call sites are cleaned up.

Methods that take **no options object today** and must be widened to accept `{ caller }` and thread `p.timeoutMs` into their `lmlFetch` AbortController:

- `searchLibrary(params)` (`index.ts:1062`) — currently `lmlFetch(...)` with no timeout; add `{ caller }`, route class-1 3 s timeout. This is the class-1 protected-search path.
- `checkStreamingAvailability(artist, title)` (`index.ts:1036`) — currently `defaultLimiter.run(() => lmlFetch(...))` with no timeout; add `{ caller }`, route class-4 5 s. Keep the `defaultLimiter.run` wrapper.
- The class-3 reads `getRelease` / `getArtistDetails` / `resolveEntity` / `searchTrackReleases` (`index.ts:934-994`) — gain a `caller` param + `p.timeoutMs` threading.

Since these methods don't currently pass a per-call timeout to `lmlFetch`, threading `p.timeoutMs` is a real behavior change (30 s → the class value) — deliberate, and the point of the PRD slice. Keep an env escape hatch per class.

**Step 3 — Migrate call sites, delete the scattered constants.** Replace each `{ budgetMs: SOME_CONSTANT, caller: 'x' }` with `{ caller: 'x' }` (policy supplies budget). Label the currently-unlabeled `searchLibrary` at `proxy.controller.ts:710` as `proxy-library-search` (class 1) — the step that realizes the PRD win: search gets its own short protected budget.

Constants deleted (reconciled with the caller→class table):

- `LIBRARY_LML_BUDGET_MS` (`library.controller.ts:30`) → class 2 (`library-add-album`/`update`) + class 3 (`library-canonical-entity`).
- `PROXY_LML_BUDGET_MS` (`proxy.controller.ts:54`) → class 2.
- `LIBRARY_INTERACTIVE_LML_BUDGET_MS` (`library.service.ts:616`) → class 2.
- `LIBRARY_SEARCH_LML_BUDGET_MS` (`library.service.ts:627`, the #1828 constant) → class-2 `library-enrich-artwork` 2 s override.
- `METADATA_SERVICE_LML_BUDGET_MS` (`metadata.service.ts:37`) → class 5.
- `ROTATION_LML_LOOKUP_TIMEOUT_MS` (`library.service.ts:609`) → class-2 rotation-picker 10 s override.

Two constants that are **client-internal or have downstream coupling** — handle with care, do not blind-delete:

- `RESOLVE_IDENTITY_TIMEOUT_MS` (`index.ts:1121`) reads env **`LML_RESOLVE_TIMEOUT_MS`**, not an env var of its own name. Fold into class-3 identity default but **preserve the `LML_RESOLVE_TIMEOUT_MS` env name** so the ops lever survives.
- `ENRICHMENT_LML_BUDGET_MS` is defined **twice** (`sweep.ts:66`, `lookup-batcher.ts:74`) and `sweep.ts:74` derives `STRANDED_TTL_SECONDS = max(60, ceil(budget/1000)+30)` from it — the stranded-claim reaper TTL must stay ≥ the worker's real LML budget. Do **not** strand that derivation: have `lookup-batcher.ts` pass `caller: 'enrichment-worker'` (policy supplies budget) and have `sweep.ts` compute the TTL from `resolveLmlPolicy('enrichment-worker').budgetMs` instead of a deleted local constant, so budget and TTL keep one source of truth.

**Step 4 — Bypass guard (`scripts/check-lml-caller-classification.mjs`).** Key the guard on the **14 client-method call-expressions** (imported from `@wxyc/lml-client`), _not_ on a `caller:` substring — a call that omits `caller` entirely (e.g. a bare `searchLibrary(params)`) has no `caller:` token to match and would silently pass, defeating the "omits `caller` on a budget-bearing method" half of the acceptance criterion. For each matched call-expression, assert a registered `caller` is present. Fail if the `caller` isn't in `LML_CALLER_POLICY` or is absent on a budget-bearing method. 3-exit-code contract mirroring `check-legacy-entry-id-writes.mjs` (ok / new-unlisted / stale-entry). The required-typed `LmlCaller` union (Step 2) catches `apps/**`+`shared/**` at compile time; this grep is the safety net for `jobs/**` (which typecheck doesn't cover). **Aliased/namespace-import evasion:** a line-based grep won't catch `import { searchLibrary as sl }` or `import * as lml` in `jobs/**` — exactly where the typed union doesn't reach. Mitigate by adding a checked invariant that `jobs/**` must use direct named imports from `@wxyc/lml-client` (flag aliased/namespace imports of the package in `jobs/**` as a guard failure), so the method-name grep is reliable. Wire as a dedicated step in `.github/workflows/test.yml` next to line 192, plus an `npm run check:lml-callers` script.

**Step 5 — Docs.** Update `docs/env-vars.md` (retired constants → class table + new `LML_CLASS*` knobs). Put the "LML caller classes" reference in a **`docs/` topic file** (extend `docs/env-vars.md` or add a short `docs/lml.md`) — **not** in CLAUDE.md, whose Doc-hygiene section says to extract to `docs/` rather than grow the (already at/over budget) reference card. Add only a one-line router pointer in CLAUDE.md's LML section pointing at the topic doc + `policy.ts`.

## Acceptance criteria (from #1826)

- [ ] Single policy layer maps each caller to a class with its own timeout+fallback — Step 1.
- [ ] Every listed call-site family classified; test enumerates them and asserts one class each — Step 1 test.
- [ ] Protected local-search and batch callers do not share a timeout default — Step 3 (class 1 = 3 s vs class 5 = 29 s).
- [ ] A guard fails when a new call site bypasses the policy — Step 4.
- [ ] Cross-linked to #876 and #1819; no duplication of #879 coordinator work — this plan.

## Risks / watch-items

- **Behavior change on the non-`/lookup` reads:** class-3 reads drop from 30 s → 8 s. Verify the PG-cached path (`get_release` read-through, see MEMORY `reference_lml_get_release_readthrough_tiers`) comfortably serves under 8 s for library releases; keep an env escape hatch.
- **`library-canonical-entity` shifts 5 s → 8 s** (was `LIBRARY_LML_BUDGET_MS`, now class-3 read). This is a _loosening_, low-risk; it's a fire-and-forget canonical-entity refresh, not on the response budget.
- **`checkStreamingAvailability` and `searchLibrary` gain a real timeout** where they had the 30 s default. The streaming-check is best-effort (persist-null fallback), so a shorter budget only means more null-then-synthesize; the class-1 search timeout is the protective intent. Confirm no caller currently _relies_ on the 30 s tail for these two.
- **`caller` becoming required** is a typed breaking change to `LookupOptions` — every call site in `apps/**`/`shared/**` must compile; `jobs/**` won't typecheck (repo convention) so the grep guard is the safety net there. Run each job's direct `tsc` per MEMORY `reference_typecheck_scope`.
- **New workspace file, not new workspace** — `policy.ts` is inside the existing `@wxyc/lml-client`, so no `package-lock.json` resync needed (contrast MEMORY `reference_new_workspace_needs_lock_sync`).
- Keep per-call explicit `timeoutMs`/`budgetMs` overrides winning so the migration is mechanical and reversible per call site.

## Suggested PR slicing (≤1000 line target)

Branch: `feature/bs1826-lml-caller-classification` (worktree already created off `origin/main` at the #1828 merge).

- PR 1: Steps 1–2 (policy module + thread through client, `caller` still optional, zero call-site behavior change) + unit tests. Pure addition.
- PR 2: Step 3 (migrate call sites, delete constants, make `caller` required, label search) — the behavior-changing PR.
- PR 3: Step 4–5 (guard + docs).

Chain in that order; PR 2 is the one to watch on deploy (it changes live budgets).

## BS#1914 — the real `X-Caller-Budget-Ms` contract, and the per-class decision

This plan's "Codebase convention: `budgetMs ≈ timeoutMs − 1000`" line (above) and its rationale — "so the LML-side soft cutoff fires before the socket aborts" — describe what the header's _number_ was assumed to mean. That assumption was never checked against LML's actual implementation, and it is false.

**What the header really does.** LML computes its effective search budget as `min(header − 200ms, LML_SEARCH_BUDGET_MS)` (LML `core/search.py`, `resolve_effective_search_budget_ms`). Prod leaves `LML_SEARCH_BUDGET_MS` unset, defaulting to **4000ms**. So the header can only ever _tighten_ LML's budget, never extend it — class 5's 28000ms header clamps down to the same ~4s ceiling as class 2's 4000ms header (→3800ms effective). The header's mere _presence_, not its magnitude, is also what arms LML's empty-state cascade cutoff (LML#345) and enrichment-tail shed (LML#930); a caller sending no header instead grinds on to LML's own hard cap, `LML_SEARCH_HARD_TIMEOUT_MS` (default 25000ms, also unset in prod). Net effect: every class-5 caller has been running a ~4s empty-state cutoff since this plan shipped, not the ~28s this document described.

**Per-class decision, now that the real contract is known** (measured 2026-08-04, see the evidence comment on WXYC/Backend-Service#1914):

- **Class 5, offline drains** (`flowsheet-metadata-backfill`, `album-level-backfill`, `catalog-popularity-freetext-resolve`, `flowsheet-linked-reenrichment`, every `*-backfill` job): **keep sending the header.** The ~4s empty-state fast-degrade is the desired behavior for a bulk drain — a hard-miss row should give up quickly and free the shared Discogs ceiling for the next row. Same 24h window (PostHog): `flowsheet-metadata-backfill` alone ran 49,091 single lookups at a 31% zero-result rate, p95 = 3,972ms — flush against the 4s wall. This is now a deliberate choice, not an inherited accident.
- **Class 5, the live CDC `enrichment-worker`: the 4s cutoff is wrong, and the cost is user-visible.** This worker enriches new rotation arrivals — albums in neither `library.db` nor the library-filtered Discogs cache — whose cold non-library release resolution measures 4–20s on prod. A replay of one day's 41 rotation-linked no-match playcuts, headerless, recovered 24 (59%) as full Discogs matches with artwork; a controlled A/B on 4 previously-unprobed rows sheded 4/4 with the header present. Worse, the shed still pays the Discogs bill — LML resolves the release and _then_ discards the answer (WXYC/library-metadata-lookup#1112) — and a no-match shell row doesn't block a retry, so the same albums recur across digests, re-paying the same cost each time. This caller is the intended first consumer of the `budgetMs: null` suppression lever `@wxyc/lml-client` adds in BS#1914 — flipping it is WXYC/Backend-Service#1978 (blocked by BS#1914, ships behind its own default-off flag), **not** done as part of this plan or BS#1914 itself. WXYC/Backend-Service#1977 (independent) stops recording a deadline shed as a terminal no-match; WXYC/Backend-Service#1979 is the one-shot drain for rows already frozen by this gap.
- **Class 2: no change for this correction**, with one pre-existing exception filed separately. The header value (4000) is close to the effective budget (3800), so the false model was only mildly wrong here — but `library-rotation-picker`'s per-caller override sets a budget unconditionally, while `library.service.ts` documents at length that this call site intentionally sends NO budget companion because a 4s cap collapsed its coverage. Under the corrected model the override re-imposes that cap. This is pre-existing (BS#1826, not this correction) and is tracked at WXYC/Backend-Service#1983 — not fixed here.

**Raising the ceiling is a different lever.** `LML_SEARCH_BUDGET_MS` (global, LML-side) is the only way to raise the effective budget fleet-wide; it is tracked at WXYC/library-metadata-lookup#1111 (itself past its own stated expiry — its docstring says to revisit once BS#876 lands, and BS#876 is closed). BS#1914 and this plan correction do not touch it, and do not change which BS callers emit the header today.
