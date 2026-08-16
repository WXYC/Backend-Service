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
 *     `jobs/library-etl` re-imports the still-present upstream row under a new
 *     `library.id` the next time anything re-selects it upstream.
 *
 *  4. **The refusal counts the legacy-id path too.** A play the tubafrenzy
 *     webhook wrote carries `flowsheet.legacy_release_id` and gets its
 *     `album_id` from `jobs/legacy-linkage-resolve` later; in that window both
 *     counts above read zero, and deleting makes it permanent because the
 *     denylist guarantees no future `library` row carries that legacy id.
 *
 *  5. **Lock waits are bounded, and the delete is the side that yields.**
 *     `SET LOCAL lock_timeout` below the default `deadlock_timeout` means a
 *     lock-order inversion against a live flowsheet INSERT costs the
 *     librarian a retryable 503, never a DJ an aborted play.
 *
 *  6. **The delete records who did it.** `catalog:write` is held by two roles,
 *     so what-and-when without who leaves incident response unable to tell a
 *     legitimate deletion from an abusive one.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { db, library } from '@wxyc/database';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/library.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

const deleteAlbumBody = (): string => {
  const match = serviceSource.match(/const runDeleteAlbumTransaction[\s\S]*?\n\};/);
  if (!match) throw new Error('runDeleteAlbumTransaction not found in library.service.ts');
  return match[0];
};

type RecordedOp = { op: string; table: unknown; methods: string[]; arg?: unknown };

/**
 * Minimal drizzle-shaped transaction double. Each builder call records the
 * operation and the method chain applied to it (including `.for(<mode>)`),
 * and is thenable so `await` resolves the next queued SELECT result.
 * `createMockQueryChain` can't be reused here: it has no `.for()`, and it
 * returns one shared chain, which would collapse the per-statement ordering
 * these assertions depend on.
 */
const makeTx = (selectResults: unknown[][], throwOn?: { op: string; error: unknown }) => {
  const ops: RecordedOp[] = [];
  let selectIndex = 0;

  const start = (op: string, table: unknown) => {
    const record: RecordedOp = { op, table, methods: [] };
    ops.push(record);
    if (throwOn && throwOn.op === op) {
      throw throwOn.error;
    }

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
      execute: (arg: unknown) => {
        ops.push({ op: 'execute', table: undefined, methods: [], arg });
        return Promise.resolve([]);
      },
    },
  };
};

const loadService = async () => import('../../../apps/backend/services/library.service');

type Actor = { userId?: string | null; email?: string | null; role?: string | null };

const runDelete = async (
  albumId: number,
  selectResults: unknown[][],
  options: { actor?: Actor; throwOn?: { op: string; error: unknown } } = {}
) => {
  const { ops, tx } = makeTx(selectResults, options.throwOn);
  (db as unknown as { transaction: unknown }).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const { deleteAlbumFromDB } = await loadService();
  const outcome = await deleteAlbumFromDB(albumId, options.actor);
  return { outcome, ops };
};

// SELECT order inside the delete transaction: existence (locked) → rotation
// ids (locked) → direct play count → transitive play count (only when the
// release has rotation rows) → legacy-id play count (always).
const EXISTS = [{ id: 42, legacy_release_id: 7788 }];
const NO_ROTATION: unknown[] = [];
const zero = [{ count: 0 }];

/** A clean release: no rotation rows, no plays by any of the three paths. */
const CLEAN = [EXISTS, NO_ROTATION, zero, zero];

