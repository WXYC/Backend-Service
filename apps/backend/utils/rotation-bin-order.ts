import { sql } from 'drizzle-orm';

/**
 * Sort key that makes an `ORDER BY ... ASC` surface the HEAVIEST active
 * rotation bin, for use as the tie-break inside a `DISTINCT ON (id)` collapse.
 *
 * When an album has more than one active rotation row (e.g. H and M
 * simultaneously), a `DISTINCT ON (id)` dedup must keep the heaviest bin, not
 * the lightest. `rotation_bin`'s underlying `freq_enum` sorts S < L < M < H —
 * declaration order, which runs lightest to heaviest — so a bare
 * `rotation_bin ASC` keeps the lightest. This explicit CASE assigns H the
 * lowest ordinal so the `ASC` used at every DISTINCT-ON site surfaces the
 * heaviest bin instead.
 *
 * The `ELSE` is not a totality guard for a hypothetical: it is the hot path.
 * `library_artist_view` LEFT JOINs `rotation` (filtered to live rows), so
 * `rotation_bin` is NULL for every catalog album not currently in rotation —
 * the large majority — and `CASE NULL WHEN 'H' ...` falls through to 5 on all
 * of them. That is correct: a LEFT JOIN cannot produce both a NULL and a
 * non-NULL row for the same `id`, so ordinal 5 never competes inside a
 * `DISTINCT ON` group. Keep the `ELSE` regardless — without it the expression
 * yields NULL, which sorts last under the bare `ASC` used here but FIRST under
 * a `DESC`, a trap for any future caller that flips the direction.
 *
 * ## Why this lives in `utils/` rather than beside its first caller
 *
 * It was module-private in `library-search.service.ts` while `/library/query`
 * was its only consumer. It moved here when a second read path needed the same
 * tie-break, for the reason `utils/alias-hits.ts` and `utils/rotation-card.ts`
 * each give in their own docstrings: a fragment several read paths depend on
 * should have one definition, so the paths cannot drift on what it means.
 *
 * Not in `@wxyc/database`, deliberately. `shared/database/src/rotation-bin.ts`
 * is kept pure so `tests/mocks/database.mock.ts` can re-export it from source;
 * a drizzle `sql` fragment there would need a hand-written mock double and a
 * new `npm run check:db-mock-sync` surface for no benefit. The
 * `concerts-recompute.ts` / `dj-name.ts` precedent for promoting a helper into
 * the database package applies to consumers under `jobs/**`, and every
 * consumer of this one is an `apps/backend` service.
 *
 * ## The one thing a new caller must check
 *
 * This keys on the BARE column name `rotation_bin`, not a qualified reference,
 * so it only resolves inside an outer query over a subquery alias — which is
 * the shape all existing callers have (`SELECT DISTINCT ON (id) * FROM (...)
 * AS raw`). Dropped into a flat multi-table join it is unqualified against
 * every joined relation and resolves only by there happening to be exactly one
 * such column. A caller without a subquery needs a qualified variant rather
 * than this constant.
 *
 * `shared/database/src/rotation-bin.ts` records what duplicating this costs:
 * a fifth `freq_enum` member added in migration 0041 had to be removed from
 * eleven hand-written copies (BS#2173). Import it; do not retype it.
 */
export const ROTATION_BIN_DEDUP_ORDINAL = sql`CASE rotation_bin WHEN 'H' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'S' THEN 4 ELSE 5 END`;
