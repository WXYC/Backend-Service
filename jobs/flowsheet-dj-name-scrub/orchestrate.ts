/**
 * BS#2281 — scrub historical `flowsheet.dj_name` (and the marker `message`
 * text that embeds it) to the current PII-safe resolution policy.
 *
 * `flowsheet.dj_name` is a denormalized snapshot written at play time. Rows
 * written under superseded policies still hold DJ real names, and every
 * public flowsheet endpoint serves the column raw — including
 * `GET /flowsheet/search`, which additionally makes it *matchable*
 * (`buildDjNameMatch` ILIKEs the column, and `search_doc` carries it at
 * weight B). Two cohorts are in scope:
 *
 *   - **A — the `auth_user.name` era.** Between `a0cd1979` (2025-12-30) and
 *     `2a37bbc6` (2026-06-08 21:05 PDT) every writer fell back to better-auth
 *     `name`, which dj-site admin provisioning fills with the DJ's real name.
 *   - **B — the tubafrenzy `DJ_NAME` era.** The 2026-04-27 backfill
 *     (migration 0053) froze `COALESCE(u.dj_name, s.legacy_dj_name, u.name)`
 *     onto ~2.6M rows while `legacy_dj_name` held `DJ_NAME` (the full real
 *     name) rather than `DJ_HANDLE`.
 *
 * Cohort C — real names DJs themselves typed into tubafrenzy's free-text
 * `DJ_HANDLE` — is deliberately OUT of scope. It is a policy question, not a
 * correctness bug. Sampling will still show name-shaped residue after this
 * job; that is expected, not a failure.
 *
 * ## No separate reindex
 *
 * `flowsheet.search_doc` is a `STORED GENERATED` tsvector over an expression
 * containing `dj_name` (`schema.ts:1295`), so this job's UPDATE recomputes it
 * per row. Migration 0054 relies on exactly this. There is no second step.
 *
 * ## Why `IS DISTINCT FROM`, never `IS NULL`
 *
 * `jobs/legacy-dj-name-remediation` (BS#1393) tried to clean this up and
 * under-remediated twice over. Its live UPDATE was scoped `dj_name IS NULL`,
 * so **a row already holding a polluted value was never corrected** — its
 * reported "124,031 marker rows re-resolved" counts rows filled from NULL,
 * not rows cleaned. (Its dry-run preview counted the wider `IS NULL OR
 * trim(dj_name) = trim(s.legacy_dj_name)` and its doc comment claimed the two
 * matched; they did not.) And all four of its query sites filtered
 * `entry_type IN ('show_start','show_end','dj_join','dj_leave')` while
 * `GET /flowsheet/search` serves `entry_type = 'track'` — the remediated set
 * and the searchable set are disjoint.
 *
 * Idempotency here therefore comes from comparing against the RECOMPUTED
 * value, never from `IS NULL`.
 *
 * ## Why the expected value is computed in TypeScript, not re-derived in SQL
 *
 * `shared/database/src/dj-name.ts:1-13` records why the canonical helpers
 * were extracted: "so `jobs/` writers can apply the identical chain instead
 * of re-deriving it in SQL. That re-derivation is exactly what went wrong."
 * A scrub whose whole purpose is removing a divergence between a helper and
 * stored data must not reintroduce that divergence in its own
 * implementation. So this job pages rows out, computes the expected value
 * in-process with `resolveShowDjName` / `resolveDjDisplayName` /
 * `showDjNameOverride` imported from `@wxyc/database`, and writes back only
 * the rows that differ. Parity is by construction — there is no second copy
 * of the chain that could drift. Same in-process shape as
 * `jobs/flowsheet-april-gap-import` and `jobs/flowsheet-ghost-row-sweep`.
 *
 * ## Three passes, three cursors
 *
 * Each pass drains independently by id cursor and reports its own counts:
 *
 *   1. **main** (`DJ_NAME_SCRUB_FLOWSHEET_AFTER_ID`) — every in-scope row
 *      reachable through a `shows` join. Recomputes `dj_name`.
 *   2. **message** (`DJ_NAME_SCRUB_MESSAGE_AFTER_ID`) — the four marker types
 *      whose `message` text embeds the resolved name.
 *   3. **orphan** (`DJ_NAME_SCRUB_ORPHAN_AFTER_ID`) — `show_id IS NULL` rows,
 *      plus rows whose `show_id` is set but DANGLING (no matching `shows`
 *      row — see `loadOrphanPage`). Both shapes are invisible to the `shows`
 *      join and therefore have nothing to recompute from. PII removal only.
 *
 * The cost of separating them is two extra read-only PK walks of the table;
 * the benefit is that the one pass writing client-facing prose is separately
 * resumable, separately counted, and separately reviewable.
 *
 * ## Two live writers still re-derive the chain in SQL
 *
 * `jobs/flowsheet-etl/job.ts:121` and `apps/backend/routes/internal.route.ts:195`
 * both `SET dj_name = COALESCE(u.dj_name, s.legacy_dj_name)`. Both predate
 * `dj_name_override` (BS#1321) and omit the literal-"Anonymous" filter
 * (BS#1286), so both can write values the canonical helper would not
 * produce. Neither is a scrub target, but they bound what this job can
 * promise: `verifyComplete` is capped at the drain's high-water mark so a
 * row one of them touches after the drain passed it cannot fail
 * verification nondeterministically. Converting them is the durable fix and
 * is tracked separately — divergence regrows at the rate they run.
 *
 * ## Blast radius
 *
 * `flowsheet` is the live on-air table. Per `docs/bulk-update-playbook.md`
 * the per-row cost is a heap rewrite + `search_doc` regeneration + ~7 index
 * updates (the playbook's list predates migration 0084's
 * `flowsheet_updated_at_idx`) + a WAL full-page image + a CDC `pg_notify`
 * carrying full-row JSON. Cooperative live-DJ pause (BS#2009), SIGTERM
 * graceful stop, and `ANALYZE`-after (BS#934) are all wired below.
 *
 * `updated_at` is deliberately never written: migration 0084's BEFORE UPDATE
 * trigger `bump_flowsheet_updated_at` owns that column (`0084:81-83`).
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  buildWaitForQuietPeriod,
  checkLiveActivity as defaultCheckLiveActivity,
  requireNonNegativeInt,
  requirePositiveInt,
  resolveDjDisplayName,
  resolveShowDjName,
  showDjNameOverride,
  resolveLiveActivityMaxPauseMs as resolveLiveActivityMaxPauseMsShared,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'flowsheet-dj-name-scrub';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const SHOWS_TABLE = sql.raw(`"${SCHEMA}"."shows"`);

/** Page size for every pass. Mirrors the bulk-update playbook default. */
export const BATCH_SIZE_DEFAULT = 5000;
export const UPDATE_TIMEOUT_MS_DEFAULT = 300_000;
export const ANALYZE_TIMEOUT_MS_DEFAULT = 300_000;
/** How many changed ids each pass carries in its summary. */
export const SAMPLE_SIZE_DEFAULT = 20;

/** Row ids retained per change class, for spot-checking. Ids only, never values. */
export const CHANGE_CLASS_SAMPLE_SIZE = 5;

const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000];

export type FlowsheetEntryType =
  'track' | 'show_start' | 'show_end' | 'dj_join' | 'dj_leave' | 'talkset' | 'breakpoint' | 'message';

/**
 * Entry types whose `dj_name` is recomputed from the shows join.
 *
 * `show_start` is in this list but is SPLIT by provenance inside
 * `recomputeDjName` — see the comment there. `dj_join` / `dj_leave` are
 * deliberately absent: the joining guest's identity is not recoverable from
 * `shows`, so a shows-join recompute would overwrite a correct guest handle
 * with the PRIMARY DJ's name and leave `dj_name` contradicting the row's own
 * `message` text. Both traps are already documented at
 * `jobs/flowsheet-dj-name-backfill/job.ts:22-26`.
 */
export const RECOMPUTED_ENTRY_TYPES = ['track', 'show_start', 'show_end'] as const;

/**
 * Entry types that get the PII-removal probe only — never a recompute.
 *
 * Restoring correct attribution for these is out of scope; removing PII is
 * not. The exact-equality rule is sound for this cohort precisely because
 * these values originated in `auth_user`, and it can never write a WRONG
 * name — only remove one. Attribution loss is accepted and counted.
 */
export const PII_NULL_ONLY_ENTRY_TYPES = ['dj_join', 'dj_leave'] as const;

