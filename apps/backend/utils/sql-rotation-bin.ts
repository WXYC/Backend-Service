import { sql, type SQL } from 'drizzle-orm';
import { rotation, flowsheet, library, artists } from '@wxyc/database';

/**
 * Resolve a played entry's rotation bin. This is the `rotation_bin` field of
 * `flowsheet.service.ts`'s `FSEntryFieldsRaw`, and the one shared source for
 * any other read that needs the same badge.
 *
 * PRECONDITION: the statement that selects this fragment must
 * `.leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))`. The primary
 * lane reads `rotation.rotation_bin` from that join; the fragment embeds no
 * join of its own (only the fallback subquery's aliased `r2`/`l2`/`a2` reads
 * are self-contained). Nothing catches an omitted join at compile time. It
 * surfaces at request time as a Postgres error whose text depends on how the
 * statement renders its columns:
 *   - table-qualified — any drizzle select with at least one join, or a raw
 *     `sql` template: `missing FROM-clause entry for table "rotation"`;
 *   - bare — a single-table drizzle select (`.select({...}).from(flowsheet)`
 *     and no join), where drizzle strips the table qualifier from every column
 *     of an `sql` field: `column "rotation_bin" does not exist`. That mode
 *     hides a second hazard: the correlated `flowsheet.*` references inside
 *     the fallback subquery also render bare and rebind to `r2`'s same-named
 *     columns (`r2.album_id = "album_id"` becomes a tautology). The only thing
 *     keeping it loud is that `flowsheet` has no `rotation_bin` column.
 * Every statement that selects this fragment is rendered and checked for the
 * join in `tests/unit/services/flowsheet.rotationBin.sql.test.ts`, which also
 * fails when a module it does not list imports this one — a new caller adds
 * its statement there.
 *
 * A FUNCTION, NOT A SHARED CONSTANT: drizzle's `SQL` is mutable —
 * `append()`, `mapWith()` and `inlineParams()` modify the instance and return
 * `this` — so one exported instance would let any importer silently change
 * how every other caller renders or decodes the badge. Each call returns a
 * fresh instance. `FSEntryFieldsRaw` calls it once, at module load, so its
 * four read paths share one instance exactly as they did when the expression
 * was written inline there.
 *
 * Primary source is the FK join (`leftJoin(rotation, rotation.id = flowsheet.rotation_id)`).
 * Fallback fires only when that join misses (rotation.rotation_bin IS NULL) and the entry
 * looks like a real track with non-empty artist+album. Three match cohorts:
 *   (a) flowsheet.album_id matches an active rotation.album_id (library-linked rotation rows);
 *   (b) (artist, album) snapshot matches active rotation row's denormalized fields
 *       (library-unlinked rotation rows hold the snapshot directly);
 *   (c) (artist, album) matches the library+artists join on an active rotation row's
 *       album_id (library-linked rows whose denorm fields are NULL).
 * This fallback's window is bounded on BOTH sides against the flowsheet entry's add_time so
 * historical rotation status is preserved: add_date <= add_time (inclusive lower bound —
 * a play that aired before the release entered rotation is not badged; BS#1526) and
 * kill_date IS NULL OR kill_date > add_time (exclusive upper bound). Mirrors how tubafrenzy
 * classifies at mirror time (WXYC/dj-site#750).
 *
 * That window governs the FALLBACK SUBQUERY ONLY. The primary FK join above has no date
 * window at all — an entry carrying rotation_id gets that rotation record's CURRENT
 * rotation_bin regardless of when the entry aired, even past the record's own kill_date.
 * This is deliberate (BS#2183): an explicit rotation_id is a first-class assertion by the
 * writer (BS#1268 stamps it from the tubafrenzy webhook; the dj-site rotation picker emits
 * it), and a writer's assertion outranks date arithmetic. The fallback is windowed precisely
 * because it is an inference, not an assertion. Measured prod blast radius (2026-08-17,
 * 6,290 FK-joined entries): 0 played before add_date, 9 played on/after kill_date — and all
 * 9 are same-day artifacts (add_time::date == kill_date, played in the morning and killed
 * that afternoon) that a half-open bound would flip the wrong way.
 *
 * If you window the FK join anyway, note what actually happens: the fallback does NOT take
 * over. Its CASE is gated on flowsheet.rotation_id IS NULL, not on rotation.rotation_bin
 * IS NULL — so an out-of-window row whose rotation_id is still populated falls out of the
 * primary lane AND is refused by the fallback, and COALESCE yields no badge at all rather
 * than the windowed badge you were reaching for. Windowing the join therefore means
 * re-gating the CASE too, which is a different and larger change than it looks.
 *
 * FIVE call sites carry this decision. Four are the `.leftJoin(rotation, ...)` sites in
 * `flowsheet.service.ts` (getEntriesByPage, getEntriesByRange, getEntriesInTimeWindow,
 * getEntriesByShow), which all select this fragment through `FSEntryFieldsRaw.rotation_bin` —
 * this module is their one shared source. The fifth is outside that file:
 * `playlist-proxy.service.ts`'s window query runs the same unwindowed FK lane against a
 * windowed post-slice fallback (`resolveFallbackRotation`), so the decision governs it
 * identically. That fallback is NOT this fragment, and was deliberately not unified with it: it
 * is a batched `WITH cand(...) / active_rot AS MATERIALIZED` form with `DISTINCT ON (cand.fid)`
 * — the same three cohorts and the same window, resolved in bulk rather than per row — and
 * folding it in is a different, larger piece of work. Keep all five in step — changing one
 * and not its twins is the BS#2088 failure mode, and the cross-file fifth is the one most
 * easily missed.
 *
 * Subquery only fires per-row on a missed FK join; on rows with a populated rotation_id
 * COALESCE short-circuits and the subquery is not evaluated.
 *
 * Tie-break (`ORDER BY t.id` over the union): the schema source comment at `rotation` explicitly
 * permits multiple active rows per (album_id, rotation_bin) over an album's lifecycle
 * (re-bins, re-adds, label-driven re-promotes). Picking the lowest `id` (oldest active
 * row) is a deliberate, stable choice for the badge UX — when an album has been re-binned
 * L → M, the badge reports its original cohort rather than flipping retroactively. This
 * matches the historical-correctness story above (add_date/kill_date window filtered against add_time).
 * The primary FK join via flowsheet.rotation_id remains canonical when present.
 *
 * SHAPE (BS#2080): the three match cohorts are a UNION ALL of three
 * separately-indexable probes, NOT an OR over one joined set. They were an
 * OR until the range read (BS#2062) made the per-row cost visible. Because
 * the OR spanned three tables, no index on any one of them could serve it —
 * the planner had to materialize the whole rotation-library-artists join and
 * filter afterwards, at 239 buffers and ~11.7ms cold per row. Prod response
 * time on `GET /flowsheet/range` fit `1.125s + 19.0ms * n_fallback`
 * (R^2=0.957) and the 7-day window (1,030 fallbacks, ~20.7s predicted) blew
 * the 5s statement timeout outright. Over those same 1,030 rows:
 * 224,554 buffers / 1,317.8ms -> 12,509 buffers / 4.6ms. Every arm is now an
 * index scan. Verified equivalent, not assumed: both forms run over all
 * 1,030 rows produced zero disagreements.
 *
 * Do not fold these arms back into an OR for readability. The three indexes
 * (migration 0145) only apply per-arm, and the OR form cannot use them.
 * Likewise, keep each arm's expression character-for-character identical to
 * its index — `lower(trim(coalesce(col, '')))` — or the planner silently
 * reverts to the seq scan this shape exists to avoid.
 *
 * ORDER BY over the union is `t.id`, preserving the original's `ORDER BY
 * r2.id LIMIT 1`: lowest matching rotation id wins, same tie-break, same
 * result. A row matching two arms appears twice in the union, which the
 * LIMIT 1 makes harmless.
 *
 * GUARD: unchanged — still `coalesce(col, '') <> ''`, NOT a trimmed variant.
 *
 * An earlier revision of BS#2080 tightened it to `trim(coalesce(col, ''))
 * <> ''` to make arm 3's inner JOIN provably equivalent to the LEFT JOIN it
 * replaced. That was wrong, and the way it was wrong is worth recording: the
 * guard gates ALL THREE arms, but the whitespace argument only ever applied
 * to arm 3. An entry with a real artist, a blank-but-non-empty album title
 * ('   ') and a populated `album_id` matches arm 1 on `album_id` alone —
 * arm 1 never looks at the text — so tightening a TEXT guard silently
 * dropped a legitimate badge. Verified against the clone: album_id 36962
 * returned 'M' under the original guard and nothing under the tightened one.
 *
 * One further reason to leave it alone: PG's `trim()` strips only ASCII
 * space, so it would not have caught the NBSP/tab cases the word
 * "whitespace" implies anyway.
 *
 * A second reason has now expired, and is recorded so it is not mistaken for
 * a live constraint. `isActiveRotationMatch` — the mirror's write-path twin,
 * kept in sync with this guard at the cohort/predicate level — was deleted
 * with the outbound mirror in BS#2403. There is no longer a second predicate
 * to fork, so the sync argument no longer forbids anything. The verified
 * counter-example above (album_id 36962) is the reason that still stands on
 * its own, and it is sufficient: do not tighten this guard on the strength
 * of the twin being gone.
 *
 * What remains is one narrow difference, and it is very hard to observe. For
 * an entry whose artist AND album both trim to '', arm 3's original LEFT JOIN
 * matched the NULL side of every active rotation row lacking a library link;
 * the inner JOIN below does not. But arm 2 usually reaches the same rows
 * first: a library-LINKED rotation row carries NULL denormalized names, which
 * `coalesce(..., '')` turns into '', so arm 2 already matches any blank entry
 * whenever such a row is active — the common case. The divergence therefore
 * needs a window containing a library-LESS active row with non-blank names
 * and NO blank-named row at all. Zero such cases in a 7-day prod diff over
 * 1,030 rows; the integration spec pins the shadowing rather than the
 * divergence, because its fixtures cannot produce the latter either.
 */
