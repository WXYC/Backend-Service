/**
 * Write phase (BS#2319 issue comments 1+2 -- the binding parts of this job):
 * plan what to do with each matched candidate album against the slot it
 * would occupy, then execute that plan in the smallest number of
 * `digital_asset`-touching statements possible.
 *
 * The upsert key is `(library_id, provenance, disc_number)` (comment 1).
 * `provenance` is always `'rotation_upload'` here -- the hand-uploaded
 * auto-DJ MP3 population this job exists to inventory; `'cd_rip'` belongs to
 * a later phase. `digital_asset_store.name` is `'azuracast'` (comment 1,
 * correcting the `'azuracast-do-spaces'` example in the merged schema.ts
 * JSDoc).
 *
 * Per-slot rule (comment 2), decided ahead of this job so a re-run's
 * behaviour is settled, not improvised:
 *   - no existing row               -> insert `needs_review`
 *   - existing row, `needs_review`  -> untouched (idempotent re-run)
 *   - existing row, `rejected`      -> skip, but ALWAYS report the object
 *                                       keys + slot it wanted, so a blocked
 *                                       candidate is never silently
 *                                       indistinguishable from no candidate
 *                                       at all. `--rebind-keys` overrides
 *                                       this for exactly the named object
 *                                       keys (the merge.ts collision-DELETE
 *                                       recovery path).
 *   - existing row, `bound`         -> NEVER written, under any flag --
 *                                       compare the candidate's object keys
 *                                       against the bound asset's files and
 *                                       report DRIFT when they differ (a
 *                                       live-playout file replaced or moved
 *                                       under a binding that was correct
 *                                       when it was made).
 *
 * **Watermark bound (comment 3, migration 0159): one advance per write
 * phase, enforced by the transaction rather than by statement counting.**
 * `executeWrites` runs entirely inside `db.transaction`, and Postgres
 * `now()` is transaction-start time, so every `FOR EACH STATEMENT` firing of
 * `touch_library_watermark()` inside the phase writes the SAME instant --
 * one advance however many statements touch `digital_asset`. That is what
 * makes chunking safe: it decouples the watermark cost from the statement
 * count, so the inserts below can be split to respect the bind-parameter
 * ceiling without paying an advance per chunk. Every advance forces every
 * iOS device to re-download the whole gzipped NDJSON catalog and rebuild its
 * FTS5 index, so this is a real user-visible cost, not bookkeeping.
 *
 * The transaction is equally load-bearing for atomicity: the `digital_asset`
 * INSERT and the `digital_asset_file` INSERT must commit together or not at
 * all. Committed separately, a failure between them leaves `needs_review`
 * assets holding zero files -- and `planWrites` deliberately leaves
 * `needs_review` slots untouched, so no re-run would ever fill them. The
 * only recovery would be hand-editing rows.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, digital_asset, digital_asset_file, digital_asset_store } from '@wxyc/database';
import type { MatchedAlbum } from './types.js';

export const PROVENANCE = 'rotation_upload';
export const STORE_NAME = 'azuracast';

export interface ExistingSlot {
  id: number;
  libraryId: number;
  discNumber: number;
  status: string;
}

export interface RejectedBlocked {
  libraryId: number;
  discNumber: number;
  objectKeys: string[];
}

export interface RejectedReopened {
  assetId: number;
  matched: MatchedAlbum;
}

export interface BoundDrift {
  assetId: number;
  libraryId: number;
  discNumber: number;
  candidateKeys: string[];
  boundKeys: string[];
}

export interface SameRunCollision {
  libraryId: number;
  discNumber: number;
  objectKeys: string[];
}

export interface WritePlan {
  toInsert: MatchedAlbum[];
  rejectedBlocked: RejectedBlocked[];
  rejectedReopened: RejectedReopened[];
  boundDrift: BoundDrift[];
  /**
   * Two DIFFERENT candidate groups in the SAME run resolved to the same
   * `(library_id, disc_number)` slot -- e.g. a `freeform/` copy and a
   * `rotation/Heavy/` copy of the same album, both present in the Space at
   * once. `existingSlots` can't catch this (it's a snapshot taken before
   * this run's own inserts), and a plain multi-row INSERT would hit the
   * unique index and abort the WHOLE batch, not just the second row. The
   * first-seen candidate is queued for insert; every later one targeting
   * the same slot is reported here instead, unwritten.
   */
  sameRunCollision: SameRunCollision[];
}

