/**
 * Importable core of the one-shot artist-unicode-dedup job (BS#1897).
 *
 * Split out from `job.ts` (which is the thin CLI entrypoint that calls
 * `runDedup` + `main`) so the destructive merge functions can be imported and
 * exercised against a real Postgres by the integration test
 * (`tests/integration/artist-unicode-dedup-merge.spec.js`) WITHOUT the module's
 * top-level `main()` auto-run firing on import. See the job's README for the
 * operational contract; the SQL semantics are documented per-function below.
 *
 * Grouping key: `wxyc_schema.fold_artist_name(artist_name)` — the exact fold the
 * matcher (`artistIdFromName`) now uses, so post-dedup there is exactly one
 * `artists` row per key the matcher would treat as identical. Survivor = the
 * lowest `id` in the group. Every FK that references `artists.id` is repointed
 * to the survivor BEFORE the duplicate row is deleted — the hard data-safety
 * invariant (never drop an FK-referenced row without repointing).
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, foldArtistName, intArrayLiteral } from '@wxyc/database';

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
  // BS#1990 (#801 S1): the per-track artist canonicalization link. It is
  // `ON DELETE SET NULL`, so an unregistered site would not raise — the delete
  // below would silently blank the link on every credit pointing at a
  // merged-away duplicate. `uniqueKey: null` because no uniqueness constraint
  // involves this column (`cta_unique_idx` is
  // `(library_id, artist_name, track_title)`, `cta_unique_null_track_idx` is
  // `(library_id, artist_name)`), so a plain repoint can never collide.
  { table: 'compilation_track_artist', column: 'track_artist_id', uniqueKey: null },
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
 *
 * SCOPE — deliberate and conscious (MED-2, BS#1897 review): grouping is GLOBAL
 * (across all genres), NOT genre-scoped, even though the matcher
 * (`artistIdFromName`) resolves within a single `genre_id`. This is intentional:
 * genre-partitioning is itself a duplicate source — the same artist filed under
 * two genres yields two `artists` rows that the matcher's per-genre lookup can
 * never reconcile — so global dedup heals that partition and leaves one row the
 * matcher then reaches from every genre via `genre_artist_crossreference`. The
 * flip side is that a global group can span multiple genres, or fold together
 * names that differ by more than Unicode form (accent- or case-only), which is
 * the genuinely-distinct-artist risk the README warns about; `describeGroupRisk`
 * surfaces both in the dry-run so the operator eyeballs the risky merges before
 * `--execute`.
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

/** Every member id of a group (survivor first, then duplicates). */
const memberIds = (group: DuplicateGroup): number[] => [group.survivorId, ...group.duplicateIds];

export interface GroupRisk {
  /** Distinct `genre_id`s the group's members span (via genre_artist_crossreference). */
  genreIds: number[];
  /** The group folds together rows filed under more than one genre. */
  multiGenre: boolean;
  /**
   * Every member name is byte-identical after NFC — a pure Unicode-form
   * duplicate (NFC vs NFD), unambiguously safe to merge. When false the members
   * differ by accent or case (fold-equal but not form-equal): the
   * genuinely-distinct-artist risk to eyeball before `--execute`.
   */
  formOnly: boolean;
}

/**
 * Compute the operator-facing risk signal for a group (MED-2). Genre span is a
 * DB read; `formOnly` is derived from the member names in-process. Dry-run only
 * — pure reads, no writes.
 */
export const describeGroupRisk = async (group: DuplicateGroup): Promise<GroupRisk> => {
  const ids = memberIds(group);
  const g = qualified('genre_artist_crossreference');
  const res = (await db.execute(sql`
    SELECT array_agg(DISTINCT genre_id ORDER BY genre_id) AS genre_ids
    FROM ${g}
    WHERE artist_id = ANY(${intArrayLiteral(ids)}::int[])
  `)) as unknown as Array<{ genre_ids: number[] | null }>;
  const genreIds = (res[0]?.genre_ids ?? []).map(Number);

  const names = [group.survivorName, ...group.duplicates.map((d) => d.name)];
  const nfc = names.map((n) => n.normalize('NFC'));
  const formOnly = nfc.every((n) => n === nfc[0]);

  return { genreIds, multiGenre: genreIds.length > 1, formOnly };
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
      // duplicate is deleted (survivor's own non-null value always wins). Because
      // duplicates are processed in ascending id order, when two duplicates both
      // carry a non-null value for the same identity column, the LOWER-id
      // duplicate's value lands first and the COALESCE keeps it — deterministic.
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
  let riskyGroups = 0;

  for (const group of groups) {
    const dupDescr = group.duplicates.map((d) => `#${d.id} ${JSON.stringify(d.name)}`).join(', ');
    console.log(
      `[artist-dedup] group "${group.foldKey}": survivor #${group.survivorId} ${JSON.stringify(group.survivorName)} <- ${dupDescr}`
    );

    if (!EXECUTE) {
      // MED-2: flag the risky-to-eyeball merges. `multiGenre` = the global group
      // folds rows filed under >1 genre; `!formOnly` = members differ by accent
      // or case, not just Unicode form (the genuinely-distinct-artist risk).
      const risk = await describeGroupRisk(group);
      const flags: string[] = [];
      if (risk.multiGenre) flags.push(`MULTI-GENRE spans genres [${risk.genreIds.join(', ')}] — verify same artist`);
      if (!risk.formOnly) flags.push('DIFFERS BEYOND UNICODE FORM (accent/case) — verify same artist');
      if (flags.length > 0) {
        riskyGroups += 1;
        for (const f of flags) console.log(`[artist-dedup]   ⚠ ${f}`);
      } else {
        console.log('[artist-dedup]   ✓ pure Unicode-form duplicate, single genre — safe to merge');
      }

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
    console.log(
      `[artist-dedup] DRY-RUN complete — ${riskyGroups} group(s) flagged for eyeball review (⚠). ` +
        `Re-run with --execute to apply.`
    );
  }

  console.log('[artist-dedup] Done.');
};
