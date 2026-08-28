/**
 * The PII-safe DJ-name resolution chain, as pure decisions.
 *
 * Extracted from `apps/backend/services/flowsheet.service.ts` (BS#2119
 * review) so `jobs/` writers can apply the identical chain instead of
 * re-deriving it in SQL. That re-derivation is exactly what went wrong:
 * `jobs/flowsheet-april-gap-import` shipped a `COALESCE(auth_user.dj_name,
 * shows.legacy_dj_name)` copy that predated `dj_name_override` (BS#1321) and
 * omitted the literal-"Anonymous" filter (BS#1286), so an imported row could
 * disagree with every sibling row in the same show. Same reasoning as the
 * `recomputeHasResolvedSupport` extraction (BS#1763) and the
 * `@wxyc/legacy-mirror` payload extraction (BS#1707): two consumers, one
 * decision.
 *
 * `flowsheet.service.ts` re-exports `resolveDjDisplayName` and
 * `resolveShowDjName` so existing import sites (and their tests) keep
 * resolving against the service module.
 *
 * Deliberately dependency-free — no `db`, no schema import — so a job can
 * import it without dragging in a query builder.
 */

/**
 * Resolve the DJ display name shown to listeners on the public flowsheet.
 *
 * Rules:
 *   1. Use `djName` (the user's stage handle on `auth_user.dj_name`).
 *   2. Treat the literal string "Anonymous" (case- and whitespace-insensitive)
 *      as if `djName` were absent. The better-auth anonymous plugin and a
 *      since-corrected onboarding default were both observed writing the
 *      literal "Anonymous" into `auth_user.dj_name`; rendering that string
 *      to the public on-air playlist confused listeners and the wxyc.info
 *      playlist (BS#1286, epic #1288, 2026-06-02 Aubrey Hearst on-air
 *      incident).
 *   3. Trim the returned value; return `null` if blank or Anonymous.
 *
 * Why this doesn't fall back to `auth_user.name`: `auth_user.real_name` is
 * the sole legal-name carrier (PII, see docs/pii.md) and is never an input
 * to this chain. `auth_user.name` is a derived display handle/username
 * (backfill: jobs/auth-user-name-backfill) — redundant with, not
 * authoritative over, `djName`/`legacy_dj_name` here, so this chain reads
 * the canonical fields directly rather than the derived display column.
 *
 * Callers should treat `null` as "name is unresolvable" and either degrade
 * the marker template (show_start / show_end keep a row but drop the name)
 * or suppress the row entirely and log to Sentry (dj_join / dj_leave) —
 * see `startShow`, `endShow`, `createJoinNotification`,
 * `createLeaveNotification`.
 */
export const resolveDjDisplayName = (djName: string | null): string | null => {
  const trimmedDjName = djName?.trim() ?? '';
  if (trimmedDjName.length > 0 && trimmedDjName.toLowerCase() !== 'anonymous') {
    return trimmedDjName;
  }
  return null;
};

/**
 * The first link of the chain, on its own: a usable per-show override, or null.
 *
 * Shared with `resolveDjNameForShow`, which needs to know whether the
 * override wins BEFORE deciding to spend a query on the user row. Exported as
 * one function rather than re-tested there, so the rule that decides what
 * reaches a public wire has exactly one definition.
 */
export const showDjNameOverride = (dj_name_override: string | null): string | null => {
  const override = (dj_name_override ?? '').trim();
  return override.length > 0 ? override : null;
};

/**
 * The PII-safe show-DJ resolution chain (BS#1371), as a pure decision:
 * per-show override -> the linked user's public handle -> the legacy
 * tubafrenzy handle -> null. Never the real-name column, which is
 * structurally impossible here — it is not an input.
 *
 * Originally extracted from `resolveDjNameForShow` so the windowed read
 * (`getShowsInTimeWindow`, BS#2062) could apply the identical chain to a user
 * row it JOINed in, instead of re-deriving it or paying one query per show.
 * Now also the chain every `jobs/` writer must use.
 *
 * `user: null` means the show's `primary_dj_id` resolved to no row at all,
 * which is distinct from a row whose `djName` is unusable — see the
 * asymmetric legacy handling below, preserved verbatim from the original.
 */
export const resolveShowDjName = (input: {
  dj_name_override: string | null;
  legacy_dj_name: string | null;
  primary_dj_id: string | null;
  user: { djName: string | null } | null;
}): string | null => {
  const override = showDjNameOverride(input.dj_name_override);
  if (override !== null) return override;

  const legacy = input.legacy_dj_name;
  if (input.primary_dj_id == null) return legacy;
  // No user row: return the legacy handle as-is. Deliberately NOT trimmed,
  // unlike the branch below — preserved from the pre-extraction behaviour so
  // this refactor cannot change a single byte on the existing wire.
  if (input.user == null) return legacy;

  const filteredDjName = resolveDjDisplayName(input.user.djName ?? null);
  if (filteredDjName) return filteredDjName;
  if (legacy && legacy.trim().length > 0) return legacy.trim();
  return null;
};

/**
 * The `auth_user.name` policy — on-air handle, else `username` — in one
 * place. Three call sites derived this chain independently (`apps/auth/
 * provision-user.ts`, the `databaseHooks.user.create.before` hook, and the
 * `auth-user-name-backfill` job's rewrite-target computation); consolidated
 * here so the policy has exactly one definition, same reasoning as
 * `resolveDjDisplayName` and `resolveShowDjName` above.
 *
 * MICRO-BEHAVIOR CHANGE: the username link trims and blanks a whitespace-only
 * `username`, converging on the mirror's documented contract (PR #2292).
 * Every current writer validates `username` against `/^[a-zA-Z0-9_.]+$/`
 * before it reaches any of these call sites, so a whitespace-only username is
 * unreachable through normal writes — this only changes behavior for a
 * manually-edited legacy row that already holds one.
 *
 * CREATE/BACKFILL-ONLY: this helper is for the create and backfill paths
 * only. `databaseHooks.user.update.before` (`deriveOrRejectUserNameOnUpdate`
 * in `derive-user-display-name.ts`) deliberately calls `resolveDjDisplayName`
 * directly and does NOT fall back to `username` — an update payload carrying
 * only `username` cannot reveal whether the user currently has a live
 * handle, so deriving from it there risks clobbering one. Do not "fix" the
 * update hook to use this helper; see that file's docblock for the full
 * reasoning.
 */
export const deriveUserPublicName = (djName: string | null, username: string | null): string | null => {
  const handle = resolveDjDisplayName(djName);
  if (handle !== null) return handle;
  const trimmed = username?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};
