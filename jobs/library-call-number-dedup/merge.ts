/**
 * Importable core of the one-shot library-call-number-dedup job.
 *
 * Split out from `job.ts` (the thin CLI entrypoint) so the destructive
 * functions can be imported and exercised against a real Postgres by the
 * integration test WITHOUT the module's top-level `main()` firing on import —
 * same arrangement as `jobs/artist-unicode-dedup/merge.ts`, which is this
 * job's structural donor.
 *
 * Slot key: `(artist_id, genre_id, code_number, upper(coalesce(code_volume_letters,'')))`.
 *
 *   - `genre_id` is in the key because code letters are genre-scoped: an artist
 *     filed under two genres has two shelves, and `BO 3` (Electronic) and
 *     `Bo 3` (Rock) are different slots. That used to be implicit in there
 *     being two `artists` rows, but BS#1897's dedup merges artist rows GLOBALLY
 *     across genres, so after it ran the genre is the only thing left
 *     distinguishing the two shelves. A key of `(artist_id, code_number)` would
 *     call those a collision and destroy a correct filing.
 *
 *   - the volume letter is folded to upper case because 'D' and 'd' are one
 *     slot, not two. The upstream MySQL catalog compares them case-insensitively
 *     under its default collation, so duplicates were created that Postgres —
 *     which compares case-sensitively — would otherwise read as distinct and
 *     let straight through.
 *
 * Every FK referencing `library.id` is repointed to the survivor BEFORE the
 * losing row is deleted. That ordering is not stylistic: six of the sites
 * declare `onDelete: 'cascade'` and two declare `set null`, so deleting first
 * would silently destroy rotation history, album metadata, and reviews, and
 * silently unlink plays, with no error raised.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, intArrayLiteral } from '@wxyc/database';
import { classifySlot, hasTwinElsewhere, type SlotMember, type SlotVerdict } from './classify';
import { formatWorklist } from './report';

/** The transaction handle Drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default is dry-run; `--execute` opts into writes. */
export const EXECUTE = process.argv.includes('--execute');

