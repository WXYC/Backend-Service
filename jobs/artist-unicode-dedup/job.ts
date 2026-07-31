/**
 * One-shot dedup: merge pre-existing Unicode-form-duplicate `artists` rows
 * (BS#1897).
 *
 * The catalog write-boundary matcher (`artistIdFromName`) historically matched
 * on `lower(artist_name)` — collation-aware but NOT Unicode-form aware — so
 * `Nilüfer Yanya` in NFC (`ü` = U+00FC), NFD (`u` + U+0308), and the ASCII-fold
 * `Nilufer Yanya` were byte-distinct, missed each other, and each spawned a
 * separate `artists` row. Those duplicate rows silently partition `library`
 * rows across `artist_id`s and break reconciled-identity attachment.
 *
 * This job resolves the pre-existing duplicates. Migration 0134's matcher fix
 * (`fold_artist_name`) stops NEW ones; this pass merges the historical ones so
 * the matcher deterministically resolves each folded name to a single survivor.
 *
 * Grouping key: `wxyc_schema.fold_artist_name(artist_name)` — the exact fold the
 * matcher now uses, so post-dedup there is exactly one `artists` row per key the
 * matcher would treat as identical. Survivor = the lowest `id` in the group (the
 * oldest / most-likely-staff-curated row). Every FK that references `artists.id`
 * is repointed to the survivor BEFORE the duplicate row is deleted — the hard
 * data-safety invariant (never drop an FK-referenced row without repointing).
 * The survivor's name columns are then NFC-normalized so the surviving row is
 * itself canonical.
 *
 * FK sites repointed (every `references(() => artists.id)` in schema.ts):
 *   - library.artist_id                       (RESTRICT — the core partition)
 *   - genre_artist_crossreference.artist_id   (unique artist_id, genre_id)
 *   - artist_library_crossreference.artist_id (unique artist_id, library_id)
 *   - artist_crossreference.source_artist_id  (unique source, target)
 *   - artist_crossreference.target_artist_id  (unique source, target)
 *   - artist_search_alias.artist_id           (unique artist_id, source, variant)
 *   - artist_search_alias.related_artist_id   (SET NULL FK)
 *   - artist_similar_artists.artist_id        (PK artist_id)
 *   - artist_station_plays.artist_id          (PK artist_id)
 *   - concerts.headlining_artist_id           (SET NULL FK)
 *   - concert_performers.artist_id            (SET NULL FK)
 * Plus the 6 reconciled-identity columns ON the survivor row are COALESCE-filled
 * from the duplicates before deletion (survivor's own value always wins) so a
 * merge never silently discards an externally-resolved id a duplicate carried.
 *
 * DATA SAFETY / ops (docs/bulk-update-playbook.md):
 *   - **Dry-run by default; pass `--execute` to write.** Dry-run SELECTs and
 *     logs the affected set (survivor, duplicates, per-FK repoint counts) with
 *     zero writes.
 *   - Idempotent: a completed run leaves one row per fold-group, so a re-run
 *     finds no groups (`HAVING count(*) > 1`) and is a no-op.
 *   - Each group's repoints + delete + normalize run in a single transaction —
 *     a mid-run abort leaves each group either fully merged or untouched.
 *   - `ANALYZE` on the rewritten tables after an `--execute` run so the
 *     planner's stats stay on the index path (BS#934 lesson).
 *
 * Run procedure: Manual Build & Deploy with `target=artist-unicode-dedup`, then
 * SSH to EC2 and:
 *   docker run --rm --env-file .env <image>            2>&1 | tee log-dry
 *   docker run --rm --env-file .env <image> --execute  2>&1 | tee log-exec
 *
 * Environment: standard DB_* connection vars (same as the other one-shots).
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, closeDatabaseConnection, foldArtistName } from '@wxyc/database';

/** The transaction handle Drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default is dry-run; `--execute` opts into writes. */
export const EXECUTE = process.argv.includes('--execute');

/**
 * Schema-qualifier for raw SQL. `WXYC_SCHEMA_NAME` defaults to 'wxyc_schema';
 * `"`-escaped for the quoted-identifier case (mirrors the other job builders).
 */