/**
 * Entry types this job NEVER writes to, under any pass.
 *
 * These are deliberately NULL — they are not attributed to a specific DJ.
 * Under a bare `IS DISTINCT FROM <shows chain>` every one of them becomes a
 * candidate and gets newly POPULATED: a PII scrub that invents DJ names on
 * rows that never had one. That is the single most dangerous failure mode in
 * this job, which is why the exclusion is a named constant with its own
 * tests in both tiers rather than an implicit consequence of a WHERE clause.
 */
export const EXCLUDED_ENTRY_TYPES = ['talkset', 'breakpoint', 'message'] as const;

/** The union the two row-loading passes select. */
export const IN_SCOPE_ENTRY_TYPES: readonly FlowsheetEntryType[] = [
  ...RECOMPUTED_ENTRY_TYPES,
  ...PII_NULL_ONLY_ENTRY_TYPES,
];

/** The four marker types whose `message` text embeds the resolved DJ name. */
export const MESSAGE_ENTRY_TYPES = ['show_start', 'show_end', 'dj_join', 'dj_leave'] as const;

const sqlEntryTypeList = (types: readonly string[]) => sql.raw(types.map((t) => `'${t}'`).join(', '));

/**
 * One flowsheet row plus the show / user columns the canonical chain needs.
 *
 * `user_found` is NOT derivable from `user_dj_name`: `resolveShowDjName`
 * treats "no user row at all" and "a user row whose handle is unusable" as
 * DIFFERENT branches — the first returns `legacy_dj_name` UNTRIMMED, the
 * second returns it TRIMMED. That asymmetry is preserved verbatim from the
 * pre-extraction behaviour so a refactor cannot change a single byte on the
 * existing wire, and this job must not "tidy" it either.
 */
export type ScrubRow = {
  id: number;
  entry_type: FlowsheetEntryType;
  dj_name: string | null;
  message: string | null;
  show_id: number | null;
  dj_name_override: string | null;
  legacy_dj_name: string | null;
  primary_dj_id: string | null;
  user_found: boolean;
  user_dj_name: string | null;
};

export type SkipReason = 'entry_type_excluded' | 'already_current' | 'not_pii';
export type WriteReason = 'recomputed' | 'recomputed_show_start_live' | 'recomputed_show_start_legacy' | 'pii_nulled';

export type ScrubDecision =
  { action: 'skip'; reason: SkipReason } | { action: 'write'; djName: string | null; reason: WriteReason };

/**
 * Build the set of `auth_user.name` values that must never appear as a served
 * `dj_name`.
 *
 * A DJ whose on-air handle legitimately IS their real name is EXEMPT — the
 * canonical chain returns that handle unchanged, so without the exemption
 * this job would erase a handle they chose and the regression guard would
 * trip permanently for them. That is the "where that user's `dj_name` IS
 * DISTINCT FROM their `name`" clause, evaluated here on the resolved handle
 * (`resolveDjDisplayName`, which trims and nulls the literal 'Anonymous')
 * against the trimmed real name, so whitespace variance cannot defeat it.
 *
 * Comparison is on TRIMMED values because the two writer families stored the
 * real name differently: the TypeScript path stored `trim(auth_user.name)`
 * (the pre-`2a37bbc6` `resolveDjDisplayName` returned `name.trim()`), while
 * the SQL `COALESCE` writers stored it untrimmed. Both forms must be caught.
 *
 * Built in process rather than probed in SQL. An earlier design used an
 * `EXISTS (... u.name = f.dj_name ...)` subquery on the premise that
 * `auth_user` carries trigram indexes on `name`/`dj_name`. It does not:
 * those were created in migration 0051 and dropped three times over
 * (`0054:64-65`, `0065:57-58`, `0095:18-19`), and `schema.ts:71-74` records
 * the dropped state. `auth_user` is a station DJ roster — small enough that
 * an in-process `Set` is trivially cheap, and it makes every pass in this
 * job use the same mechanism.
 *
 * Collision note: if two DIFFERENT users share a real name and only one of
 * them uses it as their handle, the name IS indexed — one user's exemption
 * does not shield the other's leaked snapshot. The tie resolves toward
 * removal, deterministically and regardless of iteration order.
 */
export const buildPiiNameIndex = (
  users: ReadonlyArray<{ name: string | null; djName: string | null }>
): Set<string> => {
  const index = new Set<string>();
  for (const user of users) {
    const realName = user.name?.trim() ?? '';
    if (realName.length === 0) continue;
    if (resolveDjDisplayName(user.djName) === realName) continue;
    index.add(realName);
  }
  return index;
};

/**
 * The expected `dj_name` for a row, per the writer that produces its entry
 * type. There is no single "current chain" — each entry type is reconciled
 * against its own writer.
 */
const recomputeDjName = (row: ScrubRow): { djName: string | null; reason: WriteReason } => {
  // `show_start` split by provenance. This is load-bearing, not a
  // refinement. `startShow` (`flowsheet.service.ts:1022`) resolves
  // `effective_override ?? resolveDjDisplayName(dj_info.djName)` and has NO
  // legacy fallback — `legacy_dj_name` is not an input. Applying that chain
  // to the LEGACY cohort (`primary_dj_id IS NULL`, written by
  // `jobs/flowsheet-etl` from tubafrenzy codes 1 and 9) resolves null for
  // every one of them, because those shows have no user row to read — wiping
  // the `legacy_dj_name` migration 0053 wrote. `flowsheet.service.ts:1219-1222`
  // documents that precise outcome as the bug BS#2068 fixed on `show_end`
  // three weeks earlier: "the old form resolved `null` for the ENTIRE legacy
  // cohort (2,813 of production's 2,814 open shows on 2026-08-21)". An
  // unsplit recompute re-introduces it on the opening marker.
  if (row.entry_type === 'show_start' && row.primary_dj_id !== null) {
    return {
      djName:
        showDjNameOverride(row.dj_name_override) ?? resolveDjDisplayName(row.user_found ? row.user_dj_name : null),
      reason: 'recomputed_show_start_live',
    };
  }

  // `track` and `show_end` both resolve through the shared shows chain
  // (`resolveDjNameForShow` -> `resolveShowDjName`), as does the legacy
  // `show_start` cohort.
  const djName = resolveShowDjName({
    dj_name_override: row.dj_name_override,
    legacy_dj_name: row.legacy_dj_name,
    primary_dj_id: row.primary_dj_id,
    user: row.user_found ? { djName: row.user_dj_name } : null,
  });
  return {
    djName,
    reason: row.entry_type === 'show_start' ? 'recomputed_show_start_legacy' : 'recomputed',
  };
};

