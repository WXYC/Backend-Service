import { sql, type SQL } from 'drizzle-orm';
import { rotation, flowsheet, library, artists } from '@wxyc/database';

/**
 * Resolve a played entry's rotation bin (BS#2698, extracted verbatim from
 * `flowsheet.service.ts`'s `FSEntryFieldsRaw.rotation_bin`). Full historical
 * rationale — the BS#2080 UNION-ALL-vs-OR index story, the BS#2183 windowing
 * decision, the arm-3 guard-tightening near-miss — lives in `git log -p` on
 * that field's pre-move history; this header states the contract a caller
 * needs, not the archaeology.
 *
 * PRECONDITION: the caller must `.leftJoin(rotation, eq(rotation.id,
 * flowsheet.rotation_id))` before selecting this fragment — it reads
 * `rotation.rotation_bin` directly for its primary lane, with no join
 * embedded in the fragment itself (only the fallback subquery's own aliased
 * `rotation`/`library`/`artists` reads are self-contained). Omitting the join
 * surfaces as a Postgres `relation "rotation" does not exist` at request
 * time, not at compile time; `tests/unit/utils/sql-rotation-bin.test.ts`
 * guards it by asserting the compiled text references `"rotation"."rotation_bin"`.
 *
 * Primary source is that FK join — unwindowed by design (BS#2183): an
 * explicit `rotation_id` is a writer's assertion and outranks date
 * arithmetic. Fallback fires only when the join misses (`rotation_id IS
 * NULL`) and the entry has a non-empty artist+album, and IS windowed against
 * the entry's `add_time` (`add_date <= add_time` and `kill_date IS NULL OR
 * kill_date > add_time`) because it is an inference, not an assertion. Three
 * match cohorts, each a separately-indexable UNION ALL arm (migration 0145)
 * rather than an OR, which the per-arm indexes cannot serve (measured
 * 224,554 buffers / 1,317.8ms vs. 12,509 / 4.6ms over 1,030 real rows):
 *   (a) flowsheet.album_id matches an active rotation.album_id (library-linked rotation rows);
 *   (b) (artist, album) snapshot matches active rotation row's denormalized fields
 *       (library-unlinked rotation rows hold the snapshot directly);
 *   (c) (artist, album) matches the library+artists join on an active rotation row's
 *       album_id (library-linked rows whose denorm fields are NULL).
 * `ORDER BY t.id LIMIT 1` ties toward the oldest active matching rotation
 * row. Keep each arm's `lower(trim(coalesce(col, '')))` expression
 * character-for-character identical to its index (`schema.ts` /
 * `tests/unit/database/schema.rotation-bin-fallback-idx.test.ts`), and keep
 * the outer guard untrimmed (`coalesce(col, '') <> ''`) — it gates all three
 * arms, and arm 1 matches on `album_id` alone without reading the text.
 *
 * FIVE call sites carry this decision. Four are `flowsheet.service.ts`'s
 * `.leftJoin(rotation, ...)` sites (getEntriesByPage, getEntriesByRange,
 * getEntriesInTimeWindow, getEntriesByShow) via the shared
 * `FSEntryFieldsRaw.rotation_bin`, which now points at this module. The
 * fifth, `playlist-proxy.service.ts`'s `fetchRecentRows` /
 * `resolveFallbackRotation`, runs the same cohorts and window in a batched
 * `WITH cand(...) / active_rot AS MATERIALIZED` form and is deliberately NOT
 * unified with this fragment — folding it in is a different, larger piece of
 * work. Keep all five in step regardless: changing one and not its twins is
 * the BS#2088 failure mode, and the cross-file fifth is the one most easily
 * missed.
 */
export const ROTATION_BIN_EXPR: SQL<string | null> = sql`
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
