import { resolveDjDisplayName } from '@wxyc/database';

/**
 * The single choke point for `auth_user.name`: pure `databaseHooks.user`
 * before-hook helpers that derive `name` from the on-air handle
 * (`auth_user.dj_name`) or `username`, never from a legal name.
 *
 * DJ real-name PII safeguards plan, Track 2b. Wired into
 * `databaseHooks.user.create.before` / `update.before` in `auth.definition.ts`.
 *
 * Two verified constraints from better-auth's `db/with-hooks.mjs` (v1.6.26,
 * the lockfile-resolved version) shape both functions here:
 *
 * 1. **The `{ data }` merge contract is load-bearing, not style.**
 *    `createWithHooks`/`updateWithHooks` call `toRun(data, context)` and only
 *    merge a returned value that satisfies `typeof result === 'object' &&
 *    'data' in result` — `actualData = { ...actualData, ...result.data }`.
 *    A mutated `data` argument, a bare object, or any shape other than
 *    `{ data: {...} }` is silently discarded: the hook appears to run but the
 *    write proceeds with the original payload. `false` aborts the write
 *    entirely. So `undefined` is the only correct "no-op" return — not `{}`,
 *    not a mutated argument.
 *
 * 2. **`update.before` never receives the user id.** `internalAdapter
 *    .updateUser(userId, data)` builds `where: [{ field: 'id', value: userId
 *    }]` itself and calls `updateWithHooks(data, where, 'user', ...)` — the
 *    hook only ever sees `toRun(data, context)`, never `where`. There is no
 *    row fetch available inside an `update.before` hook, by construction.
 *    `complete-onboarding.ts`'s `internalAdapter.updateUser` call (outside
 *    any better-auth endpoint) goes through the identical path, so a
 *    request-context fallback isn't available there either.
 *
 * Constraint 2 is why `deriveUserNameOnUpdate` is payload-only: it can only
 * ever answer "does THIS update's own `djName` resolve to a usable handle?",
 * never "what is this user's handle right now?". Two update shapes are
 * therefore deliberately left untouched rather than guessed at:
 *
 *   - **Handle-clear** (`djName` present but blank/'Anonymous'): the prior
 *     `name` — itself already a handle or a username post-backfill — stays.
 *   - **Username-only rename** (no `djName` key in the payload at all): a
 *     username-only payload can't reveal whether the user currently has a
 *     handle, so deriving from `username` here risks clobbering a live
 *     handle with the new username. `name` stays at its prior value.
 *
 * Both are cosmetic staleness, not a PII regression: after the 2d backfill,
 * whatever `name` was already holding is structurally non-PII (an earlier
 * handle or an earlier username), never a legal name. The sentinel spec
 * (Track 3b) is what actually polices the PII half of this invariant going
 * forward.
 */

/**
 * `databaseHooks.user.create.before`.
 *
 * The full create payload is present (unlike `update.before`), so the chain
 * is a straight priority order: on-air handle, else `username`, else keep
 * whatever `name` the caller supplied. The final fallback is deliberate —
 * it's how the literal `'Anonymous'` (better-auth's anonymous plugin) and
 * `'Auto DJ'` (`create-auto-dj-user.ts`) survive this hook unclobbered:
 * neither has a resolvable handle or a `username`, so `derived` lands back
 * on the supplied `name` and the no-op branch below fires.
 */
export function deriveUserNameOnCreate(
  data: { name: string; username?: string | null; djName?: string | null } & Record<string, unknown>
): { data: { name: string } } | undefined {
  // `?? null` coercion is pinned here, same as Track 0's http-mirror.ts call:
  // resolveDjDisplayName is typed `(djName: string | null)` and djName is
  // optional on this payload shape under the package's `strict: true`.
  const derived = resolveDjDisplayName(data.djName ?? null) ?? data.username ?? data.name;
  if (derived === data.name) return undefined;
  return { data: { name: derived } };
}

/**
 * `databaseHooks.user.update.before`.
 *
 * Payload-only by construction — see constraint 2 above. Derives a new
 * `name` only when THIS update's own payload carries a `djName` key that
 * resolves to a usable handle. Any other shape (`djName` absent, blank, or
 * the literal `'Anonymous'`) is left untouched: see the handle-clear /
 * username-only-rename note above for why that's the correct call, not a
 * missed case.
 */
export function deriveUserNameOnUpdate(
  data: { djName?: string | null } & Record<string, unknown>
): { data: { name: string } } | undefined {
  if (!('djName' in data)) return undefined;
  const handle = resolveDjDisplayName(data.djName ?? null);
  if (handle === null) return undefined;
  return { data: { name: handle } };
}