/**
 * Why a would-be write differs from what is stored — diagnostic only.
 *
 * The first prod dry run reported 1,826,070 track rows differing from the
 * canonical value: 86.7% of everything scanned. That is consistent with cohort
 * B — BS#1393 rewrote `shows.legacy_dj_name` from `DJ_NAME` to `DJ_HANDLE` and
 * then only re-resolved marker rows with a NULL `dj_name`, leaving every track
 * row on those shows holding the old real name — but "consistent with" is a
 * story, not evidence, and 1.8M rows on the live on-air table deserves better
 * than a story.
 *
 * This classifies each would-be write so the aggregate carries provenance:
 * how much is genuine real-name removal, how much is cosmetic churn nobody
 * asked for, and how much is neither. It gates nothing and changes no
 * decision — `decideDjName` is untouched — so it cannot alter what the live
 * run does.
 *
 * ## `stored_is_roster_real_name` under-counts by construction
 *
 * That class is keyed on `buildPiiNameIndex`, which is built SOLELY from
 * `auth_user`. The largest affected cohort is legacy shows with
 * `primary_dj_id IS NULL` — there is no `auth_user` row for them at all, by
 * definition. `resolveShowDjName` falls through to `legacy_dj_name` for
 * exactly those rows, so when that value is the pre-BS#1393 tubafrenzy
 * `DJ_NAME`, the real name lives ONLY in `shows.legacy_dj_name` — a column
 * this probe never reads. That is not a corner case. It is the precise blind
 * spot that made BS#1393's own post-run verification report an empty residue
 * class: the check that looked for remaining real names could not see the
 * cohort holding almost all of them. Reading `stored_is_roster_real_name`
 * alone as "how much of this run is PII removal" repeats that mistake.
 *
 * `stored_is_superseded_legacy_name` closes the blind spot without a new
 * query: the row already carries `legacy_dj_name` (it is joined in for the
 * recompute), so a stored value that differs from a recompute whose WINNING
 * ARM returned `legacy_dj_name` verbatim is, by construction, the cohort-B
 * shape — a pre-scrub value now superseded by the legacy handle the
 * resolution chain returns. It ranks BELOW `stored_is_roster_real_name` (a
 * CONFIRMED roster real name, cross-checked against `auth_user`, is stronger
 * evidence than an inferred one) but ABOVE every class that follows,
 * including the cosmetic ones and `other_value_change`.
 *
 * Read together, not the first alone:
 *
 *   - `stored_is_roster_real_name` PLUS `stored_is_superseded_legacy_name`
 *     are the PII-removal evidence, together. If their SUM is not the
 *     dominant class, the premise needs re-examining before anything is
 *     written — see the under-counting note above for why the first class
 *     alone is not that check.
 *   - `recomputed_null_non_pii` should be near zero. A non-trivial count
 *     means the job is erasing handles it cannot justify as PII removal —
 *     attribution loss with no privacy benefit.
 *
 * `recomputed_is_roster_real_name` is a different kind of signal: it is not
 * about what a write REMOVES, it is about what a write would ITSELF WRITE —
 * a stored-clean row whose recompute lands on a roster real name, most
 * likely via a `dj_name_override` or a (post-scrub-trusted) `legacy_dj_name`
 * that itself holds one — Cohort C, out of scope for this job to fix. See
 * `runScrub`'s loud warning wired off it (BS#2281 review finding 2): counted
 * and reported, never a hard failure, because this job has no in-scope way
 * to correct its own recompute inputs.
 *
 * Order is priority, not convenience:
 *   1. `stored_null` — nothing is being removed, a plain gap fill.
 *   2. `recomputed_is_roster_real_name` — ranks ABOVE `stored_is_roster_real_name`
 *      on purpose: writing PII in is a more urgent signal than removing PII,
 *      and an operator scanning the summary must not have it hidden under a
 *      class that reads as success.
 *   3. `stored_is_roster_real_name` — the confirmed case this job exists for.
 *   4. `stored_is_superseded_legacy_name` — the inferred cohort-B case, below
 *      the confirmed case but above everything that follows.
 *   5. `recomputed_null_non_pii`, `whitespace_only`, `case_only`,
 *      `other_value_change` — unchanged from before.
 */
export type ChangeClass =
  | 'stored_null'
  | 'recomputed_is_roster_real_name'
  | 'stored_is_roster_real_name'
  | 'stored_is_superseded_legacy_name'
  | 'recomputed_null_non_pii'
  | 'whitespace_only'
  | 'case_only'
  | 'other_value_change';

export const classifyChange = (
  row: Pick<ScrubRow, 'dj_name' | 'legacy_dj_name'>,
  recomputed: string | null,
  piiNames: ReadonlySet<string>
): ChangeClass => {
  const stored = row.dj_name;
  if (stored === null) return 'stored_null';

  // Ranked above stored_is_roster_real_name — see the docstring above for why
  // writing PII in outranks removing PII as a signal an operator must see.
  if (recomputed !== null && piiNames.has(recomputed.trim())) return 'recomputed_is_roster_real_name';

  const trimmedStored = stored.trim();
  // Trimmed, because the two writer families stored the real name
  // differently: the TypeScript path stored `trim(auth_user.name)`, the SQL
  // COALESCE writers stored it untrimmed.
  if (piiNames.has(trimmedStored)) return 'stored_is_roster_real_name';

  // The cohort-B signature: the row already carries `legacy_dj_name`, so a
  // recompute whose winning arm returned it VERBATIM (see resolveShowDjName's
  // two legacy-return branches) against a stored value that differs is, by
  // construction, cohort B — closing the blind spot the docstring above
  // describes, without a second query.
  if (recomputed !== null && recomputed === row.legacy_dj_name && stored !== recomputed) {
    return 'stored_is_superseded_legacy_name';
  }

  if (recomputed === null) return 'recomputed_null_non_pii';

  const trimmedRecomputed = recomputed.trim();
  if (trimmedStored === trimmedRecomputed) return 'whitespace_only';
  if (trimmedStored.toLowerCase() === trimmedRecomputed.toLowerCase()) return 'case_only';
  return 'other_value_change';
};

/**
 * The single decision path, shared by dry-run and live and by all three
 * passes. BS#1393's dry-run and live predicates diverged while its doc
 * comment claimed they matched; one function, asserted by test, is the fix.
 */
export const decideDjName = (row: ScrubRow, piiNames: ReadonlySet<string>): ScrubDecision => {
  if ((EXCLUDED_ENTRY_TYPES as readonly string[]).includes(row.entry_type)) {
    return { action: 'skip', reason: 'entry_type_excluded' };
  }

  // Orphans (`show_id IS NULL`, or dangling) have no shows join, so there is
  // nothing to recompute from — they get the same PII-removal probe as the
  // guest-DJ markers. `flowsheet` has no user FK (only `show_id`), so "that
  // user" does not exist for these rows and the rule has to be stated as
  // membership in the index rather than as a per-row comparison.
  //
  // Known limit (BS#2281 review finding 6, NOT widened here — that would be
  // Cohort C): this exact-equality probe is sound for `dj_join`/`dj_leave`
  // because those values provably came from `auth_user`. For orphans it is
  // not — `schema.ts:1084` describes `show_id IS NULL` rows as pre-dating
  // `shows` entirely, i.e. the legacy cohort: the population LEAST likely to
  // have an `auth_user` row and MOST likely to hold a bare tubafrenzy real
  // name the index can never contain. So this pass will likely find almost
  // nothing on exactly the rows most likely to be polluted. Read
  // `orphan.scanned` vs `orphan.changed` in the run summary accordingly — a
  // near-zero `changed` on a non-trivial `scanned` is the probe finding
  // nothing, not evidence the orphan cohort is clean. See the README's
  // Cohort C caveat, which this sits beside.
  const piiOnly = row.show_id === null || (PII_NULL_ONLY_ENTRY_TYPES as readonly string[]).includes(row.entry_type);
  if (piiOnly) {
    const stored = row.dj_name?.trim() ?? '';
    if (stored.length > 0 && piiNames.has(stored)) {
      return { action: 'write', djName: null, reason: 'pii_nulled' };
    }
    return { action: 'skip', reason: 'not_pii' };
  }

  const { djName, reason } = recomputeDjName(row);
  // `IS DISTINCT FROM` semantics: null-vs-null is "same", so an already-clean
  // row is skipped rather than rewritten.
  if (djName === row.dj_name) return { action: 'skip', reason: 'already_current' };
  return { action: 'write', djName, reason };
};

/**
 * The four marker message templates, their name capture group, and the
 * wording each degrades to.
 *
 * Anchored on the writers' own templates rather than substring-matched
 * against `auth_user`. A naive "message contains a string equal to some
 * `auth_user.name`" is rows x |auth_user| comparisons per batch against a
 * table with no index on `name` at all. Instead the candidate name is
 * extracted POSITIONALLY and compared once, with exact equality — the same
 * cheap probe every other pass uses. A message that does not match a known
 * template is left alone rather than guessed at.
 *
 * The timestamp tail is matched strictly (`toLocaleString('en-US', { timeZone:
 * 'America/New_York' })`) so a DJ name containing the literal separator text
 * cannot shift the capture. `\s` before AM/PM covers both the ASCII space
 * older ICU emitted and the U+202F narrow no-break space newer ICU emits —
 * both forms are in the stored corpus.
 */
const LOCALE_TS = String.raw`\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s(?:AM|PM)`;

type MessageTemplate = {
  pattern: RegExp;
  /** Rebuild the degraded message from the regex match. */
  degrade: (match: RegExpMatchArray) => string;
};