export const schemaName = (): string => (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

const ident = (name: string): SQL => sql.raw(`"${name.replace(/"/g, '""')}"`);
const qualified = (table: string): SQL => sql.raw(`"${schemaName()}"."${table.replace(/"/g, '""')}"`);

/**
 * Every FK column referencing `library.id`. `uniqueKey` is the full unique/PK
 * key the column participates in (INCLUDING the column itself), or `null` when
 * no uniqueness constraint involves it — a plain repoint can never collide.
 * When repointing a loser's row would collide with a row the survivor already
 * has, the loser's row is dropped instead (the survivor already carries the
 * equivalent).
 *
 * Deliberately absent:
 *   - `album_plays` — a materialized view, refreshed rather than repointed.
 *   - `specialty_shows` — carries no library reference despite the name.
 */
export interface FkTarget {
  table: string;
  column: string;
  uniqueKey: string[] | null;
}

export const FK_TARGETS: readonly FkTarget[] = [
  { table: 'rotation', column: 'album_id', uniqueKey: null },
  { table: 'flowsheet', column: 'album_id', uniqueKey: null },
  { table: 'album_metadata', column: 'album_id', uniqueKey: ['album_id'] },
  { table: 'reviews', column: 'album_id', uniqueKey: null },
  { table: 'album_review_submissions', column: 'album_id', uniqueKey: null },
  { table: 'album_critic_reviews', column: 'album_id', uniqueKey: ['album_id', 'source_url'] },
  {
    table: 'compilation_track_artist',
    column: 'library_id',
    uniqueKey: ['library_id', 'artist_name', 'track_title'],
  },
  { table: 'artist_library_crossreference', column: 'library_id', uniqueKey: ['artist_id', 'library_id'] },
  { table: 'bins', column: 'album_id', uniqueKey: null },
  { table: 'library_identity', column: 'library_id', uniqueKey: ['library_id'] },
  { table: 'library_identity_source', column: 'library_id', uniqueKey: ['library_id', 'source'] },
  { table: 'library_identity_history', column: 'library_id', uniqueKey: null },
  { table: 'album_popularity', column: 'representative_library_id', uniqueKey: null },
];

export interface SlotRow extends SlotMember {
  artist_id: number;
  genre_id: number;
  code_number: number;
  vol: string;
}

export interface CollisionSlot {
  artist_id: number;
  genre_id: number;
  code_number: number;
  vol: string;
  members: SlotRow[];
}

type RawRow = {
  id: number;
  album_title: string;
  artist_id: number;
  genre_id: number;
  code_number: number;
  vol: string;
};

/**
 * Every `library` row sharing a slot with at least one other row, grouped.
 *
 * Reference counts are gathered with one query PER FK SITE over the whole
 * candidate id set (13 queries), not one per candidate row (13 × ~1,500) — the
 * counts only exist to rank survivors, and the per-row shape would turn a
 * seconds-long read into a minutes-long one for the same answer.
 */
export const findCollisionSlots = async (): Promise<CollisionSlot[]> => {
  const library = qualified('library');
  const rows = (await db.execute(sql`
    WITH slot AS (
      SELECT artist_id, genre_id, code_number, upper(coalesce(code_volume_letters, '')) AS vol
        FROM ${library}
       GROUP BY 1, 2, 3, 4
      HAVING count(*) > 1
    )
    SELECT l.id, l.album_title, l.artist_id, l.genre_id, l.code_number,
           upper(coalesce(l.code_volume_letters, '')) AS vol
      FROM ${library} l
      JOIN slot s
        ON s.artist_id = l.artist_id
       AND s.genre_id = l.genre_id
       AND s.code_number = l.code_number
       AND s.vol = upper(coalesce(l.code_volume_letters, ''))
     ORDER BY l.artist_id, l.genre_id, l.code_number, s.vol, l.id
  `)) as unknown as RawRow[];

  if (rows.length === 0) return [];

  const refs = await countReferences(rows.map((r) => r.id));

  const slots = new Map<string, CollisionSlot>();
  for (const r of rows) {
    const key = `${r.artist_id}|${r.genre_id}|${r.code_number}|${r.vol}`;
    const slot = slots.get(key) ?? {
      artist_id: r.artist_id,
      genre_id: r.genre_id,
      code_number: r.code_number,
      vol: r.vol,
      members: [],
    };
    slot.members.push({
      id: r.id,
      album_title: r.album_title,
      refs: refs.get(r.id) ?? 0,
      artist_id: r.artist_id,
      genre_id: r.genre_id,
      code_number: r.code_number,
      vol: r.vol,
    });
    slots.set(key, slot);
  }
  return [...slots.values()];
};

/** Total inbound references per library id, summed across every FK site. */
export const countReferences = async (ids: readonly number[]): Promise<Map<number, number>> => {
  const totals = new Map<number, number>();
  if (ids.length === 0) return totals;
  const idList = intArrayLiteral([...ids]);

  for (const target of FK_TARGETS) {
    const t = qualified(target.table);
    const col = ident(target.column);
    const res = (await db.execute(sql`
      SELECT ${col} AS ref_id, count(*)::int AS n
        FROM ${t}
       WHERE ${col} = ANY(${idList}::int[])
       GROUP BY ${col}
    `)) as unknown as Array<{ ref_id: number; n: number }>;
    for (const row of res) {
      totals.set(Number(row.ref_id), (totals.get(Number(row.ref_id)) ?? 0) + Number(row.n));
    }
  }
  return totals;
};

/** Every row on a slot's shelf, for the twin check that gates a renumber. */
export const loadShelf = async (
  artist_id: number,
  genre_id: number
): Promise<Array<{ code_number: number; album_title: string }>> => {
  const library = qualified('library');
  return (await db.execute(sql`
    SELECT code_number, album_title FROM ${library}
     WHERE artist_id = ${artist_id} AND genre_id = ${genre_id}
  `)) as unknown as Array<{ code_number: number; album_title: string }>;
};

export type SlotPlan =
  | { kind: 'merge'; slot: CollisionSlot; survivorId: number; loserIds: number[] }
  | { kind: 'renumber'; slot: CollisionSlot; keepId: number; moveId: number; newNumber: number }
  /** Renumber withheld: the disc that would move has a twin at another number. */
  | { kind: 'held'; slot: CollisionSlot; moveId: number; reason: string };

/**
 * Turn every collision slot into a concrete plan. Renumber targets are
 * allocated here, sequentially per shelf from that shelf's current maximum, so
 * two renumbers on one shelf can't be handed the same number.
 */
export const planSlots = async (slots: readonly CollisionSlot[]): Promise<SlotPlan[]> => {
  const nextFree = new Map<string, number>();
  const plans: SlotPlan[] = [];

  for (const slot of slots) {
    const verdict: SlotVerdict = classifySlot(slot.members);
    if (verdict.kind === 'merge') {
      plans.push({ kind: 'merge', slot, survivorId: verdict.survivorId, loserIds: verdict.loserIds });
      continue;
    }

    const shelfKey = `${slot.artist_id}|${slot.genre_id}`;
    const shelf = await loadShelf(slot.artist_id, slot.genre_id);
    const move = slot.members.find((m) => m.id === verdict.moveId);

    if (move && hasTwinElsewhere(move.album_title, slot.code_number, shelf)) {
      plans.push({
        kind: 'held',
        slot,
        moveId: verdict.moveId,
        reason: `"${move.album_title}" already sits at another number on this shelf; which copy is real is a shelf question`,
      });
      continue;
    }

    if (!nextFree.has(shelfKey)) {
      nextFree.set(shelfKey, Math.max(0, ...shelf.map((r) => r.code_number)) + 1);
    }
    const newNumber = nextFree.get(shelfKey)!;
    nextFree.set(shelfKey, newNumber + 1);
    plans.push({ kind: 'renumber', slot, keepId: verdict.keepId, moveId: verdict.moveId, newNumber });
  }
  return plans;
};

/**
 * Repoint one FK site from `loser` → `survivor` inside a transaction. For a
 * unique-keyed column, first drop the loser's rows that would collide with an
 * existing survivor row on the other key columns, then repoint the remainder.
 */
const repointTarget = async (tx: Tx, target: FkTarget, loser: number, survivor: number): Promise<number> => {
  const t = qualified(target.table);
  const col = ident(target.column);

  if (target.uniqueKey) {
    const otherCols = target.uniqueKey.filter((c) => c !== target.column);
    const matchClause =
      otherCols.length > 0
        ? sql.join(
            otherCols.map((c) => sql`k.${ident(c)} IS NOT DISTINCT FROM d.${ident(c)}`),
            sql` AND `
          )
        : sql`TRUE`;
    await tx.execute(sql`
      DELETE FROM ${t} d
       WHERE d.${col} = ${loser}
         AND EXISTS (SELECT 1 FROM ${t} k WHERE k.${col} = ${survivor} AND ${matchClause})
    `);
  }

  const res = await tx.execute(sql`UPDATE ${t} SET ${col} = ${survivor} WHERE ${col} = ${loser}`);
  return Number(res.count ?? 0);
};

export interface MergeResult {
  survivorId: number;
  losersMerged: number;
  fkRowsRepointed: number;
}

/**
 * Merge one slot in a single transaction: repoint every FK site for each loser,
 * then delete the losers. Per-slot atomicity means an interrupted run leaves
 * each slot either fully merged or untouched.
 */
export const mergeSlot = async (plan: Extract<SlotPlan, { kind: 'merge' }>): Promise<MergeResult> => {
  let fkRowsRepointed = 0;
  await db.transaction(async (tx) => {
    for (const loser of plan.loserIds) {
      for (const target of FK_TARGETS) {
        fkRowsRepointed += await repointTarget(tx, target, loser, plan.survivorId);
      }
    }
    const library = qualified('library');
    const loserList = intArrayLiteral(plan.loserIds);
    await tx.execute(sql`DELETE FROM ${library} WHERE id = ANY(${loserList}::int[])`);
  });
  return { survivorId: plan.survivorId, losersMerged: plan.loserIds.length, fkRowsRepointed };
};

/**
 * Move one row to a free number on its own shelf. Re-checks that the
 * destination is still free inside the transaction — the plan was built from a
 * snapshot, and a librarian filing concurrently could have taken it. Returns
 * false when the destination was taken, leaving the row where it is.
 */
export const renumberRow = async (plan: Extract<SlotPlan, { kind: 'renumber' }>): Promise<boolean> => {
  const library = qualified('library');
  let moved = false;
  await db.transaction(async (tx) => {
    const taken = (await tx.execute(sql`
      SELECT 1 FROM ${library}
       WHERE artist_id = ${plan.slot.artist_id}
         AND genre_id = ${plan.slot.genre_id}
         AND code_number = ${plan.newNumber}
         AND upper(coalesce(code_volume_letters, '')) = ${plan.slot.vol}
       LIMIT 1
    `)) as unknown as unknown[];
    if (taken.length > 0) return;
    const res = await tx.execute(sql`
      UPDATE ${library} SET code_number = ${plan.newNumber} WHERE id = ${plan.moveId}
    `);
    moved = Number(res.count ?? 0) > 0;
  });
  return moved;
};

/**
 * ANALYZE the tables a run rewrites so the planner's stats stay on the index
 * path after the bulk repoint (docs/bulk-update-playbook.md). Runs outside any
 * transaction; skipped in dry-run.
 */
export const analyzeTouchedTables = async (): Promise<void> => {
  const tables = ['library', ...new Set(FK_TARGETS.map((t) => t.table))];
  for (const table of tables) {
    await db.execute(sql`ANALYZE ${qualified(table)}`);
  }
};

/** Display names for the worklist: who the shelf belongs to and what it's called. */
const loadShelfLabels = async (
  plans: readonly SlotPlan[]
): Promise<Map<string, { artist: string; codeLetters: string; genre: string }>> => {
  const labels = new Map<string, { artist: string; codeLetters: string; genre: string }>();
  const needed = plans.filter((p) => p.kind !== 'merge');
  if (needed.length === 0) return labels;

  const artistIds = intArrayLiteral([...new Set(needed.map((p) => p.slot.artist_id))]);
  const genreIds = intArrayLiteral([...new Set(needed.map((p) => p.slot.genre_id))]);
  const rows = (await db.execute(sql`
    SELECT a.id AS artist_id, a.artist_name, a.code_letters, g.id AS genre_id, g.genre_name
      FROM ${qualified('artists')} a
      CROSS JOIN ${qualified('genres')} g
     WHERE a.id = ANY(${artistIds}::int[])
       AND g.id = ANY(${genreIds}::int[])
  `)) as unknown as Array<{
    artist_id: number;
    artist_name: string;
    code_letters: string;
    genre_id: number;
    genre_name: string;
  }>;
  for (const r of rows) {
    labels.set(`${r.artist_id}|${r.genre_id}`, {
      artist: r.artist_name,
      codeLetters: r.code_letters,
      genre: r.genre_name,
    });
  }
  return labels;
};

const titleOf = (slot: CollisionSlot, id: number): string =>
  slot.members.find((m) => m.id === id)?.album_title ?? `(row ${id})`;

export interface DedupSummary {
  slots: number;
  merges: number;
  renumbers: number;
  held: number;
  fkRowsRepointed: number;
  rowsDeleted: number;
  renumbersSkipped: number;
  worklist: string;
}

/**
 * Whole run: find every colliding slot, decide what each one is, and — only
 * under `--execute` — merge the duplicates and move the genuine collisions.
 *
 * Dry-run reports exactly what an execute run would do, including the finished
 * worklist, so the librarian's list can be reviewed before anything is written.
 */
export const runDedup = async (): Promise<DedupSummary> => {
  const tag = '[library-call-number-dedup]';
  console.log(`${tag} mode: ${EXECUTE ? 'EXECUTE (writes)' : 'DRY RUN (no writes)'}`);

  const slots = await findCollisionSlots();
  console.log(`${tag} colliding call-number slots: ${slots.length}`);
  if (slots.length === 0) {
    return {
      slots: 0,
      merges: 0,
      renumbers: 0,
      held: 0,
      fkRowsRepointed: 0,
      rowsDeleted: 0,
      renumbersSkipped: 0,
      worklist: formatWorklist([], []),
    };
  }

  const plans = await planSlots(slots);
  const merges = plans.filter((p): p is Extract<SlotPlan, { kind: 'merge' }> => p.kind === 'merge');
  const renumbers = plans.filter((p): p is Extract<SlotPlan, { kind: 'renumber' }> => p.kind === 'renumber');
  const heldPlans = plans.filter((p): p is Extract<SlotPlan, { kind: 'held' }> => p.kind === 'held');

  const plannedDeletions = merges.reduce((n, p) => n + p.loserIds.length, 0);
  console.log(
    `${tag} plan: ${merges.length} merges (${plannedDeletions} rows deleted), ` +
      `${renumbers.length} renumbers, ${heldPlans.length} held for the librarian`
  );

  const labels = await loadShelfLabels(plans);
  const label = (p: SlotPlan) =>
    labels.get(`${p.slot.artist_id}|${p.slot.genre_id}`) ?? {
      artist: `artist ${p.slot.artist_id}`,
      codeLetters: '??',
      genre: `genre ${p.slot.genre_id}`,
    };

  const worklist = formatWorklist(
    renumbers.map((p) => {
      const l = label(p);
      return {
        genre: l.genre,
        artist: l.artist,
        codeLetters: l.codeLetters,
        moveTitle: titleOf(p.slot, p.moveId),
        keepTitle: titleOf(p.slot, p.keepId),
        oldNumber: p.slot.code_number,
        newNumber: p.newNumber,
        vol: p.slot.vol,
      };
    }),
    heldPlans.map((p) => {
      const l = label(p);
      return {
        genre: l.genre,
        artist: l.artist,
        codeLetters: l.codeLetters,
        title: titleOf(p.slot, p.moveId),
        atNumber: p.slot.code_number,
        reason: p.reason,
      };
    })
  );

  let fkRowsRepointed = 0;
  let rowsDeleted = 0;
  let renumbersSkipped = 0;

  if (EXECUTE) {
    for (const plan of merges) {
      const res = await mergeSlot(plan);
      fkRowsRepointed += res.fkRowsRepointed;
      rowsDeleted += res.losersMerged;
    }
    for (const plan of renumbers) {
      const moved = await renumberRow(plan);
      if (!moved) {
        renumbersSkipped += 1;
        const l = label(plan);
        console.warn(
          `${tag} skipped renumber: ${l.codeLetters} ${plan.slot.code_number} -> ${plan.newNumber} ` +
            `(destination taken since the plan was built; re-run to re-plan)`
        );
      }
    }
    await analyzeTouchedTables();
    console.log(`${tag} repointed ${fkRowsRepointed} FK rows, deleted ${rowsDeleted} library rows`);
  } else {
    for (const plan of merges) {
      const counts = await previewSlot(plan);
      fkRowsRepointed += counts;
    }
    console.log(`${tag} dry run: would repoint ${fkRowsRepointed} FK rows and delete ${plannedDeletions} library rows`);
  }

  console.log(`\n${worklist}`);

  return {
    slots: slots.length,
    merges: merges.length,
    renumbers: renumbers.length,
    held: heldPlans.length,
    fkRowsRepointed,
    rowsDeleted: EXECUTE ? rowsDeleted : plannedDeletions,
    renumbersSkipped,
    worklist,
  };
};

/** Dry-run counterpart to `mergeSlot`: how many FK rows it would repoint. */
export const previewSlot = async (plan: Extract<SlotPlan, { kind: 'merge' }>): Promise<number> => {
  const refs = await countReferences(plan.loserIds);
  return [...refs.values()].reduce((a, b) => a + b, 0);
};