const slotKey = (libraryId: number, discNumber: number): string => `${libraryId}::${discNumber}`;

const sameKeySet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((k) => setB.has(k));
};

/**
 * Pure planner -- no DB access, so the per-slot rule above is unit-testable
 * against hand-built `ExistingSlot`/bound-file fixtures.
 */
export const planWrites = (
  matched: readonly MatchedAlbum[],
  existingSlots: readonly ExistingSlot[],
  boundFileKeys: ReadonlyMap<number, readonly string[]>,
  rebindKeys: ReadonlySet<string>
): WritePlan => {
  const slots = new Map<string, ExistingSlot>();
  for (const slot of existingSlots) slots.set(slotKey(slot.libraryId, slot.discNumber), slot);

  const plan: WritePlan = {
    toInsert: [],
    rejectedBlocked: [],
    rejectedReopened: [],
    boundDrift: [],
    sameRunCollision: [],
  };
  const claimedThisRun = new Set<string>();

  for (const candidate of matched) {
    const discNumber = candidate.candidate.discNumber;
    const key = slotKey(candidate.libraryId, discNumber);
    const existing = slots.get(key);
    const candidateKeys = candidate.candidate.files.map((f) => f.objectKey);

    if (!existing) {
      if (claimedThisRun.has(key)) {
        plan.sameRunCollision.push({ libraryId: candidate.libraryId, discNumber, objectKeys: candidateKeys });
        continue;
      }
      claimedThisRun.add(key);
      plan.toInsert.push(candidate);
      continue;
    }

    if (existing.status === 'bound') {
      const boundKeys = [...(boundFileKeys.get(existing.id) ?? [])];
      if (!sameKeySet(candidateKeys, boundKeys)) {
        plan.boundDrift.push({
          assetId: existing.id,
          libraryId: candidate.libraryId,
          discNumber,
          candidateKeys,
          boundKeys,
        });
      }
      continue;
    }

    if (existing.status === 'rejected') {
      if (candidateKeys.some((k) => rebindKeys.has(k))) {
        // The same-run collision guard covers reopens too, not just fresh
        // slots: two candidates resolving to one rejected slot (a
        // `freeform/` copy and a `rotation/Heavy/` copy, say) with a rebind
        // file naming a key from each would otherwise both reopen the SAME
        // asset id -- putting a duplicate id in the VALUES-join UPDATE and
        // pushing both albums' files onto one asset.
        if (claimedThisRun.has(key)) {
          plan.sameRunCollision.push({ libraryId: candidate.libraryId, discNumber, objectKeys: candidateKeys });
          continue;
        }
        claimedThisRun.add(key);
        plan.rejectedReopened.push({ assetId: existing.id, matched: candidate });
      } else {
        plan.rejectedBlocked.push({ libraryId: candidate.libraryId, discNumber, objectKeys: candidateKeys });
      }
      continue;
    }

    // 'needs_review' -- already awaiting a human decision. Untouched, so a
    // re-run of the whole job is a no-op for this slot.
  }

  return plan;
};

/** Get-or-create the `azuracast` store row. No trigger on this table -- cheap regardless. */
export const ensureStore = async (): Promise<number> => {
  await db
    .insert(digital_asset_store)
    .values({ name: STORE_NAME })
    .onConflictDoNothing({ target: digital_asset_store.name });
  const [row] = await db
    .select({ id: digital_asset_store.id })
    .from(digital_asset_store)
    .where(eq(digital_asset_store.name, STORE_NAME));
  return row.id;
};