const MESSAGE_TEMPLATES: Record<(typeof MESSAGE_ENTRY_TYPES)[number], MessageTemplate> = {
  // `startShow` already emits this exact degraded wording when the name is
  // unresolvable (`flowsheet.service.ts:1031`), so no new shape enters the
  // corpus.
  show_start: {
    pattern: new RegExp(String.raw`^Start of Show: (.+) joined the set at (${LOCALE_TS})$`),
    degrade: (m) => `Start of show: ${m[2]}`,
  },
  // Symmetrically, `endShow` emits this when the name is unresolvable
  // (`flowsheet.service.ts:1232`). `show_end` was missed in an earlier draft:
  // `endShow` was one of the four writers carrying the `name` fallback that
  // `2a37bbc6` removed, and its template dates to `6a08a9a2` (2026-01-21),
  // inside the Cohort A window.
  show_end: {
    pattern: new RegExp(String.raw`^End of Show: (.+) left the set at (${LOCALE_TS})$`),
    degrade: (m) => `End of show: ${m[2]}`,
  },
  // `dj_join` / `dj_leave` have NO degraded form of their own — those writers
  // SUPPRESS the row entirely rather than degrade it, so any rewrite here is
  // by definition a new message shape in the stored corpus. Deleting the rows
  // is not on the table: they are real events. The wording chosen matches the
  // generic fallback a public consumer already renders for a null `dj_name`
  // (WXYC/website `lib/flowsheetRange.js:320-326`, `describeNonTrackEntry`:
  // ``entry.dj_name ? `${entry.dj_name} joined` : 'DJ joined'``), so it is new
  // to the corpus but not new to what THAT reader sees. Scope that claim
  // honestly: it is verified for the website only. The iOS and Android
  // clients render their own fallbacks and were NOT checked.
  dj_join: {
    pattern: /^(.+) joined the set!$/,
    degrade: () => 'DJ joined the set!',
  },
  dj_leave: {
    pattern: /^(.+) left the set!$/,
    degrade: () => 'DJ left the set!',
  },
};

export type MessageDecision = { action: 'skip'; reason: string } | { action: 'write'; message: string };

/**
 * Decide whether a marker row's `message` embeds a real name, and if so what
 * it should say instead.
 *
 * Note what this deliberately does NOT do: it does not re-render the message
 * around a name the main pass changed for a NON-PII reason (a per-show
 * override added after the fact, say). That is a consistency nit, not a
 * privacy defect, and rewriting client-facing prose on rows that carry no PII
 * is a wider blast radius than this job is chartered for.
 */
export const rewriteMessage = (
  entryType: FlowsheetEntryType,
  message: string | null,
  piiNames: ReadonlySet<string>
): MessageDecision => {
  if (message === null) return { action: 'skip', reason: 'no_message' };
  const template = MESSAGE_TEMPLATES[entryType as (typeof MESSAGE_ENTRY_TYPES)[number]];
  if (!template) return { action: 'skip', reason: 'entry_type_has_no_template' };

  const match = message.match(template.pattern);
  if (!match) return { action: 'skip', reason: 'no_template_match' };

  const embedded = match[1].trim();
  if (!piiNames.has(embedded)) return { action: 'skip', reason: 'not_pii' };

  const rewritten = template.degrade(match);
  if (rewritten === message) return { action: 'skip', reason: 'already_current' };
  return { action: 'write', message: rewritten };
};

// ---------------------------------------------------------------------------
// Database layer
// ---------------------------------------------------------------------------

/** One resolved `dj_name` write: the new value plus the value this run READ. */
export interface DjNameFix {
  id: number;
  djName: string | null;
  oldDjName: string | null;
}

/** One resolved `message` write, same compare-and-set shape. */
export interface MessageFix {
  id: number;
  message: string;
  oldMessage: string | null;
}

/** The narrow row the message pass needs — no shows join, no user join. */
export type MessageRow = {
  id: number;
  entry_type: FlowsheetEntryType;
  message: string | null;
};

export type LoadUsersFn = () => Promise<Array<{ name: string | null; djName: string | null }>>;
export type LoadScrubPageFn = (afterId: number, batchSize: number, maxId?: number) => Promise<ScrubRow[]>;
export type LoadMessagePageFn = (afterId: number, batchSize: number, maxId?: number) => Promise<MessageRow[]>;
export type ApplyDjNameBatchFn = (fixes: DjNameFix[], updateTimeoutMs: number) => Promise<number>;
export type ApplyMessageBatchFn = (fixes: MessageFix[], updateTimeoutMs: number) => Promise<number>;
export type AnalyzeFn = (analyzeTimeoutMs: number) => Promise<void>;
export type VerifyFn = (opts: {
  highWaterMark: number;
  piiNames: ReadonlySet<string>;
  batchSize: number;
}) => Promise<number>;

/**
 * The DJ roster, loaded once at startup. `auth_user` is a station roster, not
 * a user table at internet scale — see `buildPiiNameIndex` for why this is a
 * `Map` in process rather than a SQL `EXISTS` probe.
 */
export const loadUsers: LoadUsersFn = async () => {
  const rows = (await db.execute(sql`SELECT "name", "dj_name" FROM "auth_user"`)) as unknown as Array<{
    name: string | null;
    dj_name: string | null;
  }>;
  return rows.map((row) => ({ name: row.name, djName: row.dj_name }));
};

export type LoadShowsLegacyDjNameFn = () => Promise<Array<{ id: number; legacy_dj_name: string | null }>>;

/**
 * Every non-null `shows.legacy_dj_name`, loaded once at startup for the
 * pre-flight PII scan below (BS#2281 review finding 3). `shows` is one row
 * per broadcast, not one per track — small enough that, like `loadUsers`,
 * this is a single unpaged query rather than a paged drain.
 */
export const loadShowsLegacyDjNames: LoadShowsLegacyDjNameFn = async () => {
  const rows = (await db.execute(
    sql`SELECT "id", "legacy_dj_name" FROM ${SHOWS_TABLE} WHERE "legacy_dj_name" IS NOT NULL`
  )) as unknown as Array<{ id: number; legacy_dj_name: string | null }>;
  return rows;
};

/**
 * Count of `shows.legacy_dj_name` values that are themselves roster real
 * names.
 *
 * This job's recompute TRUSTS `legacy_dj_name` to already be clean —
 * `resolveShowDjName` reads it as a direct chain input with no PII check of
 * its own, unlike `dj_name` and `message`, which this job probes explicitly.
 * That trust rests on BS#1393 having rewritten the column from tubafrenzy
 * `DJ_NAME` (real name) to `DJ_HANDLE` (on-air handle) — plausible, but
 * asserted rather than verified anywhere until this check. If it is wrong
 * for any subset of shows, this job actively WRITES real names onto every
 * in-scope row of those shows, because the polluted value flows straight
 * through the chain into `dj_name`.
 *
 * Pure so it is unit-testable without a database; see `runScrub` for where
 * this is wired to a startup pre-flight that runs in BOTH dry-run and
 * execute mode, before the first pass.
 */
export const countPollutedLegacyDjNames = (
  shows: ReadonlyArray<{ legacy_dj_name: string | null }>,
  piiNames: ReadonlySet<string>
): number => {
  let count = 0;
  for (const show of shows) {
    const trimmed = show.legacy_dj_name?.trim() ?? '';
    if (trimmed.length > 0 && piiNames.has(trimmed)) count += 1;
  }
  return count;
};

const upperBound = (maxId?: number) => (maxId === undefined ? sql`` : sql` AND f."id" <= ${maxId}`);

/**
 * One page of in-scope rows reachable through a `shows` join, with the two
 * join columns the canonical chain reads.
 *
 * `u."id" IS NOT NULL` is selected explicitly rather than inferred from
 * `user_dj_name`: "no user row" and "a user row whose handle is unusable" are
 * different branches of `resolveShowDjName` with different trimming, and
 * collapsing them would change bytes on the wire.
 */
export const loadMainPage: LoadScrubPageFn = async (afterId, batchSize, maxId) => {
  const rows = (await db.execute(sql`
    SELECT f."id", f."entry_type", f."dj_name", f."message", f."show_id",
           s."dj_name_override", s."legacy_dj_name", s."primary_dj_id",
           (u."id" IS NOT NULL) AS "user_found", u."dj_name" AS "user_dj_name"
      FROM ${FLOWSHEET_TABLE} AS f
      JOIN ${SHOWS_TABLE} AS s ON s."id" = f."show_id"
      LEFT JOIN "auth_user" AS u ON u."id" = s."primary_dj_id"
     WHERE f."id" > ${afterId}${upperBound(maxId)}
       AND f."entry_type" IN (${sqlEntryTypeList(IN_SCOPE_ENTRY_TYPES)})
     ORDER BY f."id"
     LIMIT ${batchSize}
  `)) as unknown as Array<Omit<ScrubRow, 'user_found'> & { user_found: boolean }>;
  return rows.map((row) => ({ ...row, user_found: Boolean(row.user_found) }));
};

