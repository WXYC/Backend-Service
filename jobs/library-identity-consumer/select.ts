/**
 * SELECT predicate for the library-identity-consumer job (BS#802).
 *
 * Picks libraries needing identity refresh under the post-#800 pivot
 * (Backend is thin-writer; LML is sole composer):
 *
 *   library.canonical_entity_id IS NOT NULL
 *   AND NOT EXISTS (
 *     SELECT 1 FROM library_identity
 *     WHERE library_id = library.id
 *       AND last_verified_at >= NOW() - interval '7 days'
 *   )
 *
 * BS#1144: the predicate used to be `canonical_entity_id IS NOT NULL OR ...`
 * — an unconditional disjunct that re-fetched every canonicalized row on
 * every run regardless of freshness, burning LML quota. The fix narrowed
 * eligibility to rows with no `library_identity` row yet, or whose existing
 * row is stale: `NOT EXISTS (SELECT 1 FROM library_identity WHERE library_id
 * = library.id) OR EXISTS (SELECT 1 FROM library_identity WHERE library_id =
 * library.id AND last_verified_at < NOW() - interval '7 days')`.
 *
 * BS#1800: simplified to the single `NOT EXISTS (... AND last_verified_at
 * >= ...)` form above. `library_identity.library_id` is a PRIMARY KEY (see
 * schema.ts), so there is at most one `library_identity` row per library —
 * call its existence P and its freshness F. The #1144 form was `NOT P OR (P
 * AND NOT F)`, which is `NOT P OR NOT F` (i.e. "no row yet, or the row
 * isn't fresh") for exactly the same reason `A OR (A AND B)` reduces to `A
 * OR B` when `A` and `NOT A` partition the cases — here P and NOT P do. Its
 * negation, `NOT (NOT P OR NOT F)` = `P AND F` ("a row exists and is
 * fresh"), is exactly what `EXISTS (... AND last_verified_at >= ...)` tests,
 * so `NOT EXISTS (... AND last_verified_at >= ...)` is `NOT P OR NOT F` —
 * the identical predicate in one subquery instead of two. This equivalence
 * rests on TWO preconditions, both currently true: the PK (at most one row
 * to reason about; it would NOT hold for a one-to-many child table), and
 * `library_identity.last_verified_at` being `NOT NULL` (see schema.ts) — so
 * `>= threshold` and `< threshold` are true complements (exactly one holds)
 * for any row that exists. If that column were ever made nullable, a row
 * with a NULL `last_verified_at` would break the complement: both
 * `last_verified_at >= threshold` and `last_verified_at < threshold`
 * evaluate to unknown/false per SQL's three-valued logic, so neither
 * `EXISTS` clause would match it. The two forms would then diverge on
 * exactly that row: the old form's `EXISTS(... < threshold)` finds nothing,
 * falling through to `NOT P` — false, since the row exists — so the row is
 * EXCLUDED; the new form's `NOT EXISTS(... >= threshold)` also finds
 * nothing, so `NOT EXISTS(...)` is true and the row is INCLUDED. A future
 * nullable `last_verified_at` would need to re-derive this predicate rather
 * than assume the simplification still holds. Behavioral coverage (fresh
 * excluded; absent/stale included) lives in
 * tests/integration/library-identity-consumer-select.spec.js — see that
 * file's docstring for why it embeds this predicate literally rather than
 * importing loadBatch() directly.
 *
 * BS#974: `INCLUDE_NULL_CANONICAL` (default off) expands the predicate to also
 * cover `canonical_entity_id IS NULL` rows — the ~34K never-canonicalized
 * libraries, incl. the V/A compilations LML has never classified. The
 * unresolved-row hot-loop that expansion would otherwise cause (a row LML
 * can't resolve never lands in `library_identity`, so `NOT EXISTS(li)` stays
 * true forever) is prevented by the `library.unresolved_attempted_at` no-match
 * marker + the `UNRESOLVED_RETRY_DAYS` window (see `loadBatch`). Flag off is
 * byte-identical to the #1144 predicate. This is a one-shot job with no cron
 * backstop; re-attempt of the marked/stale set happens only on a manual
 * re-run.
 *
 * Note on the column name: BS#802's ticket body wrote `last_refreshed_at`,
 * but the column on `library_identity` is `last_verified_at`. We use
 * `last_verified_at` — this is the actual schema, and the PR body calls
 * the rename out so the reviewer sees the correction.
 *
 * Schema-qualified table refs honor `WXYC_SCHEMA_NAME` so Jest workers
 * (which override the env var) target the right schema. Sanitised against
 * `"` to keep the SQL well-formed. Same shape as
 * `library-identity-backfill/orchestrate.ts`.
 *
 * Pagination is via the canonical id-cursor pattern (last-id cursor + LIMIT)
 * with optional PARTITION_INDEX / PARTITION_COUNT modulo for N-container
 * parallel runs.
 *
 * BS#1991 (#801 S2): `loadBatch` additionally accepts a `cohort` (`va` /
 * `non_va` / `null`) that ANDs the `VA_COHORT_CONDITION` membership test
 * onto the predicate, and a `recheck` flag that replaces the predicate
 * outright for the on-demand resolved-compilation re-drain. `job.ts` runs
 * two `runConsumer` drains — one per cohort, at different page sizes — per
 * the AC in the issue; `cohort: null` (the pre-existing single-drain shape)
 * is unchanged and still exercised by the integration spec.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const LIBRARY_IDENTITY_TABLE = sql.raw(`"${SCHEMA}"."library_identity"`);
const COMPILATION_TRACK_ARTIST_TABLE = sql.raw(`"${SCHEMA}"."compilation_track_artist"`);

export type LibraryRow = {
  id: number;
  artist_name: string;
  album_title: string;
  legacy_release_id: number;
};

/**
 * BS#1991 (#801 S2 comment 2): the V/A ("va") cohort — rows LML's
 * bulk-resolve auto-detects as compilations — is what `include_tracks: true`
 * must page small for (S0/#1989 measured mean 56 credits/release, p99 483,
 * max 2,364; a 1,000-id V/A page is ~11 MB). LML's own auto-detection reads
 * `library.code_volume_letters LIKE 'Z%'` OR the existence of a
 * `compilation_track_artist` row for the library — both are things Backend
 * owns and can classify locally, which is why the request-level
 * `include_tracks` flag is a per-*batch* caller decision (this job), not a
 * per-input LML flag. The `non_va` cohort is everything else, paged full
 * width. See `resolveCohortFilter`'s call sites in `job.ts`.
 */
