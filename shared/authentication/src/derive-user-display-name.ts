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
 *
 * Both "left untouched" shapes above assume the payload does NOT also carry
 * a bare `name` key. When it does, `deriveUserNameOnUpdate` rejects the
 * write outright (`false`) rather than leaving `name` untouched — see that
 * function's docblock for the full rejection policy (BS#2297 review finding
 * 1). better-auth's public `POST /update-user` accepts a client-supplied
 * `name` for any signed-in session; without the rejection, a name-only
 * payload would fall through this hook as a no-op and better-auth would
 * write the client-supplied `name` verbatim, re-opening the exact hole this
 * plan closes.
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
 *
 * REJECTION POLICY (BS#2297 review finding 1): better-auth's core
 * `POST /update-user` accepts a client-supplied `name` from any signed-in
 * session (`api/routes/update-user.mjs`: `const { name, image, ...rest } =
 * body`) and writes it verbatim once it reaches the adapter. Before this
 * policy, a name-only payload fell through to the "no djName key" branch
 * and returned `undefined` — a no-op from this hook's point of view — so
 * better-auth wrote the client-supplied `name` straight to the database,
 * re-creating exactly the hidden-legal-name-copy state this plan exists to
 * close (`auth_user.name` silently holding a legal name again).
 *
 * So: any payload that carries a `name` key is now rejected with `false`
 * unless it ALSO carries a `djName` that resolves to a usable handle — in
 * which case the returned `{ data: { name: handle } }` overrides the
 * client-supplied `name` via updateWithHooks's merge order (constraint 1
 * above: `actualData = { ...actualData, ...result.data }`, hook result
 * spread after actualData). `false` tells better-auth's `updateWithHooks`
 * to abort the write entirely (`with-hooks.mjs`: `if (result === false)
 * return null`) — the row is never touched, not even for other fields in
 * the same payload. This is deliberately broader than "just don't derive
 * from it": a payload carrying `name` alongside a blank/'Anonymous' djName
 * is also rejected, closing the trivial bypass of attaching an unusable
 * djName to a bare-name payload to slip past the rejection.
 *
 * Direct writes to `name` are prohibited categorically, not case-by-case:
 * after this program's PRs, no legitimate writer sends bare `name` on
 * update (dj-site's roster editing sends `realName`/`djName` only;
 * onboarding sends `realName`/`djName`; provisioning is a `create`, not an
 * `update`, and is covered by `deriveUserNameOnCreate` instead). A
 * `name`-carrying update payload reaching this hook is therefore always
 * either a stale/misbehaving caller or an attempted direct write — reject
 * it rather than silently accept or silently drop just the `name` field
 * (better-auth's hook contract has no "drop one field" return shape; the
 * only choices are override the whole payload's fate via `{ data }` or
 * abort via `false`).
 */
export function deriveUserNameOnUpdate(
  data: { name?: unknown; djName?: string | null } & Record<string, unknown>
): { data: { name: string } } | false | undefined {
  const hasName = 'name' in data;
  if (!('djName' in data)) {
    return hasName ? false : undefined;
  }
  const handle = resolveDjDisplayName(data.djName ?? null);
  if (handle === null) {
    return hasName ? false : undefined;
  }
  return { data: { name: handle } };
}