/**
 * One page of orphan rows: `show_id IS NULL`, OR `show_id` is set but
 * DANGLING (no matching `shows` row).
 *
 * The `shows` join in `loadMainPage` cannot see either shape at all, which is
 * why they need their own pass rather than a wider predicate on that join.
 * Scoped `dj_name IS NOT NULL` because the only action available for an
 * orphan is REMOVING a name — there is nothing to recompute one from.
 *
 * The dangling case is real, not defensive caution:
 * `flowsheet_show_id_shows_id_fk` was dropped and re-added `NOT VALID` in
 * migration 0097, which documents `ALTER TABLE ... VALIDATE CONSTRAINT` as
 * an out-of-band operator step that may never have run. A `NOT VALID` FK
 * enforces every NEW write but never retroactively checks rows that predate
 * it, so a pre-0097 row whose `show_id` no longer resolves is invisible to
 * `loadMainPage`'s INNER JOIN, was invisible to the OLD `show_id IS NULL`
 * orphan predicate, and was therefore invisible to `verifyScrub` too (it
 * reuses these same two loaders) — the row could never be scrubbed AND the
 * run would still report clean. Population is very likely zero — 0097's own
 * comment argues the pre-existing `NO ACTION` FK already kept this
 * consistent — but "very likely zero and structurally unverifiable" is
 * precisely the failure shape this job exists to not repeat from BS#1393.
 *
 * Plan safety: the `NOT EXISTS` anti-join is a correlated subquery keyed on
 * `shows."id"`, the primary key. `EXPLAIN (ANALYZE, BUFFERS)` against a
 * 20k-row `flowsheet` with 2 orphans and a `shows`-side index confirms the
 * expected shape: an `Index Scan` on the `flowsheet` id PK, with the
 * `shows` side planned as `hashed SubPlan` — Postgres materializes the small
 * `shows` table into an in-memory hash ONCE and does an O(1) hash probe per
 * candidate row, rather than a per-row index lookup or (worse) a Hash Anti
 * Join that would force materializing a large slice of `flowsheet` before
 * `LIMIT` can apply. The plan is identical in shape to the plain
 * `show_id IS NULL` predicate it replaces. What that measurement does NOT
 * change: when the orphan+dangling cohort is sparse relative to the table
 * (the expected production shape), a page still has to scan through the
 * intervening non-matching rows to fill up to `LIMIT` — inherent to id-order
 * pagination under any selective predicate, not something this widening
 * introduces. That cost is a single index-scan pass at 20k rows/1.8ms, not a
 * seq scan or a per-row round trip; if a future `EXPLAIN ANALYZE` against a
 * production-sized table shows the planner choosing differently, prefer a
 * cheap pre-flight COUNT of the dangling cohort plus a loud refusal over
 * silently letting this pass degrade into a multi-hour scan that finds
 * nothing.
 */
export const loadOrphanPage: LoadScrubPageFn = async (afterId, batchSize, maxId) => {
  const rows = (await db.execute(sql`
    SELECT f."id", f."entry_type", f."dj_name", f."message", f."show_id"
      FROM ${FLOWSHEET_TABLE} AS f
     WHERE f."id" > ${afterId}${upperBound(maxId)}
       AND (
         f."show_id" IS NULL
         OR NOT EXISTS (SELECT 1 FROM ${SHOWS_TABLE} AS s WHERE s."id" = f."show_id")
       )
       AND f."dj_name" IS NOT NULL
       AND f."entry_type" IN (${sqlEntryTypeList(IN_SCOPE_ENTRY_TYPES)})
     ORDER BY f."id"
     LIMIT ${batchSize}
  `)) as unknown as Array<Pick<ScrubRow, 'id' | 'entry_type' | 'dj_name' | 'message' | 'show_id'>>;
  // Normalized to `show_id: null` for EVERY row this pass returns, including
  // a DANGLING non-null show_id. `decideDjName`'s piiOnly routing keys on
  // `row.show_id === null` to mean "no shows chain to recompute from", and
  // that is exactly as true for a dangling id as for a genuinely NULL one —
  // there is no live `shows` row to join to either way. Do not "fix" this to
  // preserve the raw dangling id: that would silently route these rows into
  // the main pass's recompute branch, which has nothing valid to join
  // against and would misbehave (an unmatched JOIN never happens today
  // because `loadMainPage` uses an INNER JOIN, but this function's row shape
  // is also what a future caller might reuse).
  return rows.map((row) => ({
    ...row,
    show_id: null,
    dj_name_override: null,
    legacy_dj_name: null,
    primary_dj_id: null,
    user_found: false,
    user_dj_name: null,
  }));
};

/** One page of marker rows carrying message text. */
export const loadMessagePage: LoadMessagePageFn = async (afterId, batchSize, maxId) => {
  return (await db.execute(sql`
    SELECT f."id", f."entry_type", f."message"
      FROM ${FLOWSHEET_TABLE} AS f
     WHERE f."id" > ${afterId}${upperBound(maxId)}
       AND f."message" IS NOT NULL
       AND f."entry_type" IN (${sqlEntryTypeList(MESSAGE_ENTRY_TYPES)})
     ORDER BY f."id"
     LIMIT ${batchSize}
  `)) as unknown as MessageRow[];
};

/**
 * Apply one page of `dj_name` writes in a single VALUES-join UPDATE inside a
 * raised-timeout transaction.
 *
 * `IS NOT DISTINCT FROM v."old_dj_name"` is a compare-and-set, and it is load
 * bearing rather than ceremony. This job OVERWRITES non-NULL values on the
 * live on-air table, a page can sit unwritten for a long time under
 * cooperative pause, and two other writers touch this column concurrently:
 * `jobs/flowsheet-etl/job.ts:121` and `apps/backend/routes/internal.route.ts:195`.
 * Without the CAS this job would clobber a value one of them wrote after this
 * page's SELECT.
 *
 * A VALUES join rather than `ANY(<id list>)` because each row carries its own
 * computed value. It also binds every id and name as its own parameter, so
 * nothing here hand-rolls a PG array literal — `intArrayLiteral` (BS#2010)
 * covers ints, but `dj_name` is text and would need real array-literal
 * escaping.
 *
 * `updated_at` is deliberately absent from the SET list: migration 0084's
 * BEFORE UPDATE trigger `bump_flowsheet_updated_at` owns that column.
 * `search_doc` is likewise absent — it is STORED GENERATED over an expression
 * containing `dj_name`, so Postgres recomputes it as part of this write.
 */
export const applyDjNameBatch: ApplyDjNameBatchFn = async (fixes, updateTimeoutMs) => {
  if (fixes.length === 0) return 0;
  const values = sql.join(
    fixes.map((fix) => sql`(${fix.id}::int, ${fix.djName}::text, ${fix.oldDjName}::text)`),
    sql`, `
  );
  const updateSql = sql`
    UPDATE ${FLOWSHEET_TABLE} AS t
       SET "dj_name" = v."dj_name"
      FROM (VALUES ${values}) AS v("id", "dj_name", "old_dj_name")
     WHERE t."id" = v."id"
       AND t."dj_name" IS NOT DISTINCT FROM v."old_dj_name"
  `;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(updateTimeoutMs))}`);
    return tx.execute(updateSql);
  });
  return Number((result as { count?: number }).count ?? 0);
};

/**
 * Apply one page of `message` rewrites. Same CAS and same trigger-ownership
 * note as `applyDjNameBatch`. `message` is `varchar(250)` and every rewrite is
 * strictly shorter than the text it replaces, so truncation is not reachable.
 */
export const applyMessageBatch: ApplyMessageBatchFn = async (fixes, updateTimeoutMs) => {
  if (fixes.length === 0) return 0;
  const values = sql.join(
    fixes.map((fix) => sql`(${fix.id}::int, ${fix.message}::varchar, ${fix.oldMessage}::varchar)`),
    sql`, `
  );
  const updateSql = sql`
    UPDATE ${FLOWSHEET_TABLE} AS t
       SET "message" = v."message"
      FROM (VALUES ${values}) AS v("id", "message", "old_message")
     WHERE t."id" = v."id"
       AND t."message" IS NOT DISTINCT FROM v."old_message"
  `;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(updateTimeoutMs))}`);
    return tx.execute(updateSql);
  });
  return Number((result as { count?: number }).count ?? 0);
};