export type Cohort = 'va' | 'non_va';

// `code_volume_letters` is nullable (schema.ts documents NULL as a genuine
// library-metadata gap). `NULL LIKE 'Z%'` evaluates to NULL, not FALSE, so
// without the COALESCE a NULL-`code_volume_letters` row with no CTA row
// would make the whole OR-expression NULL: `AND (NULL)` excludes it from
// `va`, and `AND NOT (NULL)` is ALSO NULL (three-valued logic), excluding it
// from `non_va` too — silently dropping the row from both drains. COALESCE
// pins the expression to a real boolean so the two cohorts stay an exact
// partition of every row the pre-BS#1991 single drain used to scan.
const VA_COHORT_CONDITION = sql`(
  COALESCE(${LIBRARY_TABLE}."code_volume_letters", '') LIKE 'Z%'
  OR EXISTS (
    SELECT 1 FROM ${COMPILATION_TRACK_ARTIST_TABLE} cta
    WHERE cta."library_id" = ${LIBRARY_TABLE}."id"
  )
)`;

/**
 * Resolve `BATCH_SIZE` from the env, falling back to `defaultBatchSize`.
 * LML caps the bulk endpoint at 1000 inputs per request; the default is 500
 * for headroom (per BS#802).
 */
export const resolveBatchSize = (raw: string | undefined = process.env.BATCH_SIZE, defaultBatchSize = 500): number => {
  if (raw === undefined) return defaultBatchSize;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error(`Invalid BATCH_SIZE=${JSON.stringify(raw)}; must be a positive integer ≤ 1000 (LML cap).`);
  }
  return parsed;
};

