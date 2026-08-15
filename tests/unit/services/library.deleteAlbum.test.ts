/**
 * Guards for `deleteAlbumFromDB` in `apps/backend/services/library.service.ts`
 * (BS#2112) — the repo's only endpoint that destroys catalog rows, so the
 * properties below are correctness barriers rather than coverage.
 *
 * Three review findings are pinned here:
 *
 *  1. **The guard is check-AND-act, not check-then-act.** `db.transaction()`
 *     runs at READ COMMITTED; without a row lock, a writer attaching
 *     `flowsheet.album_id` between the count and the DELETE gets its play
 *     blanked by the `set null` RI action — the exact failure the 409 exists
 *     to prevent. Three live writers reach that column
 *     (`flowsheet.service.ts`, `internal.route.ts`,
 *     `jobs/legacy-linkage-resolve/job.ts`). The lock must be `FOR UPDATE`:
 *     `FOR NO KEY UPDATE` does NOT conflict with the `FOR KEY SHARE` an
 *     inserting writer's FK check takes, so it would not block anything.
 *
 *  2. **The refusal counts the transitive path too.** `rotation.album_id` is
 *     `cascade` and `flowsheet.rotation_id` is `set null`, so a delete also
 *     blanks `rotation_id` on plays whose own `album_id` is NULL — routine,
 *     since the tubafrenzy webhook resolves the two independently.
 *
 *  3. **The delete is durable.** The release's `legacy_release_id` is written
 *     to `library_delete_denylist` inside the same transaction, or
 *     `jobs/library-etl` re-imports the still-present upstream row within 30
 *     minutes under a new `library.id`.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { db, library } from '@wxyc/database';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/library.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

const deleteAlbumBody = (): string => {
  const match = serviceSource.match(/export const deleteAlbumFromDB[\s\S]*?\n\};/);
  if (!match) throw new Error('deleteAlbumFromDB not found in library.service.ts');
  return match[0];
};

type RecordedOp = { op: string; table: unknown; methods: string[] };

/**
 * Minimal drizzle-shaped transaction double. Each builder call records the
 * operation and the method chain applied to it (including `.for(<mode>)`),
 * and is thenable so `await` resolves the next queued SELECT result.
 * `createMockQueryChain` can't be reused here: it has no `.for()`, and it
 * returns one shared chain, which would collapse the per-statement ordering
 * these assertions depend on.
 */
const makeTx = (selectResults: unknown[][]) => {
  const ops: RecordedOp[] = [];
  let selectIndex = 0;

  const start = (op: string, table: unknown) => {
    const record: RecordedOp = { op, table, methods: [] };
    ops.push(record);

    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'values', 'set', 'onConflictDoUpdate']) {
      chain[method] = (arg: unknown) => {
        record.methods.push(method);
        if (method === 'from') record.table = arg;
        return chain;
      };
    }
    chain.for = (mode: string) => {
      record.methods.push(`for(${mode})`);
      return chain;
    };
    chain.then = (resolve: (value: unknown) => void) => {
      resolve(op === 'select' ? (selectResults[selectIndex++] ?? []) : []);
    };
    return chain;
  };

  return {
    ops,
    tx: {
      select: () => start('select', undefined),
      insert: (table: unknown) => start('insert', table),
      update: (table: unknown) => start('update', table),
      delete: (table: unknown) => start('delete', table),
    },
  };
};

const loadService = async () => import('../../../apps/backend/services/library.service');

const runDelete = async (albumId: number, selectResults: unknown[][]) => {
  const { ops, tx } = makeTx(selectResults);
  (db as unknown as { transaction: unknown }).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const { deleteAlbumFromDB } = await loadService();
  const outcome = await deleteAlbumFromDB(albumId);
  return { outcome, ops };
};

// SELECT order inside deleteAlbumFromDB: existence (locked) → rotation ids
// (locked) → direct play count → transitive play count (only when the
// release has rotation rows).
const EXISTS = [{ id: 42, legacy_release_id: 7788 }];
const NO_ROTATION: unknown[] = [];
const zero = [{ count: 0 }];

