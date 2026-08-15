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
 * cascade and two null the reference out, so deleting first would silently
 * destroy rotation history, album metadata, reviews, and artist
 * cross-references, and silently unlink plays, with no error raised.
 *
 * Those actions are what the DATABASE enforces, which is not always what
 * `schema.ts` declares. `artist_library_crossreference.library_id` was the
 * standing example: declared `cascade`, created `no action` by migration 0022
 * (one of the four drifted constraints in BS#2015). Migration 0147 (BS#2112)
 * repaired it to the declared `cascade`, so it is no longer drifted — but the
 * sibling `artist_id` FK on the same table still is, and the general lesson
 * stands. The integration spec's `enforced-fk-actions` block pins every entry
 * below against `information_schema` so this list tracks the database rather
 * than the declaration; that is what caught 0147's change.
 *
 * **0147 changed the failure mode of a bug in this file, and the delete
 * ordering above now carries weight it did not have to before.** While
 * `artist_library_crossreference` was `no action`, an incomplete repoint of
 * that table failed LOUDLY: the survivor's DELETE raised a foreign-key
 * violation and the per-slot transaction rolled back with nothing lost. Under
 * `cascade` the same bug fails SILENTLY — any crossreference row the repoint
 * missed is deleted along with the loser and the merge reports success. Three
 * of the thirteen sites (`bins`, `library_identity`,
 * `library_identity_source`) still raise, so the class of bug is not
 * undetectable, but this particular table has stopped being one of the
 * canaries. Treat a change to the repoint logic here as unguarded by the
 * database.
 */

import { sql, type SQL } from 'drizzle-orm';
import { checkLiveActivity, db, intArrayLiteral } from '@wxyc/database';
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
  /**
   * Column that must be NULL for a PARTIAL unique key to apply. Load-bearing
   * rather than cosmetic: without it the collision-delete drops rows the index
   * never constrained. `rotation`'s key covers only ACTIVE rows
   * (`WHERE kill_date IS NULL`), so a killed rotation record may duplicate an
   * active one freely — deleting it would destroy exactly the history that
   * repointing-before-deleting exists to preserve.
   *
   * Modelled as a column name rather than a predicate string so it can be
   * parameterized and table-aliased safely; a partial index needing anything
   * richer should extend this deliberately rather than smuggle in raw SQL.
   */
  uniqueWhenNull?: string;
}