/**
 * BS#1991: page size for the `va` cohort, kept separate from `BATCH_SIZE`
 * (which now governs the `non_va` cohort's full-width pages). Defaults to
 * 100 per the S0/#1989 payload measurement in `VA_COHORT_CONDITION`'s
 * docstring above.
 */
export const resolveVaBatchSize = (
  raw: string | undefined = process.env.VA_BATCH_SIZE,
  defaultBatchSize = 100
): number => {
  if (raw === undefined) return defaultBatchSize;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error(`Invalid VA_BATCH_SIZE=${JSON.stringify(raw)}; must be a positive integer ≤ 1000 (LML cap).`);
  }
  return parsed;
};

export const resolveThrottleMs = (raw: string | undefined = process.env.THROTTLE_MS, defaultMs = 100): number => {
  if (raw === undefined) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid THROTTLE_MS=${JSON.stringify(raw)}; must be a non-negative integer.`);
  }
  return parsed;
};

export const resolvePartitionFilter = (
  rawIndex: string | undefined = process.env.PARTITION_INDEX,
  rawCount: string | undefined = process.env.PARTITION_COUNT
): { sqlFragment: SQL | null; description: string } => {
  const count = rawCount === undefined ? 1 : Number(rawCount);
  const index = rawIndex === undefined ? 0 : Number(rawIndex);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid PARTITION_COUNT=${JSON.stringify(rawCount)}; must be a positive integer.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `Invalid PARTITION_INDEX=${JSON.stringify(rawIndex)}; must be 0 <= index < PARTITION_COUNT (${count}).`
    );
  }
  if (count === 1) {
    return { sqlFragment: null, description: 'partition=none' };
  }
  return {
    sqlFragment: sql`AND (${LIBRARY_TABLE}."id" % ${count}) = ${index}`,
    description: `partition=${index}/${count}`,
  };
};

export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

export const resolveStaleThreshold = (
  raw: string | undefined = process.env.STALE_THRESHOLD_DAYS,
  defaultDays = 7
): number => {
  if (raw === undefined) return defaultDays;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid STALE_THRESHOLD_DAYS=${JSON.stringify(raw)}; must be a positive integer.`);
  }
  return parsed;
};

/**
 * BS#974 feature flag: when true, the SELECT predicate expands to also cover
 * `canonical_entity_id IS NULL` rows (the ~34K never-canonicalized libraries,
 * incl. the V/A compilations LML has never classified). Defaults OFF so a
 * deploy is a zero-change no-op until an operator opts in — the staged-rollout
 * gate. See README.md.
 */
export const resolveIncludeNullCanonical = (raw: string | undefined = process.env.INCLUDE_NULL_CANONICAL): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

/**
 * BS#974: the retry window for the `unresolved_attempted_at` no-match marker —
 * a *separate* knob from `STALE_THRESHOLD_DAYS` (which governs identity
 * freshness). A row LML couldn't resolve is re-attempted only after this many
 * days, so a manual re-run doesn't re-burn LML on rows unlikely to newly
 * resolve. Defaults to 30, matching the fleet's no-match TTL convention
 * (`CONCERTS_ARTIST_RESOLVE_NO_MATCH_TTL_DAYS`). Only read when
 * `INCLUDE_NULL_CANONICAL` is on.
 */
