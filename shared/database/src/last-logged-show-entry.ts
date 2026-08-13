/**
 * "The last row we LOGGED for this show" — the show-scoped
 * `WHERE show_id = ? ORDER BY id DESC LIMIT 1` idiom, factored into one
 * place (BS#2118 sites 5/7/8).
 *
 * Named for insertion order on purpose. The four copies this replaces were
 * each commented as finding the "newest" entry, and BS#2118 exists because
 * that word was read as *chronological* when the query only ever delivered
 * *insertion* order. `lastLogged` is the semantics these callers actually
 * want and actually get.
 *
 * CALL SITES (all preserved byte-identically — this is a pure consolidation,
 * not a behavior change):
 *   - `apps/backend/services/flowsheet.service.ts`'s `isLatestEntryShowEnd`
 *     (BS#2118 site 5) — query-builder `.orderBy(...)`. Uses
 *     {@link lastLoggedShowEntryOrderBy}.
 *   - `apps/backend/services/flowsheet.service.ts`'s
 *     `closeShowFromTerminalShowEndMarker` (site 7) — two raw-`sql`
 *     correlated subqueries in an UPDATE...WHERE context, where an unaliased
 *     `${flowsheet.column}` renders fully-qualified. Uses
 *     {@link lastLoggedShowEntryOrderBySql} with no alias.
 *   - `jobs/legacy-mirror-reconcile/orchestrate.ts`'s `selectStaleOpenShows`
 *     (site 8) — the same raw-`sql` shape but inside a `.select({...})`
 *     PROJECTION, where an unaliased interpolation renders BARE and can
 *     self-correlate against the subquery's own `flowsheet` scope instead of
 *     the outer table. Uses {@link lastLoggedShowEntryOrderBySql} with an
 *     explicit alias (`'fe'` there).
 *
 * Lives in `@wxyc/database`, not `apps/backend`, because
 * `jobs/legacy-mirror-reconcile` is a separate npm workspace whose Dockerfile
 * copies only its own directory plus this package — an `apps/backend` import
 * fails that build stage. Same shape as the `concerts-recompute.ts` (BS#1763)
 * and `album-resolve.ts` (BS#1829) extractions.
 *
 * ── WHY `id DESC` AND NOT `play_order DESC` ──
 *
 * `changeOrder` renumbers `play_order` for track reordering within a show.
 * These callers must answer "what did we log last", not "what does the DJ
 * currently want listed last". Marker rows are never reordered, so the two
 * agree for the marker question in practice — but only `id` is stable under
 * a reorder. Contrast `getEntriesByShow` (`flowsheet.service.ts`), where
 * `play_order` IS the right primary key because that query renders the DJ's
 * chosen order.
 *
 * ── WHY `id DESC` AND NOT `add_time DESC`, EVEN THOUGH THE PAGE READS MOVED ──
 *
 * BS#2118 established that `flowsheet.id` is insertion order, not airtime
 * order: a historical insert (backfill, gap import, repair) takes the highest
 * id in the table while carrying an `add_time` from whenever it actually
 * aired. BS#2132 and BS#2133 moved `/playlists/recentEntries` and
 * `getEntriesByPage` to `(add_time DESC, id DESC)` for exactly that reason.
 *
 * These three call sites deliberately did NOT move, and the difference is not
 * inconsistency — it is the different question they ask. The page reads are
 * display surfaces that want AIRTIME. These are control-flow gates that ask
 * "is this show's last row the sign-off marker?", and for that question
 * insertion order is not an approximation of the right answer, it IS the
 * right answer: the marker is written last, so it holds the highest id by
 * construction.
 *
 * Switching them to `add_time` would trade a rare failure for a likelier one.
 * Per `getEntriesByPage`'s clock-mixing comment, the tubafrenzy webhook
 * (`apps/backend/routes/internal.route.ts`) writes `add_time` from
 * `entry.startTime` — tubafrenzy's EVENT clock — for rows that carry a
 * non-zero one, which per the BS#351 gap-import findings is `show_start` /
 * `show_end` markers; ordinary track rows have `startTime = 0` and fall
 * through to `new Date()`, Backend's DELIVERY clock. So markers and tracks in
 * the same show can be timestamped from two different clocks whose divergence
 * is unbounded (tubafrenzy delivery lag), not sub-second. On a lag exceeding
 * the gap between a show's final track and its sign-off, the TRACK carries
 * the later `add_time` and would sort above the marker — these gates would
 * then misfire on ordinary network lag rather than on a historical import.
 *
 * WHAT THAT ACCEPTS. Each caller inherits the false premise BS#2118 named: a
 * historical insert into a show DOES take the highest id and DOES make these
 * queries report it as the last-logged row. The per-site consequences and why
 * each is bounded are documented at the call sites (site 5 is gated by
 * `joinShow`'s own `end_time` short-circuit; site 7 is bounded by
 * `WHERE end_time IS NULL` to "never closes", never "closes wrong"; site 8
 * loses its sign-off escape hatch for the affected show). This is an accepted
 * exposure with a documented operator constraint — historical imports run
 * outside a live window — not an unnoticed one.
 *
 * If a future caller genuinely needs "the row that aired most recently",
 * that is a different query: order by `add_time` with `id` as its own
 * tie-break (`add_time` defaults to `now()` = `transaction_timestamp()`, so
 * rows written by one statement share it), and it should NOT reuse these
 * helpers.
 */