export const schemaName = (): string => (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

const ident = (name: string): SQL => sql.raw(`"${name.replace(/"/g, '""')}"`);
const qualified = (table: string): SQL => sql.raw(`"${schemaName()}"."${table.replace(/"/g, '""')}"`);
const foldFn = (): SQL => sql.raw(`"${schemaName()}"."fold_artist_name"`);

/**
 * Every FK column that references `artists.id`. `uniqueKey` is the full
 * unique/PK key the column participates in (INCLUDING the column itself), or
 * `null` when no uniqueness constraint involves the column (a plain repoint can
 * never collide). When a repoint of a duplicate's row would collide with an
 * existing survivor row on the OTHER key columns, that duplicate row is dropped
 * instead of repointed (the survivor already carries the equivalent row).
 */
export interface FkTarget {
  table: string;
  column: string;
  uniqueKey: string[] | null;
}

export const FK_TARGETS: readonly FkTarget[] = [
  { table: 'library', column: 'artist_id', uniqueKey: null },
  { table: 'genre_artist_crossreference', column: 'artist_id', uniqueKey: ['artist_id', 'genre_id'] },
  { table: 'artist_library_crossreference', column: 'artist_id', uniqueKey: ['artist_id', 'library_id'] },
  { table: 'artist_crossreference', column: 'source_artist_id', uniqueKey: ['source_artist_id', 'target_artist_id'] },
  { table: 'artist_crossreference', column: 'target_artist_id', uniqueKey: ['source_artist_id', 'target_artist_id'] },
  { table: 'artist_search_alias', column: 'artist_id', uniqueKey: ['artist_id', 'source', 'variant'] },
  { table: 'artist_search_alias', column: 'related_artist_id', uniqueKey: null },
  { table: 'artist_similar_artists', column: 'artist_id', uniqueKey: ['artist_id'] },
  { table: 'artist_station_plays', column: 'artist_id', uniqueKey: ['artist_id'] },
  { table: 'concerts', column: 'headlining_artist_id', uniqueKey: null },
  { table: 'concert_performers', column: 'artist_id', uniqueKey: null },
];

/** The 6 nullable reconciled-identity columns carried ON the artists row. */
const IDENTITY_COLUMNS = [
  'discogs_artist_id',
  'musicbrainz_artist_id',
  'wikidata_qid',
  'spotify_artist_id',
  'apple_music_artist_id',
  'bandcamp_id',
] as const;

export interface DuplicateGroup {
  foldKey: string;
  survivorId: number;
  survivorName: string;
  duplicateIds: number[];
  /** `[id, name]` for each duplicate, for operator-legible logging. */
  duplicates: Array<{ id: number; name: string }>;
}

type GroupRow = {
  fold_key: string;
  ids: number[];
  names: string[];
};

/**
 * Find every fold-duplicate group: `artists` rows that share a
 * `fold_artist_name(artist_name)` key. `array_agg(... ORDER BY id)` makes the
 * survivor (element 0) deterministic. Ordered by the survivor id for stable,
 * resumable logging.
 */
export const findDuplicateGroups = async (): Promise<DuplicateGroup[]> => {
  const schema = qualified('artists');
  const fold = foldFn();
  const rows = (await db.execute(sql`
    SELECT
      ${fold}(artist_name)                    AS fold_key,
      array_agg(id ORDER BY id)               AS ids,
      array_agg(artist_name ORDER BY id)      AS names
    FROM ${schema}
    GROUP BY ${fold}(artist_name)
    HAVING count(*) > 1
    ORDER BY min(id)
  `)) as unknown as GroupRow[];

  return rows.map((r) => {
    const ids = r.ids.map(Number);
    const names = r.names;
    const [survivorId, ...duplicateIds] = ids;
    return {
      foldKey: r.fold_key,
      survivorId,
      survivorName: names[0],
      duplicateIds,
      duplicates: duplicateIds.map((id, i) => ({ id, name: names[i + 1] })),
    };
  });
};

/**
 * Count how many rows each FK site would repoint for a group (dry-run preview).
 * Pure SELECT — no writes. Mirrors the affected-set-first rule.
 */
export const previewGroup = async (group: DuplicateGroup): Promise<Record<string, number>> => {
  const dupList = intArrayLiteral(group.duplicateIds);
  const counts: Record<string, number> = {};
  for (const target of FK_TARGETS) {
    const t = qualified(target.table);
    const col = ident(target.column);
    const res = (await db.execute(sql`
      SELECT count(*)::int AS n FROM ${t} WHERE ${col} = ANY(${dupList}::int[])
    `)) as unknown as Array<{ n: number }>;
    const key = `${target.table}.${target.column}`;
    counts[key] = (counts[key] ?? 0) + Number(res[0]?.n ?? 0);
  }
  return counts;
};

/**
 * Repoint one FK site from `dup` → `surv` inside a transaction. For a
 * unique-keyed column, first drop the duplicate's rows that would collide with
 * an existing survivor row on the other key columns (the survivor already holds
 * the equivalent row), then repoint the remainder. Returns the rows repointed.
 */
const repointTarget = async (tx: Tx, target: FkTarget, dup: number, surv: number): Promise<number> => {
  const t = qualified(target.table);
  const col = ident(target.column);

  if (target.uniqueKey) {
    const otherCols = target.uniqueKey.filter((c) => c !== target.column);
    const matchClause =
      otherCols.length > 0
        ? sql.join(
            otherCols.map((c) => sql`k.${ident(c)} = d.${ident(c)}`),
            sql` AND `
          )
        : sql`TRUE`;
    await tx.execute(sql`
      DELETE FROM ${t} d
       WHERE d.${col} = ${dup}
         AND EXISTS (SELECT 1 FROM ${t} k WHERE k.${col} = ${surv} AND ${matchClause})
    `);
  }

  const res = await tx.execute(sql`UPDATE ${t} SET ${col} = ${surv} WHERE ${col} = ${dup}`);
  return Number(res.count ?? 0);
};

export interface MergeResult {
  survivorId: number;
  duplicatesMerged: number;
  fkRowsRepointed: number;
}

/**
 * Merge one group in a single transaction: repoint every FK site for each
 * duplicate, COALESCE-preserve the survivor's reconciled-identity columns from
 * the duplicates, drop `artist_crossreference` self-references the repoint
 * created, delete the duplicate rows, and NFC-normalize the survivor's name.
 */
export const mergeGroup = async (group: DuplicateGroup): Promise<MergeResult> => {
  let fkRowsRepointed = 0;

  await db.transaction(async (tx) => {
    for (const dup of group.duplicateIds) {
      // Preserve any externally-resolved identity the survivor lacks BEFORE the
      // duplicate is deleted (survivor's own non-null value always wins).
      const identitySet = sql.join(
        IDENTITY_COLUMNS.map((c) => sql`${ident(c)} = COALESCE(s.${ident(c)}, d.${ident(c)})`),
        sql`, `
      );
      const artistsTable = qualified('artists');
      await tx.execute(sql`
        UPDATE ${artistsTable} s
           SET ${identitySet}
          FROM ${artistsTable} d
         WHERE s.id = ${group.survivorId} AND d.id = ${dup}
      `);

      for (const target of FK_TARGETS) {
        fkRowsRepointed += await repointTarget(tx, target, dup, group.survivorId);
      }
    }

    // Repointing both endpoints of an artist_crossreference row can leave a
    // self-reference (surv, surv); drop those.
    const crossref = qualified('artist_crossreference');
    await tx.execute(sql`
      DELETE FROM ${crossref}
       WHERE source_artist_id = ${group.survivorId} AND target_artist_id = ${group.survivorId}
    `);

    // Now safe to delete the duplicates — nothing references them.
    const artistsTable = qualified('artists');
    const dupList = intArrayLiteral(group.duplicateIds);
    await tx.execute(sql`DELETE FROM ${artistsTable} WHERE id = ANY(${dupList}::int[])`);

    // Canonicalize the survivor's own name columns to NFC. Guarded so an
    // already-NFC survivor is not a no-op UPDATE (which would still fire the
    // library watermark cascade for nothing).
    await tx.execute(sql`
      UPDATE ${artistsTable}
         SET artist_name       = normalize(artist_name, NFC),
             alphabetical_name = normalize(alphabetical_name, NFC),
             code_letters      = normalize(code_letters, NFC)
       WHERE id = ${group.survivorId}
         AND (artist_name       IS DISTINCT FROM normalize(artist_name, NFC)
           OR alphabetical_name IS DISTINCT FROM normalize(alphabetical_name, NFC)
           OR code_letters      IS DISTINCT FROM normalize(code_letters, NFC))
    `);
  });

  return { survivorId: group.survivorId, duplicatesMerged: group.duplicateIds.length, fkRowsRepointed };
};

/**
 * ANALYZE the tables a merge rewrites so the planner's stats stay on the index
 * path after the bulk repoint (docs/bulk-update-playbook.md; BS#934). Runs
 * outside any transaction; skipped in dry-run.
 */
export const analyzeTables = async (): Promise<void> => {
  for (const table of ['artists', 'library', 'genre_artist_crossreference', 'artist_search_alias']) {
    await db.execute(sql`ANALYZE ${qualified(table)}`);
  }
};

/**
 * Build the PG array literal `'{1,2,3}'` form. Drizzle + postgres-js splat JS
 * arrays across N placeholders, which PG rejects for `= ANY(...)` (the
 * BS#1071 family). Binding one castable string sidesteps the splat; safe by
 * construction (numeric input → numeric literals only). Empty array → `'{}'`.
 */
export const intArrayLiteral = (ids: readonly number[]): string => `{${ids.join(',')}}`;

export const runDedup = async (): Promise<void> => {
  console.log(`[artist-dedup] Mode: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY-RUN (no writes)'}`);

  const groups = await findDuplicateGroups();
  if (groups.length === 0) {
    console.log('[artist-dedup] No Unicode-form duplicate groups found — nothing to do.');
    return;
  }

  const totalDuplicates = groups.reduce((n, g) => n + g.duplicateIds.length, 0);
  console.log(
    `[artist-dedup] Found ${groups.length} fold-duplicate group(s) covering ${totalDuplicates} duplicate row(s) to merge.`
  );

  // Cross-check the SQL fold against the TypeScript twin so a drift between the
  // migration function and `foldArtistName` surfaces loudly rather than as a
  // silently mis-grouped merge.
  for (const g of groups) {
    const twin = foldArtistName(g.survivorName);
    if (twin !== g.foldKey) {
      console.warn(
        `[artist-dedup] WARN fold twin drift: survivor "${g.survivorName}" → SQL "${g.foldKey}" vs TS "${twin}". ` +
          `Trusting the SQL grouping; investigate fold-artist-name.ts vs migration 0134.`
      );
    }
  }

  let mergedGroups = 0;
  let totalFkRepointed = 0;

  for (const group of groups) {
    const dupDescr = group.duplicates.map((d) => `#${d.id} ${JSON.stringify(d.name)}`).join(', ');
    console.log(
      `[artist-dedup] group "${group.foldKey}": survivor #${group.survivorId} ${JSON.stringify(group.survivorName)} <- ${dupDescr}`
    );

    if (!EXECUTE) {
      const counts = await previewGroup(group);
      const summary = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(', ');
      console.log(`[artist-dedup]   would repoint: ${summary || '(no FK rows)'}`);
      continue;
    }

    const result = await mergeGroup(group);
    mergedGroups += 1;
    totalFkRepointed += result.fkRowsRepointed;
    console.log(
      `[artist-dedup]   merged ${result.duplicatesMerged} duplicate(s); repointed ${result.fkRowsRepointed} FK row(s).`
    );
  }

  if (EXECUTE) {
    console.log(`[artist-dedup] Merged ${mergedGroups} group(s); repointed ${totalFkRepointed} FK row(s) total.`);
    await analyzeTables();
    console.log('[artist-dedup] ANALYZE complete on rewritten tables.');
  } else {
    console.log('[artist-dedup] DRY-RUN complete — re-run with --execute to apply.');
  }

  console.log('[artist-dedup] Done.');
};

const main = async () => {
  try {
    await runDedup();
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((err) => {
  console.error('[artist-dedup] Fatal error:', err);
  // exitCode (not exit) so the finally body runs and the pg pool closes.
  process.exitCode = 1;
});