export const resolveUnresolvedRetryDays = (
  raw: string | undefined = process.env.UNRESOLVED_RETRY_DAYS,
  defaultDays = 30
): number => {
  if (raw === undefined) return defaultDays;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid UNRESOLVED_RETRY_DAYS=${JSON.stringify(raw)}; must be a positive integer.`);
  }
  return parsed;
};

/**
 * BS#1991 AC: on-demand re-drain of the resolved-compilation cohort, for
 * picking up matcher improvements after a deliberate re-run rather than on a
 * polling cadence (per the #801 addendum: "store improvements propagate by
 * deliberate re-drain, not polling"). Manual-only — no cron reads this.
 */
export const resolveRecheck = (raw: string | undefined = process.env.RECHECK): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

/**
 * Load the next batch of libraries needing identity refresh.
 *
 * The predicate is the canonicalized-and-fresh gate described above. Rows are skipped when
 * `artist_name` or `album_title` is NULL — LML's bulk endpoint requires
 * both. (`album_title` is NOT NULL in the schema, but `artist_name` is
 * nullable until the Epic A.2 backfill completes for any future-added
 * rows.)
 *
 * The id-cursor predicate keeps the SELECT bounded as the run progresses.
 */
export const loadBatch = async (
  afterId: number,
  batchSize: number,
  partitionFilter: SQL | null,
  staleDays: number,
  includeNullCanonical = false,
  unresolvedRetryDays = 30,
  cohort: Cohort | null = null,
  recheck = false
): Promise<LibraryRow[]> => {
  const partitionClause = partitionFilter ?? sql``;
  // BS#1991: AND'd onto whichever eligibility branch below applies. `null`
  // (the pre-existing single-drain callers, e.g. the integration spec) keeps
  // the predicate untouched. Skipped entirely in `recheck` mode, whose
  // eligibility core already embeds the va condition directly (see below) —
  // ANDing it again here would be redundant, not wrong, but the ternary
  // keeps the generated SQL readable.
  const cohortClause = recheck
    ? sql``
    : cohort === 'va'
      ? sql`AND ${VA_COHORT_CONDITION}`
      : cohort === 'non_va'
        ? sql`AND NOT (${VA_COHORT_CONDITION})`
        : sql``;

  // The eligibility core. Flag OFF is byte-identical (post-BS#1800
  // simplification -- see the module docstring for the equivalence proof) to
  // the post-#1144 predicate (canonicalized rows only: never-resolved OR
  // stale). Flag ON (BS#974) drops the `canonical_entity_id IS NOT NULL`
  // filter and gates every first-time candidate on the
  // `unresolved_attempted_at` no-match marker, so the ~34K NULL-canonical
  // rows come into scope without the unresolved-row hot-loop (a row LML
  // couldn't resolve isn't re-attempted until `unresolvedRetryDays` elapse).
  // This also retro-fixes the pre-existing canonical-unresolved re-attempt,
  // since it too now honors the marker. (The flag-ON branch keeps its
  // separate `NOT EXISTS(any)` subquery rather than the flag-OFF
  // simplification below -- its NOT-EXISTS arm is further gated by the
  // no-match-marker AND clause, so it isn't the pure `NOT P OR NOT F` shape
  // the PK equivalence applies to.)
  // BS#1991: `recheck` mode replaces the normal freshness/no-match-marker
  // eligibility entirely — it deliberately IGNORES `unresolvedRetryDays` and
  // re-drives every va-cohort row this job has previously visited
  // (`unresolved_attempted_at IS NOT NULL`, stamped for both resolved and
  // not-yet-askable compilation results — see orchestrate.ts), regardless of
  // how recently. That's the point: an operator reaching for `--recheck` is
  // saying "the matcher just improved, re-ask now", not "wait for the TTL".
  const eligibilityCore = recheck
    ? sql`AND ${VA_COHORT_CONDITION} AND "unresolved_attempted_at" IS NOT NULL`
    : includeNullCanonical
      ? sql`
      AND (
        EXISTS (
          SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li
          WHERE li."library_id" = ${LIBRARY_TABLE}."id"
            AND li."last_verified_at" < NOW() - (interval '1 day' * ${staleDays})
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li
            WHERE li."library_id" = ${LIBRARY_TABLE}."id"
          )
          AND (
            "unresolved_attempted_at" IS NULL
            OR "unresolved_attempted_at" < NOW() - (interval '1 day' * ${unresolvedRetryDays})
          )
        )
      )`
      : sql`
      AND "canonical_entity_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li
        WHERE li."library_id" = ${LIBRARY_TABLE}."id"
          AND li."last_verified_at" >= NOW() - (interval '1 day' * ${staleDays})
      )`;

  const rows = (await db.execute(sql`
    SELECT
      "id",
      "artist_name",
      "album_title",
      "legacy_release_id"
    FROM ${LIBRARY_TABLE}
    WHERE "id" > ${afterId}
      AND "artist_name" IS NOT NULL
      ${eligibilityCore}
      ${cohortClause}
      ${partitionClause}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as LibraryRow[];
  return rows ?? [];
};