export function rotationBinExpr(): SQL<string | null> {
  return sql`
    COALESCE(
      ${rotation.rotation_bin},
      CASE WHEN ${flowsheet.rotation_id} IS NULL
        AND coalesce(${flowsheet.artist_name}, '') <> ''
        AND coalesce(${flowsheet.album_title}, '') <> ''
      THEN (
        SELECT t.rotation_bin FROM (
          -- (a) library-linked rotation rows, matched on album_id (album_id_idx).
          --     There is deliberately no "album_id IS NOT NULL" guard here:
          --     SQL equality against NULL is NULL, never true, so a free-form
          --     entry already matches nothing. That guard was inherited from
          --     the OR form, where it was equally redundant. Removing it was
          --     verified equivalent over 1,030 real rows plus a synthetic
          --     NULL-album_id row: 0 disagreements, identical buffers.
          --     (No backticks in this template -- they close the sql tag.)
          SELECT r2.id, r2.rotation_bin
          FROM ${rotation} r2
          WHERE r2.album_id = ${flowsheet.album_id}
            AND r2.add_date <= ${flowsheet.add_time}::date
            AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
          UNION ALL
          -- (b) library-unlinked rotation rows holding the (artist, album)
          --     snapshot directly (rotation_norm_artist_album_idx)
          SELECT r2.id, r2.rotation_bin
          FROM ${rotation} r2
          WHERE lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
            AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
            AND r2.add_date <= ${flowsheet.add_time}::date
            AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
          UNION ALL
          -- (c) library-linked rotation rows whose denorm fields are NULL, so
          --     the names come from the library+artists join
          --     (library_norm_album_title_idx -> album_id_idx -> artists_norm_name_idx)
          SELECT r2.id, r2.rotation_bin
          FROM ${rotation} r2
          JOIN ${library} l2 ON l2.id = r2.album_id
          JOIN ${artists} a2 ON a2.id = l2.artist_id
          WHERE lower(trim(coalesce(a2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
            AND lower(trim(coalesce(l2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
            AND r2.add_date <= ${flowsheet.add_time}::date
            AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
        ) t
        ORDER BY t.id
        LIMIT 1
      )
      END
    )
  `;
}