import { desc, sql, type SQL } from 'drizzle-orm';
import { flowsheet } from './schema.js';

/**
 * Query-builder ORDER BY terms for "last row logged for this show".
 * Spread into a drizzle `.orderBy(...)`:
 * `.orderBy(...lastLoggedShowEntryOrderBy())`.
 *
 * A function rather than a module-level constant so the `desc(...)` call is
 * deferred to call time, keeping this module side-effect-free at import —
 * which matters because `tests/mocks/database.mock.ts` auto-mocks
 * `drizzle-orm` for some unit suites and not others.
 */
export function lastLoggedShowEntryOrderBy(): readonly [SQL] {
  return [desc(flowsheet.id)];
}

/**
 * Reject anything that isn't a plain unquoted SQL identifier before it
 * reaches {@link sql.raw}.
 *
 * `sql.raw` concatenates rather than parameterizes, and this module is
 * exported from `@wxyc/database` to every workspace, so `alias` is a public
 * raw-SQL sink. Today's only caller passes the literal `'fe'`, so there is
 * nothing live to exploit; the guard is what keeps that true for the next
 * caller, and ESLint's `security/detect-*` rules do not see through the
 * `sql.raw` indirection to flag it.
 */
function assertSafeSqlIdentifier(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(
      `lastLoggedShowEntryOrderBySql: unsafe SQL alias ${JSON.stringify(alias)} — ` +
        `expected a plain unquoted identifier (letters, digits, underscores; not starting with a digit).`
    );
  }
}

/**
 * Raw-SQL ORDER BY tail for a correlated subquery selecting a show's
 * last-logged row — `id DESC`, matching {@link lastLoggedShowEntryOrderBy}.
 *
 * With no `alias`, interpolates the real `flowsheet` column object, which
 * renders fully-qualified in a WHERE-clause context (site 7's shape).
 *
 * With `alias`, emits an alias-qualified bare identifier (`<alias>.id DESC`)
 * instead — required inside a `.select({...})` projection subquery, where an
 * unaliased `${flowsheet.id}` renders BARE and Postgres resolves it against
 * the subquery's own scope rather than the caller's intended outer table
 * (site 8's self-correlation hazard; see that call site's comment). The
 * caller must alias `flowsheet` to the same string in its own FROM clause —
 * this builds only the ORDER BY tail, not the FROM.
 */
export function lastLoggedShowEntryOrderBySql(alias?: string): SQL {
  if (alias) {
    assertSafeSqlIdentifier(alias);
    return sql`${sql.raw(alias)}.id DESC`;
  }
  return sql`${flowsheet.id} DESC`;
}