export const FK_TARGETS: readonly FkTarget[] = [
  {
    table: 'rotation',
    column: 'album_id',
    uniqueKey: ['album_id', 'rotation_bin'],
    uniqueWhenNull: 'kill_date',
  },
  { table: 'flowsheet', column: 'album_id', uniqueKey: null },
  { table: 'album_metadata', column: 'album_id', uniqueKey: ['album_id'] },
  { table: 'reviews', column: 'album_id', uniqueKey: ['album_id'] },
  { table: 'album_review_submissions', column: 'album_id', uniqueKey: null },
  { table: 'album_critic_reviews', column: 'album_id', uniqueKey: ['album_id', 'source_url'] },
  { table: 'uncovered_release_search_markers', column: 'album_id', uniqueKey: ['album_id'] },
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
 * candidate id set (14 queries), not one per candidate row (14 × ~1,500) — the
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

/**
 * Every row on a slot's shelf, for the twin check and the next-free number.
 * Cached per shelf: an unlocked MAX+1 allocator produces CLUSTERS of collisions
 * on one shelf, so the uncached form re-reads identical rows once per slot.
 */
const shelfCache = new Map<string, Array<{ code_number: number; album_title: string; id: number }>>();

export const loadShelf = async (
  artist_id: number,
  genre_id: number
): Promise<Array<{ code_number: number; album_title: string; id: number }>> => {
  const key = `${artist_id}|${genre_id}`;
  const hit = shelfCache.get(key);
  if (hit) return hit;
  const library = qualified('library');
  const rows = (await db.execute(sql`
    SELECT id, code_number, album_title FROM ${library}
     WHERE artist_id = ${artist_id} AND genre_id = ${genre_id}
  `)) as unknown as Array<{ code_number: number; album_title: string; id: number }>;
  shelfCache.set(key, rows);
  return rows;
};

/** Test seam: drop memoized shelves so a second run re-reads the catalog. */
export const resetShelfCache = (): void => shelfCache.clear();

export type SlotPlan =
  | { kind: 'merge'; slot: CollisionSlot; survivorId: number; loserIds: number[] }
  | { kind: 'renumber'; slot: CollisionSlot; keepId: number; moveId: number; newNumber: number }
  /** Withheld for the librarian — the database cannot settle it. */
  | { kind: 'held'; slot: CollisionSlot; moveId: number; reason: string };

/**
 * Turn every collision slot into a concrete plan. Renumber targets are
 * allocated here, sequentially per shelf from that shelf's current maximum, so
 * two renumbers on one shelf can't be handed the same number.
 */
export const planSlots = async (slots: readonly CollisionSlot[]): Promise<SlotPlan[]> => {
  const nextFree = new Map<string, number>();
  const plans: SlotPlan[] = [];

  // Rows a merge is already going to delete must not count as twins: otherwise
  // a duplicate this very run is about to remove withholds a renumber, and the
  // slot lands on the librarian's list for a question the job just answered.
  const doomed = new Set<number>();
  for (const slot of slots) {
    const v = classifySlot(slot.members);
    if (v.kind === 'merge') v.loserIds.forEach((id) => doomed.add(id));
  }

  for (const slot of slots) {
    const verdict: SlotVerdict = classifySlot(slot.members);
    const shelfKey = `${slot.artist_id}|${slot.genre_id}`;

    if (verdict.kind === 'merge') {
      plans.push({ kind: 'merge', slot, survivorId: verdict.survivorId, loserIds: verdict.loserIds });
      // Three or more rows where only some are re-entries: the merge resolves
      // the duplicates but the slot still holds two different releases, and
      // which one moves is a shelf question rather than something to guess at.
      if (verdict.unresolvedIds.length > 0) {
        plans.push({
          kind: 'held',
          slot,
          moveId: verdict.unresolvedIds[0],
          reason: 'slot still holds two different releases after the duplicates merge',
        });
      }
      continue;
    }

    const shelf = await loadShelf(slot.artist_id, slot.genre_id);
    const live = shelf.filter((r) => !doomed.has(r.id));
    const move = slot.members.find((m) => m.id === verdict.moveId);

    if (move && hasTwinElsewhere(move.album_title, slot.code_number, live)) {
      plans.push({
        kind: 'held',
        slot,
        moveId: verdict.moveId,
        reason: `"${move.album_title}" already sits at another number on this shelf`,
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
 * Columns on the losing `library` row that are expensive to re-collect and are
 * NOT re-derivable from the surviving row: an LML identity resolution, curated
 * artwork, and the music director's deliberate "not on Discogs" note. The
 * survivor is chosen by inbound reference count, which says nothing about how
 * complete its data is, so without this pass a merge can delete the only row
 * that carried them. Survivor's own non-null value always wins.
 */
const PRESERVED_LIBRARY_COLUMNS = [
  'canonical_entity_id',
  'artwork_url',
  'discogs_unavailable_note',
  'alternate_artist_name',
  'album_artist',
  'label',
  'label_id',
] as const;

/** Same idea for the one child table whose contents are costly to rebuild. */
const PRESERVED_ALBUM_METADATA_COLUMNS = [
  'artwork_url',
  'discogs_url',
  'release_year',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
] as const;

const fillNullsFromLoser = async (tx: Tx, survivor: number, loser: number): Promise<void> => {
  const library = qualified('library');
  const libSet = sql.join(
    PRESERVED_LIBRARY_COLUMNS.map((c) => sql`${ident(c)} = COALESCE(s.${ident(c)}, d.${ident(c)})`),
    sql`, `
  );
  await tx.execute(sql`
    UPDATE ${library} s SET ${libSet}
      FROM ${library} d
     WHERE s.id = ${survivor} AND d.id = ${loser}
  `);

  // Only meaningful when BOTH rows have album_metadata; when only the loser
  // does, the plain repoint moves it across untouched.
  const am = qualified('album_metadata');
  const amSet = sql.join(
    PRESERVED_ALBUM_METADATA_COLUMNS.map((c) => sql`${ident(c)} = COALESCE(s.${ident(c)}, d.${ident(c)})`),
    sql`, `
  );
  await tx.execute(sql`
    UPDATE ${am} s SET ${amSet}
      FROM ${am} d
     WHERE s.album_id = ${survivor} AND d.album_id = ${loser}
  `);
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
    // A partial index constrains only the rows satisfying its predicate, so the
    // collision-delete has to be scoped to those on BOTH sides. Rows outside it
    // cannot collide and are left to repoint normally — that is what keeps
    // killed rotation history intact while active duplicates are resolved.
    const partial = target.uniqueWhenNull;
    const dScope = partial ? sql` AND d.${ident(partial)} IS NULL` : sql``;
    const kScope = partial ? sql` AND k.${ident(partial)} IS NULL` : sql``;
    await tx.execute(sql`
      DELETE FROM ${t} d
       WHERE d.${col} = ${loser}${dScope}
         AND EXISTS (SELECT 1 FROM ${t} k WHERE k.${col} = ${survivor}${kScope} AND ${matchClause})
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
      // Preserve first: repointing can DELETE a loser's unique-keyed child row
      // when the survivor already has one, and the delete below removes the
      // loser's own row outright. Anything worth keeping has to move across
      // before either happens.
      await fillNullsFromLoser(tx, plan.survivorId, loser);
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

/**
 * Display context for the worklist. Joined through `genre_artist_crossreference`
 * rather than crossing `artists` with `genres`, for two reasons: that table is
 * where `artist_genre_code` lives — the middle component of a call number,
 * without which the printed address does not identify a shelf slot, since two
 * artists in one genre routinely share code letters — and joining through it
 * cannot fabricate a label for an (artist, genre) pair that does not exist.
 */
const loadShelfLabels = async (
  plans: readonly SlotPlan[]
): Promise<Map<string, { artist: string; codeLetters: string; artistGenreCode: number | null; genre: string }>> => {
  const labels = new Map<
    string,
    { artist: string; codeLetters: string; artistGenreCode: number | null; genre: string }
  >();
  const needed = plans.filter((p) => p.kind !== 'merge');
  if (needed.length === 0) return labels;

  const artistIds = intArrayLiteral([...new Set(needed.map((p) => p.slot.artist_id))]);
  const genreIds = intArrayLiteral([...new Set(needed.map((p) => p.slot.genre_id))]);
  const rows = (await db.execute(sql`
    SELECT a.id AS artist_id, a.artist_name, a.code_letters,
           g.id AS genre_id, g.genre_name, x.artist_genre_code
      FROM ${qualified('genre_artist_crossreference')} x
      JOIN ${qualified('artists')} a ON a.id = x.artist_id
      JOIN ${qualified('genres')} g ON g.id = x.genre_id
     WHERE x.artist_id = ANY(${artistIds}::int[])
       AND x.genre_id = ANY(${genreIds}::int[])
  `)) as unknown as Array<{
    artist_id: number;
    artist_name: string;
    code_letters: string;
    genre_id: number;
    genre_name: string;
    artist_genre_code: number | null;
  }>;
  for (const r of rows) {
    labels.set(`${r.artist_id}|${r.genre_id}`, {
      artist: r.artist_name,
      codeLetters: r.code_letters,
      artistGenreCode: r.artist_genre_code,
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
  childRowsDeleted: number;
  rowsDeleted: number;
  renumbersSkipped: number;
  worklist: string;
}

/**
 * Rows a merge would DELETE rather than repoint, per unique-keyed FK site.
 *
 * The dry run exists so an operator can approve the plan, and "would repoint N
 * rows" hides the destructive half: where the survivor already holds the
 * equivalent unique-keyed row, the loser's is dropped. Counting it separately
 * is what makes the dry run an honest preview.
 */
export const previewCollisionDeletes = async (
  plan: Extract<SlotPlan, { kind: 'merge' }>
): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const loserList = intArrayLiteral(plan.loserIds);
  for (const target of FK_TARGETS) {
    if (!target.uniqueKey) continue;
    const t = qualified(target.table);
    const col = ident(target.column);
    const otherCols = target.uniqueKey.filter((c) => c !== target.column);
    const matchClause =
      otherCols.length > 0
        ? sql.join(
            otherCols.map((c) => sql`k.${ident(c)} IS NOT DISTINCT FROM d.${ident(c)}`),
            sql` AND `
          )
        : sql`TRUE`;
    const partial = target.uniqueWhenNull;
    const dScope = partial ? sql` AND d.${ident(partial)} IS NULL` : sql``;
    const kScope = partial ? sql` AND k.${ident(partial)} IS NULL` : sql``;
    const res = (await db.execute(sql`
      SELECT count(*)::int AS n FROM ${t} d
       WHERE d.${col} = ANY(${loserList}::int[])${dScope}
         AND EXISTS (SELECT 1 FROM ${t} k WHERE k.${col} = ${plan.survivorId}${kScope} AND ${matchClause})
    `)) as unknown as Array<{ n: number }>;
    const n = Number(res[0]?.n ?? 0);
    if (n > 0) counts[`${target.table}.${target.column}`] = n;
  }
  return counts;
};

/**
 * Dry-run counterpart to `mergeSlot`: how many FK rows it would touch. Read
 * straight off the counts `findCollisionSlots` already attached to each member
 * — re-querying here would reintroduce the per-row shape that batching exists
 * to avoid, for a number already in hand.
 */
export const previewSlot = (plan: Extract<SlotPlan, { kind: 'merge' }>): number =>
  plan.slot.members.filter((m) => plan.loserIds.includes(m.id)).reduce((a, m) => a + m.refs, 0);

/**
 * Whole run: find every colliding slot, decide what each one is, and — only
 * under `--execute` — merge the duplicates and move the genuine collisions.
 *
 * The worklist is rendered AFTER the writes, from the renumbers that actually
 * landed. Rendering it from the plan would tell the librarian to relabel a disc
 * whose catalog row never moved (a destination taken since planning), creating
 * the shelf/catalog disagreement the job exists to remove, in reverse. A dry run
 * renders the whole plan for review, and is marked PREVIEW throughout for the
 * same reason: there, no catalog row moved at all.
 */
export const runDedup = async (): Promise<DedupSummary> => {
  const tag = '[library-call-number-dedup]';
  console.log(`${tag} mode: ${EXECUTE ? 'EXECUTE (writes)' : 'DRY RUN (no writes)'}`);

  const slots = await findCollisionSlots();
  console.log(`${tag} colliding call-number slots: ${slots.length}`);

  const plans = slots.length > 0 ? await planSlots(slots) : [];
  const merges = plans.filter((p): p is Extract<SlotPlan, { kind: 'merge' }> => p.kind === 'merge');
  const renumbers = plans.filter((p): p is Extract<SlotPlan, { kind: 'renumber' }> => p.kind === 'renumber');
  const heldPlans = plans.filter((p): p is Extract<SlotPlan, { kind: 'held' }> => p.kind === 'held');

  const plannedDeletions = merges.reduce((n, p) => n + p.loserIds.length, 0);
  const fkRowsRepointed0 = merges.reduce((n, p) => n + previewSlot(p), 0);

  const childDeletes: Record<string, number> = {};
  for (const plan of merges) {
    for (const [site, n] of Object.entries(await previewCollisionDeletes(plan))) {
      childDeletes[site] = (childDeletes[site] ?? 0) + n;
    }
  }
  const childRowsDeleted = Object.values(childDeletes).reduce((a, b) => a + b, 0);

  console.log(
    `${tag} plan: ${merges.length} merges (${plannedDeletions} library rows deleted), ` +
      `${renumbers.length} renumbers, ${heldPlans.length} held for the librarian`
  );
  console.log(`${tag} ~${fkRowsRepointed0} FK rows repoint; ${childRowsDeleted} child rows dropped as duplicates`);
  for (const [site, n] of Object.entries(childDeletes)) console.log(`${tag}   drop ${n} from ${site}`);

  const labels = await loadShelfLabels(plans);
  const label = (p: SlotPlan) =>
    labels.get(`${p.slot.artist_id}|${p.slot.genre_id}`) ?? {
      artist: `artist ${p.slot.artist_id}`,
      codeLetters: '??',
      artistGenreCode: null,
      genre: `genre ${p.slot.genre_id}`,
    };

  let fkRowsRepointed = fkRowsRepointed0;
  let rowsDeleted = plannedDeletions;
  let renumbersSkipped = 0;
  let landed = renumbers;

  if (EXECUTE) {
    // This job writes `flowsheet`, which dj-site polls every 60s. Refuse to
    // start while a DJ is on air rather than pause mid-run: it is a one-shot
    // run in a chosen window, so declining is cheaper than a partial pass.
    const live = await checkLiveActivity(600).catch(() => false);
    if (live) {
      console.warn(`${tag} a show is on air — refusing to start. Re-run in a quiet window.`);
      return {
        slots: slots.length,
        merges: merges.length,
        renumbers: renumbers.length,
        held: heldPlans.length,
        fkRowsRepointed: 0,
        childRowsDeleted: 0,
        rowsDeleted: 0,
        renumbersSkipped: 0,
        // 'dry-run' even though `--execute` was passed: the run declined before
        // writing anything, so nothing on a worklist from here could be acted on.
        worklist: formatWorklist([], [], 'dry-run'),
      };
    }

    fkRowsRepointed = 0;
    rowsDeleted = 0;
    for (const plan of merges) {
      const res = await mergeSlot(plan);
      fkRowsRepointed += res.fkRowsRepointed;
      rowsDeleted += res.losersMerged;
    }
    const moved: typeof renumbers = [];
    for (const plan of renumbers) {
      if (await renumberRow(plan)) {
        moved.push(plan);
      } else {
        renumbersSkipped += 1;
        const l = label(plan);
        console.warn(
          `${tag} skipped renumber: ${l.codeLetters} ${plan.slot.code_number} -> ${plan.newNumber} ` +
            `(destination taken since the plan was built; re-run to re-plan). NOT on the worklist.`
        );
      }
    }
    landed = moved;
    await analyzeTouchedTables();
    console.log(`${tag} repointed ${fkRowsRepointed} FK rows, deleted ${rowsDeleted} library rows`);
  }

  const worklist = formatWorklist(
    landed.map((p) => {
      const l = label(p);
      return {
        genre: l.genre,
        artist: l.artist,
        codeLetters: l.codeLetters,
        artistGenreCode: l.artistGenreCode,
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
        artistGenreCode: l.artistGenreCode,
        title: titleOf(p.slot, p.moveId),
        atNumber: p.slot.code_number,
        vol: p.slot.vol,
        reason: p.reason,
      };
    }),
    EXECUTE ? 'execute' : 'dry-run'
  );

  console.log(`\n${worklist}`);
  if (renumbersSkipped > 0) {
    console.warn(`${tag} ${renumbersSkipped} renumber(s) skipped — re-run to re-plan them.`);
  }

  return {
    slots: slots.length,
    merges: merges.length,
    renumbers: landed.length,
    held: heldPlans.length,
    fkRowsRepointed,
    childRowsDeleted,
    rowsDeleted,
    renumbersSkipped,
    worklist,
  };
};