describe('deleteAlbumFromDB (BS#2112)', () => {
  describe('check-then-act race on the play-count guard (finding 2)', () => {
    it('takes FOR UPDATE on the library row before counting plays', async () => {
      const { ops } = await runDelete(42, [EXISTS, NO_ROTATION, zero]);

      const existenceSelect = ops[0];
      expect(existenceSelect.op).toBe('select');
      expect(existenceSelect.methods).toContain('for(update)');

      // The lock must precede the count, or it isn't a lock at all.
      const firstCount = ops.findIndex((o) => o.op === 'select' && !o.methods.some((m) => m.startsWith('for(')));
      expect(firstCount).toBeGreaterThan(0);
    });

    it('takes FOR UPDATE on the release rotation rows, which the library-row lock does not cover', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], zero, zero]);

      const rotationSelect = ops[1];
      expect(rotationSelect.op).toBe('select');
      expect(rotationSelect.methods).toContain('for(update)');
    });

    it('pins FOR UPDATE rather than FOR NO KEY UPDATE in the source', () => {
      const body = deleteAlbumBody();
      expect(body).toContain("for('update')");
      expect(body).not.toContain("for('no key update')");
    });
  });

  describe('transitive rotation path in the refusal (finding 3)', () => {
    it('refuses when the only plays reach the release through its rotation entry', async () => {
      const { outcome } = await runDelete(42, [EXISTS, [{ id: 900 }], zero, [{ count: 12 }]]);

      expect(outcome).toEqual({
        outcome: 'has_flowsheet_plays',
        playCount: 12,
        directPlayCount: 0,
        rotationLinkedPlayCount: 12,
      });
    });

    it('sums both paths without double-counting', async () => {
      const { outcome } = await runDelete(42, [EXISTS, [{ id: 900 }], [{ count: 3 }], [{ count: 4 }]]);

      expect(outcome).toEqual({
        outcome: 'has_flowsheet_plays',
        playCount: 7,
        directPlayCount: 3,
        rotationLinkedPlayCount: 4,
      });
    });

    it('skips the transitive count entirely when the release has no rotation rows', async () => {
      const { outcome, ops } = await runDelete(42, [EXISTS, NO_ROTATION, zero]);

      expect(outcome).toEqual({ outcome: 'deleted' });
      expect(ops.filter((o) => o.op === 'select')).toHaveLength(3);
    });

    it('deletes nothing when either path refuses', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], zero, [{ count: 1 }]]);

      expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0);
      expect(ops.filter((o) => o.op === 'insert')).toHaveLength(0);
    });
  });

  describe('durability against the library ETL (finding 1)', () => {
    it('tombstones the legacy_release_id before deleting the row', async () => {
      const { ops } = await runDelete(42, [EXISTS, NO_ROTATION, zero]);

      const insertIdx = ops.findIndex((o) => o.op === 'insert');
      const libraryDeleteIdx = ops.findIndex((o) => o.op === 'delete' && o.table === library);
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(libraryDeleteIdx).toBeGreaterThan(insertIdx);
    });

    it('upserts rather than plain-inserts, so a stale tombstone cannot fail the delete', async () => {
      const { ops } = await runDelete(42, [EXISTS, NO_ROTATION, zero]);

      const insert = ops.find((o) => o.op === 'insert');
      expect(insert?.methods).toEqual(expect.arrayContaining(['values', 'onConflictDoUpdate']));
    });
  });

  describe('unreferenced dependents (finding 7)', () => {
    it('nulls album_popularity.representative_library_id, which no FK protects', async () => {
      const { ops } = await runDelete(42, [EXISTS, NO_ROTATION, zero]);

      const updates = ops.filter((o) => o.op === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0].methods).toEqual(expect.arrayContaining(['set', 'where']));
    });
  });

  it('returns not_found without taking any further action', async () => {
    const { outcome, ops } = await runDelete(999, [[]]);

    expect(outcome).toEqual({ outcome: 'not_found' });
    expect(ops).toHaveLength(1);
  });
});
