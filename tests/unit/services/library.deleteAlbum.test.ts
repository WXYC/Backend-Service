/**
 * Guards for `deleteAlbumFromDB` in `apps/backend/services/library.service.ts`
 * (BS#2112) — the repo's only endpoint that destroys catalog rows, so the
 * properties below are correctness barriers rather than coverage.
 *
 * BS#2565 (D1) removed the 409 refusal this transaction used to raise when
 * the release carried `flowsheet` plays, along with the three SELECTs that
 * counted them. Nothing here queries `flowsheet` at all any more — the
 * transaction takes exactly three locked SELECTs (library existence,
 * rotation ids, digital_asset rows) regardless of how many plays the release
 * carries, and every path a play can reach a release by is left entirely to
 * the database's own FK actions. Findings pinned here:
 *
 *  1. **The two remaining locks are check-AND-act, not check-then-act, for the
 *     things that still refuse.** `db.transaction()` runs at READ COMMITTED;
 *     without the `FOR UPDATE` on the library row, a concurrent
 *     `digital_asset` INSERT could land between the `has_digital_assets`
 *     check and the delete-through and be destroyed unseen. The lock must be
 *     `FOR UPDATE`: `FOR NO KEY UPDATE` does NOT conflict with the
 *     `FOR KEY SHARE` an inserting writer's FK check takes, so it would not
 *     block anything.
 *
 *  2. **The rotation lock is taken for its lock alone.** `rotation.album_id`
 *     is `cascade` and `flowsheet.rotation_id` is `set null`, so deleting a
 *     release blanks `rotation_id` on plays whose own `album_id` is NULL —
 *     routine, since the tubafrenzy webhook resolves the two independently —
 *     but nothing here counts or reads those rows; the lock exists to fence
 *     the `rotation_urls` capture's atomicity, not a play count.
 *
 *  3. **The delete is durable.** The release's `legacy_release_id` is written
 *     to `library_delete_denylist` inside the same transaction, or
 *     `jobs/library-etl` re-imports the still-present upstream row under a new
 *     `library.id` the next time anything re-selects it upstream.
 *
 *  4. **A play linked only by `legacy_release_id` is stranded, not merely
 *     unlinked — and nothing here can see it happen.** The column carries no
 *     FK, so there is no lock to take and no SELECT to run against it; a play
 *     sitting in that window is invisible to this transaction entirely, and
 *     deleting the release strands it permanently because the denylist
 *     guarantees no future `library` row ever carries that legacy id.
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

// `addBreadcrumb` is what the lock-contention arm records instead of a Sentry
// issue, and its payload carries the SQLSTATE — so it needs to be observable.
// Mocking the module (rather than `jest.spyOn`) because @sentry/node's ESM
// namespace exports aren't configurable; every other export stays real.
jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return { ...actual, addBreadcrumb: jest.fn() };
});

import * as fs from 'fs';
import * as path from 'path';
import * as Sentry from '@sentry/node';
import {
  album_review_submissions,
  captureCatalogDeleteSnapshot,
  db,
  digital_asset,
  library,
  reviews,
} from '@wxyc/database';

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

/**
 * The args handed to the (mocked) `captureCatalogDeleteSnapshot`. The capture
 * itself is doubled in `tests/mocks/database.mock.ts`, so its call args are
 * the only place the children list is observable without a database.
 */
const captureArgs = () => {
  const capture = captureCatalogDeleteSnapshot as unknown as {
    mock: { calls: Array<[unknown, { entityIdColumn: unknown; children: unknown[] }]> };
  };
  expect(capture.mock.calls).toHaveLength(1);
  return capture.mock.calls[0][1];
};

// SELECT order inside the delete transaction, unconditional regardless of how
// many plays the release carries or how it is linked: existence (locked) ->
// rotation ids (locked, for the lock alone — nothing binds the result) ->
// digital_asset rows (locked). Fixtures below that stop short of all three
// rely on `makeTx`'s `?? []` default rather than spelling out an empty result
// for every case.
const EXISTS = [{ id: 42, legacy_release_id: 7788 }];
const NO_ROTATION: unknown[] = [];
const NO_ASSETS: unknown[] = [];

/** A clean release: no rotation rows, no bound digital asset. */
const CLEAN = [EXISTS, NO_ROTATION, NO_ASSETS];