/** `ANALYZE` after the drain — BS#934's 5-second dj-site autocomplete timeouts. */
export const analyzeFlowsheet: AnalyzeFn = async (analyzeTimeoutMs) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(analyzeTimeoutMs))}`);
    await tx.execute(sql`ANALYZE ${FLOWSHEET_TABLE}`);
  });
};

/**
 * Read-only re-scan bounded to `id <= highWaterMark`, counting rows that
 * would still be written.
 *
 * Structurally modelled on `jobs/flowsheet-dj-name-backfill/job.ts:144`, but
 * its invariant is deliberately INVERTED and must not be copied. That job
 * asserts ZERO track+marker rows with `dj_name IS NULL`; this job
 * intentionally CREATES NULLs (PII-nulled `dj_join`/`dj_leave`, orphans), so
 * copying its predicate guarantees a false failure. Migration 0054's matching
 * guard was already removed (`0054:3-4`), so nothing downstream depends on the
 * old invariant. The new NULLs are the fix, not a regression.
 *
 * The upper bound is what keeps this deterministic: the two live SQL
 * re-derivers can write a non-canonical value to a row the drain already
 * passed, and an unbounded check would fail on it nondeterministically.
 */
export const verifyScrub: VerifyFn = async ({ highWaterMark, piiNames, batchSize }) => {
  let remaining = 0;

  for (const loadPage of [loadMainPage, loadOrphanPage]) {
    let cursor = 0;
    while (cursor < highWaterMark) {
      if (stopRequested) return remaining;
      const rows = await loadPage(cursor, batchSize, highWaterMark);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (decideDjName(row, piiNames).action === 'write') remaining += 1;
      }
      cursor = rows[rows.length - 1].id;
    }
  }

  let messageCursor = 0;
  while (messageCursor < highWaterMark) {
    if (stopRequested) return remaining;
    const rows = await loadMessagePage(messageCursor, batchSize, highWaterMark);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (rewriteMessage(row.entry_type, row.message, piiNames).action === 'write') remaining += 1;
    }
    messageCursor = rows[rows.length - 1].id;
  }

  return remaining;
};

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

/**
 * Dry-run is the DEFAULT, matching `flowsheet-ghost-row-sweep` and
 * `va-apple-music-url-remediation` — not `--dry-run`-opt-in like the older
 * `legacy-dj-name-remediation`. A job that overwrites the live on-air table
 * should require the operator to ask for writes.
 */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveBatchSize = (raw: string | undefined = process.env.DJ_NAME_SCRUB_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'DJ_NAME_SCRUB_BATCH_SIZE', BATCH_SIZE_DEFAULT);

export const resolveUpdateTimeoutMs = (raw: string | undefined = process.env.DJ_NAME_SCRUB_UPDATE_TIMEOUT_MS): number =>
  requirePositiveInt(raw, 'DJ_NAME_SCRUB_UPDATE_TIMEOUT_MS', UPDATE_TIMEOUT_MS_DEFAULT);

export const resolveAnalyzeTimeoutMs = (
  raw: string | undefined = process.env.DJ_NAME_SCRUB_ANALYZE_TIMEOUT_MS
): number => requirePositiveInt(raw, 'DJ_NAME_SCRUB_ANALYZE_TIMEOUT_MS', ANALYZE_TIMEOUT_MS_DEFAULT);

export const resolveSampleSize = (raw: string | undefined = process.env.DJ_NAME_SCRUB_SAMPLE_SIZE): number =>
  requireNonNegativeInt(raw, 'DJ_NAME_SCRUB_SAMPLE_SIZE', SAMPLE_SIZE_DEFAULT, {
    note: 'Use 0 to omit the changed-id sample from the summary.',
  });

export const resolveAfterId = (envName: string, raw: string | undefined): number =>
  requireNonNegativeInt(raw, envName, 0, {
    note: 'Resume cursor — the summary log of the previous run carries the per-pass last_id.',
  });

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable the cooperative pause.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  resolveLiveActivityPauseMsShared(raw, 'LIVE_ACTIVITY_PAUSE_MS');

export const resolveLiveActivityMaxPauseMs = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_MAX_PAUSE_MS
): number => resolveLiveActivityMaxPauseMsShared(raw, LIVE_ACTIVITY_MAX_PAUSE_MS_ENV);

/** Cooperative cancellation flag for graceful shutdown on SIGTERM. */
let stopRequested = false;
export const requestStop = (): void => {
  stopRequested = true;
};
/** Test-only seam to reset the singleton between tests. */
export const __resetStopForTesting = (): void => {
  stopRequested = false;
};

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

export type PassName = 'main' | 'message' | 'orphan';

export type PassTotals = {
  scanned: number;
  /** Rows the shared decision path flagged for a write. */
  changed: number;
  /** Rows the UPDATE actually affected. Always 0 in dry-run. */
  written: number;
  batches: number;
  last_id: number;
  sample: number[];
  by_reason: Record<string, number>;
  /**
   * Provenance for the `changed` count — see `classifyChange`. Diagnostic
   * only; nothing reads this to make a decision.
   */
  by_change_class: Record<string, number>;
  /**
   * A few row ids per change class, so a human can spot-check the classes
   * that matter. Ids only, never values: a sample that printed `dj_name`
   * would put DJs' legal names into every log sink this job writes to.
   */
  change_class_samples: Record<string, number[]>;
};

export type RunResult = {
  main: PassTotals;
  message: PassTotals;
  orphan: PassTotals;
  dryRun: boolean;
  stopped: boolean;
  failed: boolean;
  /** Size of the loaded PII index, so the summary shows the probe had inputs. */
  piiNameCount: number;
  /**
   * Count of `shows.legacy_dj_name` values that are themselves roster real
   * names — the BS#2281 review finding 3 pre-flight. Non-zero means this
   * job's recompute is about to WRITE those values onto every in-scope row
   * of those shows; see `countPollutedLegacyDjNames` and the warning wired
   * off it in `runScrub`.
   */
  legacyDjNamePiiCount: number;
  /** Highest id any pass reached; the bound `verifyScrub` is capped at. */
  highWaterMark: number;
  /** Verification residue below the high-water mark. -1 when not run. */
  remaining: number;
};

const emptyPassTotals = (): PassTotals => ({
  scanned: 0,
  changed: 0,
  written: 0,
  batches: 0,
  last_id: 0,
  sample: [],
  by_reason: {},
  by_change_class: {},
  change_class_samples: {},
});

const loadPageWithRetry = async <T>(
  label: string,
  load: () => Promise<T[]>,
  onRetry: (attempt: number, error: unknown) => void
): Promise<T[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (stopRequested || attempt + 1 >= LOAD_BATCH_MAX_ATTEMPTS) throw error;
      onRetry(attempt, error);
      await new Promise<void>((resolve) => setTimeout(resolve, LOAD_BATCH_BACKOFF_MS[attempt] ?? 2000));
      if (stopRequested) throw error;
    }
  }
  throw lastError;
};

export const runScrub = async (opts: {
  dryRun: boolean;
  batchSize?: number;
  updateTimeoutMs?: number;
  analyzeTimeoutMs?: number;
  sampleSize?: number;
  mainAfterId?: number;
  messageAfterId?: number;
  orphanAfterId?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  liveActivityMaxPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  loadUsers?: LoadUsersFn;
  loadShowsLegacyDjNames?: LoadShowsLegacyDjNameFn;
  loadMainPage?: LoadScrubPageFn;
  loadMessagePage?: LoadMessagePageFn;
  loadOrphanPage?: LoadScrubPageFn;
  applyDjNameBatch?: ApplyDjNameBatchFn;
  applyMessageBatch?: ApplyMessageBatchFn;
  analyzeFlowsheet?: AnalyzeFn;
  verifyScrub?: VerifyFn;
}): Promise<RunResult> => {
  const dryRun = opts.dryRun;
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const updateTimeoutMs = opts.updateTimeoutMs ?? resolveUpdateTimeoutMs();
  const analyzeTimeoutMs = opts.analyzeTimeoutMs ?? resolveAnalyzeTimeoutMs();
  const sampleSize = opts.sampleSize ?? resolveSampleSize();
  const mainAfterId =
    opts.mainAfterId ??
    resolveAfterId('DJ_NAME_SCRUB_FLOWSHEET_AFTER_ID', process.env.DJ_NAME_SCRUB_FLOWSHEET_AFTER_ID);
  const messageAfterId =
    opts.messageAfterId ?? resolveAfterId('DJ_NAME_SCRUB_MESSAGE_AFTER_ID', process.env.DJ_NAME_SCRUB_MESSAGE_AFTER_ID);
  const orphanAfterId =
    opts.orphanAfterId ?? resolveAfterId('DJ_NAME_SCRUB_ORPHAN_AFTER_ID', process.env.DJ_NAME_SCRUB_ORPHAN_AFTER_ID);
  const liveActivityLookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const liveActivityMaxPauseMs = opts.liveActivityMaxPauseMs ?? resolveLiveActivityMaxPauseMs();

  const loadUsersFn = opts.loadUsers ?? loadUsers;
  const loadShowsLegacyDjNamesFn = opts.loadShowsLegacyDjNames ?? loadShowsLegacyDjNames;
  const loadMainPageFn = opts.loadMainPage ?? loadMainPage;
  const loadMessagePageFn = opts.loadMessagePage ?? loadMessagePage;
  const loadOrphanPageFn = opts.loadOrphanPage ?? loadOrphanPage;
  const applyDjNameBatchFn = opts.applyDjNameBatch ?? applyDjNameBatch;
  const applyMessageBatchFn = opts.applyMessageBatch ?? applyMessageBatch;
  const analyzeFn = opts.analyzeFlowsheet ?? analyzeFlowsheet;
  const verifyFn = opts.verifyScrub ?? verifyScrub;
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  // BS#2009 cooperative pause, probed once per PAGE (never per row). The
  // throwing-probe fail-open lives in the shared builder; the pause CEILING
  // does not fail open — `buildWaitForQuietPeriod` throws
  // `LiveActivityPauseCeilingExceededError` once the cumulative budget is
  // spent, and docs/env-vars.md:34 is emphatic that a TypeScript job must
  // abort there rather than silently continue. Every pass therefore mutates
  // its cursor in `result` IN PLACE, so a throw from here propagates with all
  // three cursors already persisted and the run stays resumable.
  const waitForQuietPeriod = buildWaitForQuietPeriod({
    lookbackSeconds: liveActivityLookbackSeconds,
    pauseMs: liveActivityPauseMs,
    maxTotalPauseMs: liveActivityMaxPauseMs,
    probe,
    shouldStop: () => stopRequested,
    onPause: () => {
      log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${liveActivityPauseMs}ms`, {
        lookback_seconds: liveActivityLookbackSeconds,
        pause_ms: liveActivityPauseMs,
      });
    },
    onProbeError: (error) => {
      log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
        error_message: errorMessage(error),
      });
      captureError(error, 'probe_error');
    },
    onBudgetExhausted: (pausedMs) => {
      log(
        'error',
        'live_activity_pause_ceiling_exceeded',
        `cooperative-pause budget exceeded (${pausedMs}ms >= LIVE_ACTIVITY_MAX_PAUSE_MS=${liveActivityMaxPauseMs}ms); aborting instead of pausing indefinitely`,
        { paused_ms: pausedMs, live_activity_max_pause_ms: liveActivityMaxPauseMs }
      );
    },
  });

  const result: RunResult = {
    main: emptyPassTotals(),
    message: emptyPassTotals(),
    orphan: emptyPassTotals(),
    dryRun,
    stopped: false,
    failed: false,
    piiNameCount: 0,
    legacyDjNamePiiCount: 0,
    highWaterMark: 0,
    remaining: -1,
  };
  // Pre-seed every cursor so a run that aborts before a pass starts logs the
  // operator's own cursor back out, not a misleading 0.
  result.main.last_id = mainAfterId;
  result.message.last_id = messageAfterId;
  result.orphan.last_id = orphanAfterId;
  let failure: { error: unknown } | null = null;
  let wrote = false;

  log('info', 'started', `${JOB_NAME} starting`, {
    dry_run: dryRun,
    batch_size: batchSize,
    update_timeout_ms: updateTimeoutMs,
    analyze_timeout_ms: analyzeTimeoutMs,
    sample_size: sampleSize,
    main_after_id: mainAfterId,
    message_after_id: messageAfterId,
    orphan_after_id: orphanAfterId,
    live_activity_lookback_seconds: liveActivityLookbackSeconds,
    live_activity_pause_ms: liveActivityPauseMs,
    live_activity_max_pause_ms: liveActivityMaxPauseMs,
  });

  let piiNames: ReadonlySet<string> = new Set<string>();
  try {
    piiNames = buildPiiNameIndex(await loadUsersFn());
    result.piiNameCount = piiNames.size;
    log('info', 'pii_index_loaded', 'auth_user real-name index built', { pii_name_count: piiNames.size });
  } catch (error) {
    failure = { error };
    log('error', 'pii_index_failed', 'failed to build the auth_user real-name index', {
      error_message: errorMessage(error),
    });
    captureError(error, 'pii_index_failed');
  }

  // Startup pre-flight (BS#2281 review finding 3), run in BOTH dry-run and
  // execute mode, before the first pass — so a dry-run operator sees the
  // risk before anyone asks for `--execute`. This job's recompute TRUSTS
  // `shows.legacy_dj_name` to already be clean (see `countPollutedLegacyDjNames`'s
  // doc); `shows` is small, so this is one cheap query, not a paged drain.
  if (!failure) {
    try {
      const shows = await loadShowsLegacyDjNamesFn();
      const legacyDjNamePiiCount = countPollutedLegacyDjNames(shows, piiNames);
      result.legacyDjNamePiiCount = legacyDjNamePiiCount;
      log('info', 'legacy_dj_name_preflight', 'shows.legacy_dj_name pre-flight complete', {
        legacy_dj_name_pii_count: legacyDjNamePiiCount,
        shows_with_legacy_dj_name: shows.length,
      });
      if (legacyDjNamePiiCount > 0) {
        const message =
          `${legacyDjNamePiiCount} shows.legacy_dj_name value(s) are roster real names. ` +
          'resolveShowDjName reads legacy_dj_name as a direct chain input with no PII check of its own, ' +
          'so this run WILL WRITE those values onto every in-scope row of those shows. See ' +
          'jobs/flowsheet-dj-name-scrub/README.md, "shows.legacy_dj_name pre-flight", before proceeding.';
        log('warn', 'legacy_dj_name_pollution', message, { count: legacyDjNamePiiCount });
        captureError(new Error(message), 'legacy_dj_name_pollution', { count: legacyDjNamePiiCount });
      }
    } catch (error) {
      failure = { error };
      log('error', 'legacy_dj_name_preflight_failed', 'failed to scan shows.legacy_dj_name for roster real names', {
        error_message: errorMessage(error),
      });
      captureError(error, 'legacy_dj_name_preflight_failed');
    }
  }

  /**
   * One pass of the id-cursor drain. Generic over the row and fix shapes so
   * the three passes share the loop, the pause, the retry, the cursor
   * discipline, and — critically — the single decision call. Dry-run differs
   * from live in exactly one place: whether `apply` is invoked.
   */
  const runPass = async <Row extends { id: number }, Fix>(
    pass: PassName,
    afterId: number,
    loadPage: (afterId: number, batchSize: number) => Promise<Row[]>,
    decide: (row: Row) => { fix: Fix | null; reason: string; changeClass?: ChangeClass },
    apply: (fixes: Fix[], timeoutMs: number) => Promise<number>
  ): Promise<void> => {
    const totals = result[pass];
    totals.last_id = afterId;
    let cursor = afterId;

    while (true) {
      if (stopRequested || (await waitForQuietPeriod())) {
        result.stopped = true;
        return;
      }

      let rows: Row[];
      try {
        rows = await loadPageWithRetry(
          pass,
          () => loadPage(cursor, batchSize),
          (attempt, error) => {
            log('warn', 'load_retry', `${pass} page load failed; retrying`, {
              pass,
              attempt: attempt + 1,
              after_id: cursor,
              error_message: errorMessage(error),
            });
          }
        );
      } catch (error) {
        if (stopRequested) result.stopped = true;
        else failure = { error };
        return;
      }
      if (rows.length === 0) return;

      const batchStart = Date.now();
      const fixes: Fix[] = [];
      for (const row of rows) {
        totals.scanned += 1;
        const { fix, reason, changeClass } = decide(row);
        totals.by_reason[reason] = (totals.by_reason[reason] ?? 0) + 1;
        if (fix === null) continue;
        totals.changed += 1;
        if (totals.sample.length < sampleSize) totals.sample.push(row.id);
        // Provenance for this write. Diagnostic only — see `classifyChange`.
        if (changeClass) {
          totals.by_change_class[changeClass] = (totals.by_change_class[changeClass] ?? 0) + 1;
          const classSample = (totals.change_class_samples[changeClass] ??= []);
          if (classSample.length < CHANGE_CLASS_SAMPLE_SIZE) classSample.push(row.id);
        }
        fixes.push(fix);
      }

      // rows are ORDER BY id ASC, so the last row carries the page's max id.
      const batchMaxId = rows[rows.length - 1].id;

      if (!dryRun && fixes.length > 0) {
        try {
          totals.written += await apply(fixes, updateTimeoutMs);
          wrote = true;
        } catch (error) {
          // The whole page failed. Do NOT advance the cursor — a re-run from
          // the previous cursor re-selects and re-decides these rows, which is
          // idempotent because the decision compares against the recomputed
          // value rather than testing for NULL.
          log('warn', 'db_error', `${pass} batch UPDATE failed at id>${cursor}`, {
            pass,
            after_id: cursor,
            batch_rows: fixes.length,
            error_message: errorMessage(error),
          });
          captureError(error, 'db_error', { pass, after_id: cursor, batch_rows: fixes.length });
          failure = { error };
          return;
        }
      }

      cursor = batchMaxId;
      totals.last_id = batchMaxId;
      totals.batches += 1;
      if (batchMaxId > result.highWaterMark) result.highWaterMark = batchMaxId;

      log('info', 'batch_done', `${pass} batch ${totals.batches} done`, {
        pass,
        batch_index: totals.batches,
        wall_clock_ms: Date.now() - batchStart,
        last_id: cursor,
        page_rows: rows.length,
        page_changed: fixes.length,
        total_scanned: totals.scanned,
        total_changed: totals.changed,
        total_written: totals.written,
      });
    }
  };

  const decideForScrubPass = (row: ScrubRow): { fix: DjNameFix | null; reason: string; changeClass?: ChangeClass } => {
    const decision = decideDjName(row, piiNames);
    if (decision.action === 'skip') return { fix: null, reason: decision.reason };
    return {
      fix: { id: row.id, djName: decision.djName, oldDjName: row.dj_name },
      reason: decision.reason,
      changeClass: classifyChange(row, decision.djName, piiNames),
    };
  };

  const decideForMessagePass = (row: MessageRow): { fix: MessageFix | null; reason: string } => {
    const decision = rewriteMessage(row.entry_type, row.message, piiNames);
    if (decision.action === 'skip') return { fix: null, reason: decision.reason };
    return {
      fix: { id: row.id, message: decision.message, oldMessage: row.message },
      // Keyed BY ENTRY TYPE, not aggregated. Two of the four rewrites
      // (`dj_join`, `dj_leave`) introduce a message shape that has never
      // existed in the stored corpus, and the other two degrade to wording
      // their own writers already emit. Those are different risks, so an
      // operator reviewing the dry run has to be able to see how many of each
      // this run would write — a single lumped total would hide it.
      reason: `message_pii_rewritten:${row.entry_type}`,
    };
  };

  if (!failure) {
    try {
      await runPass('main', mainAfterId, loadMainPageFn, decideForScrubPass, applyDjNameBatchFn);
      if (!result.stopped && !failure) {
        await runPass('message', messageAfterId, loadMessagePageFn, decideForMessagePass, applyMessageBatchFn);
      }
      if (!result.stopped && !failure) {
        await runPass('orphan', orphanAfterId, loadOrphanPageFn, decideForScrubPass, applyDjNameBatchFn);
      }
    } catch (error) {
      // The pass loop catches its own load/write errors, so this arm is for
      // the cooperative-pause ceiling throw (and, defensively, programming
      // errors). Every cursor is already persisted on `result` by the time we
      // get here — that is the whole point of mutating totals in place.
      failure = { error };
    }
  }

  // BS#2281 review finding 2: a class describing what a write would ITSELF
  // WRITE, not what it removes. Only the `main` pass can produce it — the
  // `orphan` pass's rows always route through `decideDjName`'s piiOnly
  // branch, which never recomputes, so `orphan.by_change_class` can never
  // carry this key. Counted, not gated: `verifyScrub` does NOT fail on this
  // class. Fixing it for real means widening the PII probe to Cohort C
  // (a `dj_name_override` or a `legacy_dj_name` that a DJ typed their own
  // real name into) — explicitly out of scope for this job — so a hard
  // failure here would be a permanent red build over a condition this job
  // has no in-scope way to correct, not a signal an operator can act on.
  // Loud instead: a structured warning plus a Sentry capture, deliberately
  // never hidden behind dry-run.
  if (!failure) {
    const recomputedPiiCount = result.main.by_change_class['recomputed_is_roster_real_name'] ?? 0;
    if (recomputedPiiCount > 0) {
      const message =
        `${recomputedPiiCount} would-be dj_name write(s) in the main pass would themselves recompute to a ` +
        'roster real name (most likely a dj_name_override or a legacy_dj_name that itself holds one — ' +
        'Cohort C, out of scope for this job). This run still WRITES those values; it does not fail on this class.';
      log('warn', 'recomputed_pii_detected', message, { count: recomputedPiiCount });
      captureError(new Error(message), 'recomputed_pii_detected', { count: recomputedPiiCount });
    }
  }

  // ANALYZE after the drain, not between passes: all three write to the same
  // table, and stale planner stats are what cost dj-site DJs 5-second
  // autocomplete timeouts after the 2026-05-15 mojibake migration (BS#934).
  // Runs even on a stopped/failed run that wrote — a partial write leaves
  // stats just as stale as a complete one.
  if (wrote) {
    try {
      await analyzeFn(analyzeTimeoutMs);
      log('info', 'analyzed', 'flowsheet ANALYZE complete', {});
    } catch (error) {
      log('warn', 'analyze_error', 'flowsheet ANALYZE failed', { error_message: errorMessage(error) });
      captureError(error, 'analyze_error');
      // Stale stats are not a data-correctness failure. Surface it loudly,
      // but do not fail the run over it.
    }
  }

  if (!dryRun && !result.stopped && !failure && wrote) {
    try {
      const remaining = await verifyFn({ highWaterMark: result.highWaterMark, piiNames, batchSize });
      result.remaining = remaining;
      if (remaining > 0) {
        const verifyError = new Error(
          `${remaining} row(s) at or below id ${result.highWaterMark} still differ from the canonical ` +
            'resolution. Re-run — the decision path is idempotent. If it persists, a writer outside this ' +
            'job is producing non-canonical values (see jobs/flowsheet-etl/job.ts:121 and ' +
            'apps/backend/routes/internal.route.ts:195).'
        );
        log('error', 'verification_failed', verifyError.message, {
          remaining,
          high_water_mark: result.highWaterMark,
        });
        captureError(verifyError, 'verification_failed', { remaining });
        failure = { error: verifyError };
      } else {
        log('info', 'verified', 'scrub verified clean below the high-water mark', {
          high_water_mark: result.highWaterMark,
        });
      }
    } catch (error) {
      if (stopRequested) {
        result.stopped = true;
      } else {
        log('warn', 'verification_error', 'post-run verification failed to run', {
          error_message: errorMessage(error),
        });
        captureError(error, 'verification_error');
        failure = failure ?? { error };
      }
    }
  }

  result.failed = failure !== null;

  Sentry.startSpan(
    {
      name: 'flowsheet_dj_name_scrub.run.summary',
      attributes: {
        'scrub.dry_run': dryRun,
        'scrub.pii_name_count': result.piiNameCount,
        'scrub.legacy_dj_name_pii_count': result.legacyDjNamePiiCount,
        'scrub.main.scanned': result.main.scanned,
        'scrub.main.changed': result.main.changed,
        'scrub.main.written': result.main.written,
        'scrub.main.last_id': result.main.last_id,
        'scrub.message.scanned': result.message.scanned,
        'scrub.message.changed': result.message.changed,
        'scrub.message.written': result.message.written,
        'scrub.message.last_id': result.message.last_id,
        'scrub.orphan.scanned': result.orphan.scanned,
        'scrub.orphan.changed': result.orphan.changed,
        'scrub.orphan.written': result.orphan.written,
        'scrub.orphan.last_id': result.orphan.last_id,
        'scrub.high_water_mark': result.highWaterMark,
        'scrub.remaining': result.remaining,
        'scrub.stopped': result.stopped,
        'scrub.failed': result.failed,
      },
    },
    () => {
      /* attributes set at creation */
    }
  );

  const step = failure ? 'failed' : result.stopped ? 'stopped' : 'finished';
  log(failure ? 'error' : 'info', step, `${JOB_NAME} ${step}`, {
    dry_run: dryRun,
    pii_name_count: result.piiNameCount,
    legacy_dj_name_pii_count: result.legacyDjNamePiiCount,
    main: { ...result.main },
    message: { ...result.message },
    orphan: { ...result.orphan },
    high_water_mark: result.highWaterMark,
    remaining: result.remaining,
    stopped: result.stopped,
    failed: result.failed,
    ...(failure ? { error_message: errorMessage(failure.error) } : {}),
  });
  if (failure) {
    captureError(failure.error, 'failed', {
      main_last_id: result.main.last_id,
      message_last_id: result.message.last_id,
      orphan_last_id: result.orphan.last_id,
    });
  }

  return result;
};