export const loadExistingSlots = async (libraryIds: readonly number[]): Promise<ExistingSlot[]> => {
  if (libraryIds.length === 0) return [];
  const rows = await db
    .select({
      id: digital_asset.id,
      libraryId: digital_asset.library_id,
      discNumber: digital_asset.disc_number,
      status: digital_asset.status,
    })
    .from(digital_asset)
    .where(and(eq(digital_asset.provenance, PROVENANCE), inArray(digital_asset.library_id, [...libraryIds])));
  return rows;
};

export const loadBoundFileKeys = async (assetIds: readonly number[]): Promise<Map<number, string[]>> => {
  const result = new Map<number, string[]>();
  if (assetIds.length === 0) return result;
  const rows = await db
    .select({ assetId: digital_asset_file.asset_id, objectKey: digital_asset_file.object_key })
    .from(digital_asset_file)
    .where(inArray(digital_asset_file.asset_id, [...assetIds]));
  for (const row of rows) {
    const keys = result.get(row.assetId) ?? [];
    keys.push(row.objectKey);
    result.set(row.assetId, keys);
  }
  return result;
};

export interface WriteCounts {
  inserted: number;
  reopened: number;
  filesWritten: number;
}

const fileRowOf = (assetId: number, storeId: number, file: MatchedAlbum['candidate']['files'][number]) => ({
  asset_id: assetId,
  store_id: storeId,
  object_key: file.objectKey,
  codec: file.codec,
  bitrate_kbps: null,
  track_number: file.tags.track,
  title: file.tags.title ?? file.objectKey,
  duration_secs: file.tags.durationMs !== null ? file.tags.durationMs / 1000 : null,
  bytes: file.bytes,
  md5: file.md5,
  sha256: null,
  flac_md5: null,
  tag_artist: file.tags.artist,
  tag_album: file.tags.album,
  tag_track: file.tags.track !== null ? String(file.tags.track) : null,
});

/**
 * Largest number of rows to put in one multi-row INSERT.
 *
 * postgres.js writes the Bind message's parameter count as an int16, so a
 * single statement can carry at most 65,535 bind parameters, and drizzle
 * emits one parameter per explicitly-provided column value (nulls included;
 * only `undefined` becomes DEFAULT). `fileRowOf` supplies 15 columns, so an
 * unchunked `digital_asset_file` INSERT overflows at 4,369 rows -- against a
 * Space holding ~23,500 files. 1,000 rows is 15,000 parameters at today's
 * widest row, leaving room for several more columns before this constant
 * needs revisiting. Chunking costs nothing on the watermark because the
 * whole phase is one transaction (see this file's header).
 */
const INSERT_CHUNK_ROWS = 1_000;