/**
 * A Postgres rejection in the shape the catch block ACTUALLY sees.
 *
 * postgres-js puts the SQLSTATE on `error.code`, but nothing here ever sees a
 * bare driver error: drizzle-orm wraps every query rejection in a
 * `DrizzleQueryError` whose own `message` is the generic `Failed query: …`,
 * whose own `code` is `undefined`, and whose `.cause` is the driver error
 * (`drizzle-orm/errors.js`; the wrap is unconditional, in
 * `pg-core/session.js`'s `queryWithCache`). A double that throws a bare
 * `{ code }` passes against a classifier reading only `error.code` while
 * production fails every stand-down — so the wrapped shape is the default and
 * `bare` is the opt-out that pins the fallback path. Same pair of builders as
 * `tests/unit/jobs/legacy-linkage-resolve/job.test.ts`.
 */
const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const drizzleWrapped = (cause: Error): Error => Object.assign(new Error('Failed query: <sql>\nparams: '), { cause });

describe('deleteAlbumFromDB (BS#2112)', () => {
  // BS#2565 (D1) removed the 409 refusal these locks used to gate the
  // decision for. What is left to fence is narrower: the has_digital_assets
  // check-and-act, and the rotation_urls capture's atomicity — neither has
  // anything to do with a play count. See
  // `libraryService.deleteAlbumFromDB`'s Concurrency paragraph.
  describe('row locks taken before the delete (finding 1)', () => {
    it('takes FOR UPDATE on the library row as the very first SELECT', async () => {
      const { ops } = await runDelete(42, CLEAN);

      const selects = ops.filter((o) => o.op === 'select');
      expect(selects[0].methods).toContain('for(update)');
    });

    it('takes FOR UPDATE on the release rotation rows, which the library-row lock does not cover', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], NO_ASSETS]);

      const rotationSelect = ops.filter((o) => o.op === 'select')[1];
      expect(rotationSelect.methods).toContain('for(update)');
    });

    it('takes FOR UPDATE on the digital_asset rows, which neither of the other two locks covers', async () => {
      const { ops } = await runDelete(42, CLEAN);

      const assetSelect = ops.filter((o) => o.op === 'select')[2];
      expect(assetSelect.methods).toContain('for(update)');
    });

    it('pins FOR UPDATE rather than FOR NO KEY UPDATE in the source', () => {
      const body = deleteAlbumBody();
      expect(body).toContain("for('update')");
      expect(body).not.toContain("for('no key update')");
    });
  });

  // BS#2565 (D1). Nothing in the transaction queries `flowsheet` any more —
  // the three SELECTs above are the whole of it, regardless of whether the
  // release carries plays or how they reach it.
  describe('no flowsheet awareness left (finding 2)', () => {
    it('issues exactly three locked SELECTs on a clean release', async () => {
      const { ops } = await runDelete(42, CLEAN);

      expect(ops.filter((o) => o.op === 'select')).toHaveLength(3);
    });

    it('issues the same three SELECTs when the release has rotation rows', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], NO_ASSETS]);

      expect(ops.filter((o) => o.op === 'select')).toHaveLength(3);
    });

    it('never references the flowsheet table in the transaction body', () => {
      // The docstring and inline comments are allowed to talk about
      // `flowsheet` — plenty of them do, reasoning about what the database's
      // own FK actions do to it — but no query in the transaction body may
      // touch it. `.from(flowsheet` / `.delete(flowsheet` would be the
      // tell-tale shape of a count or a refusal creeping back in.
      const body = deleteAlbumBody();
      expect(body).not.toContain('.from(flowsheet');
      expect(body).not.toContain('.delete(flowsheet');
    });

    it('deletes through regardless of how many rotation rows the release carries', async () => {
      const { ops } = await runDelete(42, [EXISTS, [{ id: 900 }], NO_ASSETS]);

      expect(ops.some((o) => o.op === 'delete' && o.table === library)).toBe(true);
      expect(ops.some((o) => o.op === 'insert')).toBe(true);
    });
  });

  describe('durability against the library ETL (finding 3)', () => {
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
   * `flowsheet.legacy_release_id` carries no FK, so this transaction cannot
   * lock it, query it, or even see a play that carries only it. Deleting the
   * release still strands that play permanently — the denylist row this
   * transaction writes guarantees no future `library` row will ever carry
   * this `legacy_release_id` for `jobs/legacy-linkage-resolve` to join to —
   * it is simply a fact about the database's own state after the delete
   * commits, not something this transaction decides or observes.
   */
  describe('the legacy-id path is invisible here, and that is the point (finding 4)', () => {
    it('takes no lock and runs no query keyed on legacy_release_id', () => {
      const body = deleteAlbumBody();
      // The column is read once, off the existence SELECT, to populate the
      // denylist row — never queried or locked on its own.
      expect(body).not.toContain('.where(eq(flowsheet.legacy_release_id');
    });

    it('deletes through regardless — there is nothing here to refuse on', async () => {
      const { outcome } = await runDelete(42, CLEAN);

      expect(outcome).toEqual({ outcome: 'deleted' });
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
    ])('maps a drizzle-wrapped SQLSTATE %s to lock_unavailable rather than a 500', async (code) => {
      // Wrapped, because that is the only shape production throws. Pinning
      // this against the bare form alone is how the 503 path came to be dead
      // code with a green suite.
      const error = drizzleWrapped(pgError(code, 'canceling statement due to lock timeout'));
      const { outcome } = await runDelete(42, CLEAN, { throwOn: { op: 'select', error } });

      expect(outcome).toEqual({ outcome: 'lock_unavailable' });
    });

    it.each([['55P03'], ['40P01']])(
      'stands down on a bare driver error too — the wrapper is preferred, not required',
      async (code) => {
        const error = pgError(code, 'canceling statement due to lock timeout');
        const { outcome } = await runDelete(42, CLEAN, { throwOn: { op: 'select', error } });

        expect(outcome).toEqual({ outcome: 'lock_unavailable' });
      }
    );

    it('breadcrumbs the real SQLSTATE, not the wrapper’s undefined .code', async () => {
      // The breadcrumb is the only record a stand-down leaves (no Sentry
      // issue), so reading the code off the wrapper rather than its cause
      // would make it `undefined` for every stand-down it exists to explain.
      const addBreadcrumb = Sentry.addBreadcrumb as jest.MockedFunction<typeof Sentry.addBreadcrumb>;
      const error = drizzleWrapped(pgError('55P03', 'canceling statement due to lock timeout'));

      await runDelete(42, CLEAN, { throwOn: { op: 'select', error } });

      expect(addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'library.delete',
          data: expect.objectContaining({ album_id: 42, code: '55P03' }),
        })
      );
    });

    it('does not mistake an unrelated wrapped error for lock contention', async () => {
      const error = drizzleWrapped(pgError('23503', 'insert or update violates foreign key'));
      await expect(runDelete(42, CLEAN, { throwOn: { op: 'select', error } })).rejects.toThrow('Failed query');
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

  /**
   * `digital_asset.library_id` is NOT NULL with no `onDelete` at all — no
   * cascade, no set-null — so an unguarded `DELETE FROM library` raises a
   * raw FK-violation 500. This is the check-and-act refusal that catches it
   * before the delete ever reaches that statement (BS#2560 finding 2a) — the
   * only refusal left in this transaction post-BS#2565.
   */
  describe('digital_asset guard (BS#2560 finding 2a)', () => {
    it('refuses with has_digital_assets, naming the bound asset, rather than reaching the DELETE', async () => {
      const asset = { id: 501, provenance: 'rotation_upload', disc_number: 1, status: 'needs_review' };
      const { outcome, ops } = await runDelete(42, [EXISTS, NO_ROTATION, [asset]]);

      expect(outcome).toEqual({
        outcome: 'has_digital_assets',
        assets: [{ id: 501, provenance: 'rotation_upload', discNumber: 1, status: 'needs_review' }],
      });
      expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0);
      expect(ops.filter((o) => o.op === 'insert')).toHaveLength(0);
    });

    it('names every bound asset when more than one exists', async () => {
      const assets = [
        { id: 501, provenance: 'rotation_upload', disc_number: 1, status: 'needs_review' },
        { id: 502, provenance: 'cd_rip', disc_number: 2, status: 'bound' },
      ];
      const { outcome } = await runDelete(42, [EXISTS, NO_ROTATION, assets]);

      expect(outcome).toEqual({
        outcome: 'has_digital_assets',
        assets: [
          { id: 501, provenance: 'rotation_upload', discNumber: 1, status: 'needs_review' },
          { id: 502, provenance: 'cd_rip', discNumber: 2, status: 'bound' },
        ],
      });
    });

    it('proceeds past the guard, and into the capture, when no digital_asset row is bound', async () => {
      const { outcome, ops } = await runDelete(42, CLEAN);

      expect(outcome).toEqual({ outcome: 'deleted' });
      expect(ops.some((o) => o.op === 'delete')).toBe(true);
    });

    /**
     * BS#2560 review finding 2. Refusing on EVERY status made a release
     * permanently undeletable through the API, because nothing in this service
     * can clear or delete a `digital_asset` row — so a reviewer rejecting a
     * mis-bound asset was enough to strand the release forever, recoverable
     * only by hand-written SQL against prod. `merge.ts` already deletes
     * through this table on a merge for the same recoverability reason.
     */
    describe('rejected assets are not blockers (BS#2560 review finding 2)', () => {
      const rejected = { id: 501, provenance: 'rotation_upload', disc_number: 1, status: 'rejected' };

      it('deletes a release whose only asset was rejected, rather than refusing forever', async () => {
        const { outcome } = await runDelete(42, [EXISTS, NO_ROTATION, [rejected]]);

        expect(outcome).toEqual({ outcome: 'deleted' });
      });

      it('deletes the rejected asset through, scoped to the ids it locked and captured', async () => {
        const { ops } = await runDelete(42, [EXISTS, NO_ROTATION, [rejected]]);

        // Scoped to the locked ids rather than to `library_id`: a row that
        // appeared outside that set must raise the FK violation on the
        // library delete instead of being destroyed unseen.
        expect(ops.some((o) => o.op === 'delete' && o.table === digital_asset)).toBe(true);
      });

      it('captures the rejected asset and its files before deleting through them', async () => {
        await runDelete(42, [EXISTS, NO_ROTATION, [rejected]]);

        const { children } = captureArgs();
        expect(children).toContain(digital_asset.library_id);
        // The depth-2 file child carries the object keys of the S3 objects the
        // cascade orphans, which is what keeps the owed re-bind findable.
        expect(children).toEqual(expect.arrayContaining([expect.objectContaining({ via: expect.anything() })]));
      });

      it('still refuses when a live asset sits alongside a rejected one, naming only the live one', async () => {
        const live = { id: 502, provenance: 'cd_rip', disc_number: 2, status: 'needs_review' };
        const { outcome, ops } = await runDelete(42, [EXISTS, NO_ROTATION, [rejected, live]]);

        expect(outcome).toEqual({
          outcome: 'has_digital_assets',
          assets: [{ id: 502, provenance: 'cd_rip', discNumber: 2, status: 'needs_review' }],
        });
        expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0);
      });

      it('refuses on a status the vocabulary has not grown yet, rather than deleting through it', async () => {
        // `status` is an open vocabulary; the predicate is "everything except
        // rejected" so a future value blocks by default.
        const future = { id: 503, provenance: 'cd_rip', disc_number: 1, status: 'ripped' };
        const { outcome } = await runDelete(42, [EXISTS, NO_ROTATION, [future]]);

        expect(outcome).toEqual({
          outcome: 'has_digital_assets',
          assets: [{ id: 503, provenance: 'cd_rip', discNumber: 1, status: 'ripped' }],
        });
      });
    });
  });

  /**
   * BS#2560 review, SECURITY. `album_review_submissions` must never be in the
   * capture's `children` list, for two independent reasons (both written out
   * on the capture itself): the row SURVIVES the delete (`onDelete: 'set
   * null'`), so a capture preserves nothing; and the capture reads with an
   * unprojected `tx.select()`, so listing the table copies `reviewer_raw` /
   * `social_consent_raw` — real names collected under a "your name will not
   * be shared" promise — into a permanently-retained jsonb column, becoming
   * the second reader ADR 0011 forbids. This asserts on the args handed to
   * the (mocked) helper, which is the only place the list is observable
   * without a database.
   */
  describe('snapshot capture children (BS#2560 PII exclusion)', () => {
    it('captures reviews but never album_review_submissions', async () => {
      const { outcome } = await runDelete(42, CLEAN);
      expect(outcome).toEqual({ outcome: 'deleted' });

      const { children } = captureArgs();
      // Children are bare FK columns now (the table and the JSON key are
      // derived from the column), so the assertion is on column identity —
      // and the mock maps every column to a table-qualified sentinel, so this
      // fails however the table is reintroduced.
      expect(children).toContain(reviews.album_id);
      expect(children).not.toContain(album_review_submissions.album_id);
    });

    it('names the parent id column so the deleted library row is captured too', async () => {
      await runDelete(42, CLEAN);

      // Without this the snapshot holds the subtree but not the row being
      // deleted — and for a Backend-minted release there is no upstream row to
      // restore the parent from, so nothing else records what it said.
      expect(captureArgs().entityIdColumn).toBe(library.id);
    });
  });

  it('returns not_found without taking any further action', async () => {
    const { outcome, ops } = await runDelete(999, [[]]);

    expect(outcome).toEqual({ outcome: 'not_found' });
    // The lock_timeout statement plus the existence check, and nothing else.
    expect(ops).toHaveLength(2);
  });
});