describe('deleteAlbumFromDB (BS#2112)', () => {
  describe('check-then-act race on the play-count guard (finding 2)', () => {
    it('takes FOR UPDATE on the library row before counting plays', async () => {
      const { ops } = await runDelete(42, CLEAN);

      const lockIdx = ops.findIndex((o) => o.op === 'select');
      expect(ops[lockIdx].methods).toContain('for(update)');

      // The lock must precede the count, or it isn't a lock at all.
      const firstCount = ops.findIndex((o) => o.op === 'select' && !o.methods.some((m) => m.startsWith('for(')));
      expect(firstCount).toBeGreaterThan(lockIdx);
    });

    it('takes FOR UPDATE on the release rotation rows, which the library-row lock does not cover', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], zero, zero, zero]);

      const rotationSelect = ops.filter((o) => o.op === 'select')[1];
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
      const { outcome } = await runDelete(42, [EXISTS, [{ id: 900 }], zero, [{ count: 12 }], zero]);

      expect(outcome).toEqual({
        outcome: 'has_flowsheet_plays',
        playCount: 12,
        directPlayCount: 0,
        rotationLinkedPlayCount: 12,
        legacyLinkedPlayCount: 0,
      });
    });

    it('sums every path without double-counting', async () => {
      const { outcome } = await runDelete(42, [EXISTS, [{ id: 900 }], [{ count: 3 }], [{ count: 4 }], [{ count: 5 }]]);

      expect(outcome).toEqual({
        outcome: 'has_flowsheet_plays',
        playCount: 12,
        directPlayCount: 3,
        rotationLinkedPlayCount: 4,
        legacyLinkedPlayCount: 5,
      });
    });

    it('skips the transitive count entirely when the release has no rotation rows', async () => {
      const { outcome, ops } = await runDelete(42, CLEAN);

      expect(outcome).toEqual({ outcome: 'deleted' });
      // existence + rotation ids + direct count + legacy-id count.
      expect(ops.filter((o) => o.op === 'select')).toHaveLength(4);
    });

    it('deletes nothing when any path refuses', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], zero, [{ count: 1 }], zero]);

      expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0);
      expect(ops.filter((o) => o.op === 'insert')).toHaveLength(0);
    });
  });

  /**
   * Plays the tubafrenzy webhook wrote carrying only `legacy_release_id`,
   * whose `album_id` `jobs/legacy-linkage-resolve` has not yet resolved. Both
   * counts above read zero for them, and deleting is worse than blanking: the
   * denylist means no future `library` row will ever carry that legacy id, so
   * the resolver can never link them and the provenance is stranded for good.
   */
  describe('legacy-id path in the refusal (finding 4)', () => {
    it('refuses when the only plays name the release by its legacy release id', async () => {
      const { outcome } = await runDelete(42, [EXISTS, NO_ROTATION, zero, [{ count: 6 }]]);

      expect(outcome).toEqual({
        outcome: 'has_flowsheet_plays',
        playCount: 6,
        directPlayCount: 0,
        rotationLinkedPlayCount: 0,
        legacyLinkedPlayCount: 6,
      });
    });

    it('counts the legacy path even when the release has no rotation rows at all', async () => {
      const { ops } = await runDelete(42, [EXISTS, NO_ROTATION, zero, zero]);

      // The legacy count is unconditional; it is the transitive count that is
      // skipped when there are no rotation ids.
      expect(ops.filter((o) => o.op === 'select')).toHaveLength(4);
    });

    /**
     * `NOT IN` alone evaluates to NULL for a NULL `rotation_id`, which would
     * silently exclude exactly the unlinked rows this arm exists to count.
     */
    it('tolerates a NULL rotation_id when excluding the transitive arm', () => {
      const body = deleteAlbumBody();
      expect(body).toContain('isNull(flowsheet.rotation_id)');
      expect(body).toContain('notInArray(flowsheet.rotation_id, rotationIds)');
    });
  });

  describe('durability against the library ETL (finding 1)', () => {
    it('tombstones the legacy_release_id before deleting the row', async () => {
      const { ops } = await runDelete(42, CLEAN);

      const insertIdx = ops.findIndex((o) => o.op === 'insert');
      const libraryDeleteIdx = ops.findIndex((o) => o.op === 'delete' && o.table === library);
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(libraryDeleteIdx).toBeGreaterThan(insertIdx);
    });

    it('upserts rather than plain-inserts, so a stale tombstone cannot fail the delete', async () => {
      const { ops } = await runDelete(42, CLEAN);

      const insert = ops.find((o) => o.op === 'insert');
      expect(insert?.methods).toEqual(expect.arrayContaining(['values', 'onConflictDoUpdate']));
    });
  });

  /**
   * The transaction takes library-then-rotation; a flowsheet INSERT carrying
   * both columns takes the same two locks via its RI checks, in constraint-OID
   * order, which is not guaranteed to agree. Rather than reason about OIDs,
   * the transaction bounds its waits below the default 1s `deadlock_timeout`
   * so it is always this side that yields — the librarian retries, the DJ's
   * play insert does not abort.
   */
  describe('bounded lock waits (finding 5)', () => {
    it('sets lock_timeout before taking any lock', async () => {
      const { ops } = await runDelete(42, CLEAN);

      // The very first statement, ahead of the FOR UPDATE. `SET LOCAL` only
      // scopes inside an explicit transaction under postgres-js, which is why
      // it lives here rather than on the pool.
      expect(ops[0].op).toBe('execute');
      expect(JSON.stringify(ops[0].arg)).toContain('lock_timeout');
      expect(deleteAlbumBody()).toContain("SET LOCAL lock_timeout = '${DELETE_ALBUM_LOCK_TIMEOUT_MS}ms'");
    });

    it('keeps the timeout below the default 1s deadlock_timeout', async () => {
      const { DELETE_ALBUM_LOCK_TIMEOUT_MS } = await loadService();
      expect(DELETE_ALBUM_LOCK_TIMEOUT_MS).toBeLessThan(1000);
      expect(DELETE_ALBUM_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it.each([
      ['55P03', 'lock_not_available — our own lock_timeout fired'],
      ['40P01', 'deadlock_detected — we were chosen as the victim'],
    ])('maps SQLSTATE %s to lock_unavailable rather than a 500', async (code) => {
      const error = Object.assign(new Error('lock'), { code });
      const { outcome } = await runDelete(42, CLEAN, { throwOn: { op: 'select', error } });

      expect(outcome).toEqual({ outcome: 'lock_unavailable' });
    });

    it('rethrows any other database error', async () => {
      const error = Object.assign(new Error('boom'), { code: '23503' });
      await expect(runDelete(42, CLEAN, { throwOn: { op: 'select', error } })).rejects.toThrow('boom');
    });
  });

  /**
   * `catalog:write` is held by two roles, so a denylist row naming only the
   * release and the timestamp leaves incident response unable to tell a
   * legitimate deletion from an abusive one.
   */
  describe('actor attribution (finding 6)', () => {
    it('records the authenticated subject on the denylist row', async () => {
      const { ops } = await runDelete(42, CLEAN, {
        actor: { userId: 'user-1', email: 'md@wxyc.org', role: 'musicDirector' },
      });

      const insert = ops.find((o) => o.op === 'insert');
      expect(insert?.methods).toEqual(expect.arrayContaining(['values', 'onConflictDoUpdate']));
      const body = deleteAlbumBody();
      expect(body).toContain('deleted_by_user_id: actor.userId ?? null');
      expect(body).toContain('deleted_by_email: actor.email ?? null');
      expect(body).toContain('deleted_by_role: actor.role ?? null');
    });

    /**
     * A thin token (AUTH_BYPASS, or a payload with no `id`) must cost the
     * audit trail, never the delete. Refusing here would trade a durable gap
     * for a broken endpoint.
     */
    it('still deletes when no actor is available', async () => {
      const { outcome, ops } = await runDelete(42, CLEAN);

      expect(outcome).toEqual({ outcome: 'deleted' });
      expect(ops.some((o) => o.op === 'delete' && o.table === library)).toBe(true);
    });

    it('overwrites the attribution on a re-delete rather than keeping the first one', () => {
      const body = deleteAlbumBody();
      const setClause = body.slice(body.indexOf('onConflictDoUpdate'));
      expect(setClause).toContain('...attribution');
    });
  });

  describe('unreferenced dependents (finding 7)', () => {
    it('nulls album_popularity.representative_library_id, which no FK protects', async () => {
      const { ops } = await runDelete(42, CLEAN);

      const updates = ops.filter((o) => o.op === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0].methods).toEqual(expect.arrayContaining(['set', 'where']));
    });

    /**
     * `library_identity_history` is the other FK-less reference to
     * `library.id`, and it is deliberately LEFT dangling — a supersedure audit
     * log has to outlive the row it describes. Pinned so a later "tidy up the
     * orphans" change has to argue with this test first.
     */
    it('leaves library_identity_history alone on purpose', () => {
      const body = deleteAlbumBody();
      expect(body).not.toContain('library_identity_history');
      expect(serviceSource).toContain('`library_identity_history` is the one reference deliberately LEFT dangling');
    });
  });

  it('returns not_found without taking any further action', async () => {
    const { outcome, ops } = await runDelete(999, [[]]);

    expect(outcome).toEqual({ outcome: 'not_found' });
    // The lock_timeout statement plus the existence check, and nothing else.
    expect(ops).toHaveLength(2);
  });
});