const chunk = <T>(rows: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

/**
 * Execute a plan, atomically. Every statement runs in one transaction, which
 * is what bounds the watermark to a single advance and what keeps assets and
 * their files from committing separately (see this file's header for both).
 * The inventory/tag-read phases stay outside it -- everything needed is
 * already in memory by the time this is called.
 */
export const executeWrites = async (plan: WritePlan, storeId: number): Promise<WriteCounts> =>
  db.transaction(async (tx) => {
    let inserted = 0;
    let reopened = 0;
    const fileRows: ReturnType<typeof fileRowOf>[] = [];

    if (plan.toInsert.length > 0) {
      // Attach files to assets by SLOT, never by the position of the
      // `RETURNING` rows. Postgres does not document row order for
      // `INSERT ... VALUES ... RETURNING`, and chunking makes the old
      // positional correspondence wrong across chunk boundaries as well.
      // A divergence there would attach every album's files to a different
      // album's asset -- silent mass mis-binding, no error, no failing test.
      // `(library_id, disc_number)` is unique here because `provenance` is
      // the constant PROVENANCE, matching the table's unique index.
      const assetIdBySlot = new Map<string, number>();
      for (const group of chunk(plan.toInsert, INSERT_CHUNK_ROWS)) {
        const returned = await tx
          .insert(digital_asset)
          .values(
            group.map((m) => ({
              library_id: m.libraryId,
              provenance: PROVENANCE,
              disc_number: m.candidate.discNumber,
              status: 'needs_review' as const,
              bind_note: m.bindNote,
            }))
          )
          .returning({
            id: digital_asset.id,
            library_id: digital_asset.library_id,
            disc_number: digital_asset.disc_number,
          });
        for (const row of returned) assetIdBySlot.set(slotKey(row.library_id, row.disc_number), row.id);
        inserted += returned.length;
      }

      for (const m of plan.toInsert) {
        const key = slotKey(m.libraryId, m.candidate.discNumber);
        const assetId = assetIdBySlot.get(key);
        // Unreachable unless the INSERT silently dropped a row. Throwing
        // rolls the whole transaction back, which is the point: a partial
        // write here is the state no re-run can repair.
        if (assetId === undefined) throw new Error(`digital_asset INSERT returned no row for slot ${key}`);
        for (const file of m.candidate.files) fileRows.push(fileRowOf(assetId, storeId, file));
      }
    }

    if (plan.rejectedReopened.length > 0) {
      // Single VALUES-join UPDATE, matching the shape in
      // docs/bulk-update-playbook.md.
      const values = sql.join(
        plan.rejectedReopened.map((r) => sql`(${r.assetId}::int, ${r.matched.bindNote}::text)`),
        sql`, `
      );
      await tx.execute(sql`
        UPDATE ${digital_asset} AS d
           SET status = 'needs_review', bind_note = v.bind_note
          FROM (VALUES ${values}) AS v(id, bind_note)
         WHERE d.id = v.id
      `);
      reopened = plan.rejectedReopened.length;

      const reopenedIds = plan.rejectedReopened.map((r) => r.assetId);
      await tx.delete(digital_asset_file).where(inArray(digital_asset_file.asset_id, reopenedIds));
      for (const r of plan.rejectedReopened) {
        for (const file of r.matched.candidate.files) fileRows.push(fileRowOf(r.assetId, storeId, file));
      }
    }

    for (const group of chunk(fileRows, INSERT_CHUNK_ROWS)) {
      await tx.insert(digital_asset_file).values(group);
    }

    return { inserted, reopened, filesWritten: fileRows.length };
  });

export interface ApplyDecisionsResult {
  boundAttempted: number;
  rejectedAttempted: number;
  rowsUpdated: number;
}

/**
 * `--import <path>` step 5: write back exactly the rows a reviewer decided.
 * Guarded `WHERE status = 'needs_review'` -- "the review import only
 * transitions `needs_review` -> `bound|rejected`" (issue constraints), so a
 * CSV re-imported after a row was already decided (by this run or a
 * concurrent one) can't flip it a second time. One VALUES-join UPDATE for
 * the whole file, matching the watermark-bound shape above.
 */
export const applyReviewDecisions = async (
  decisions: readonly { assetId: number; decision: 'bound' | 'rejected'; note?: string | null }[]
): Promise<ApplyDecisionsResult> => {
  if (decisions.length === 0) return { boundAttempted: 0, rejectedAttempted: 0, rowsUpdated: 0 };

  const values = sql.join(
    decisions.map((d) => sql`(${d.assetId}::int, ${d.decision}::text, ${d.note ?? null}::text)`),
    sql`, `
  );
  // The reviewer's note is APPENDED to `bind_note`, not written over it: the
  // existing value holds the matcher's own evidence (`exact`,
  // `fuzzy:relaxed-key`), which is what a later reader needs in order to
  // judge whether a rejection was the matcher's fault or the tags'. An empty
  // note leaves the column untouched.
  const result = await db.execute(sql`
    UPDATE ${digital_asset} AS d
       SET status = v.decision,
           bind_note = CASE
                         WHEN NULLIF(v.note, '') IS NULL THEN d.bind_note
                         ELSE COALESCE(d.bind_note || ' | ', '') || 'review: ' || v.note
                       END
      FROM (VALUES ${values}) AS v(id, decision, note)
     WHERE d.id = v.id AND d.status = 'needs_review'
  `);

  return {
    boundAttempted: decisions.filter((d) => d.decision === 'bound').length,
    rejectedAttempted: decisions.filter((d) => d.decision === 'rejected').length,
    rowsUpdated: Number((result as unknown as { count?: number }).count ?? 0),
  };
};
