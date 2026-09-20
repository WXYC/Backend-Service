/**
 * Guards for `restoreDeletedBatch` in `apps/backend/services/library.service.ts`
 * (BS#2585 / F2b) — the only endpoint that writes rows back into the catalog
 * from an archive, so the properties below are correctness barriers rather than
 * coverage.
 *
 * The integration tier (`tests/integration/library-restore-deleted.spec.js`)
 * owns the end-to-end replay against a migrated Postgres. What CAN and must be
 * pinned without a database is everything that is a decision rather than a
 * round trip, and one of those is load-bearing enough to name up front:
 *
 * **The slot key is genre-scoped, and this file goes RED against a genre-blind
 * one.** Two independent tests cover it, because the key is applied in two
 * places from one definition: `probeLibrarySlot`'s WHERE clause narrows to the
 * shelf (`artist_id`, `genre_id`), and `librarySlotKey` decides occupancy over
 * the rows that come back. Dropping `genre_id` from EITHER half fails a test
 * here — tamper-verified in both directions, not assumed:
 *
 *   - removing `eq(library.genre_id, slot.genre_id)` from the probe predicate
 *     fails "narrows the shelf on artist AND genre";
 *   - removing `row.genre_id` from `librarySlotKey` fails "a release in a
 *     DIFFERENT genre holding the same code number is not a collision".
 *
 * That second one is the whole point. Measured against production on
 * 2026-09-18, the genre-blind `albumCodeNumberTaken` predicate sees 3,308
 * apparent collisions where the true slot key sees 273 — 3,035 restores that
 * would be needlessly declined or relocated.
 *
 * The rest:
 *
 *  1. **One transaction, FK order, parent first.** The INSERT sequence is
 *     asserted as a sequence: the parent before any child, `rotation` before
 *     `rotation_urls`, `digital_asset` before `digital_asset_file`. Those two
 *     pairs are depth-2 FKs (`rotation_urls.rotation_id` -> `rotation.id`), so
 *     an inverted order is a `23503` that takes the batch down.
 *  2. **Neither refusal writes anything.** A conflict with no `resolution`, and
 *     a conflict answered `decline`, both reach the end having issued zero
 *     INSERTs — checked by counting statements, not by trusting the outcome tag.
 *  3. **A failed child replay rolls the batch back.** The function REJECTS
 *     rather than returning `restored`; there is no arm that reports a partial
 *     success.
 *  4. **The five excluded dependents are never synthesized**, and nothing
 *     reaches `album_review_submissions` — the ADR-0011 PII barrier. Asserted
 *     over the statements AND over the source text of the restore block, so a
 *     future `RESTORE_PLAN` entry cannot add one quietly.
 *  5. **The ETL block is lifted.** A surviving `library_delete_denylist` row
 *     makes `jobs/library-etl` report the restore as a stranded resurrection
 *     and exit non-zero on every run.
 *  6. **Lock waits are bounded and the restore is the side that yields**, same
 *     as the delete path, and a contention SQLSTATE becomes
 *     `lock_unavailable` (503) rather than a 500. The rejection double builds
 *     drizzle's WRAPPED shape, per `shared/database/src/sqlstate.ts`: a bare
 *     `{ code }` cannot reproduce production and left this exact arm dead
 *     against a passing suite once already.
 */

import { jest } from '@jest/globals';

// `addBreadcrumb` records the stand-down instead of a Sentry issue, so it has
// to be observable. Mocking the module (not `jest.spyOn`) because @sentry/node's
// ESM namespace exports aren't configurable.
jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return { ...actual, addBreadcrumb: jest.fn() };
});

import * as fs from 'fs';
import * as path from 'path';
import * as Sentry from '@sentry/node';
import { and, eq } from 'drizzle-orm';
import {
  album_critic_reviews,
  artist_library_crossreference,
  bins,
  catalog_delete_snapshot,
  compilation_track_artist,
  db,
  digital_asset,
  digital_asset_file,
  library,
  library_delete_denylist,
  library_urls,
  reviews,
  rotation,
  rotation_urls,
} from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';
import { restoreDeletedBatch, RESTORE_BATCH_LOCK_TIMEOUT_MS } from '../../../apps/backend/services/library.service';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/library.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

/** Source text of the restore block, for the assertions that are about what it never names. */
const restoreBlockSource = (): string => {
  const start = serviceSource.indexOf('export const RESTORE_BATCH_ADVISORY_LOCK_KEY');
  const end = serviceSource.indexOf('// `tx` (BS#2474)', start);
  if (start === -1 || end === -1) throw new Error('restore block not found in library.service.ts');
  return serviceSource.slice(start, end);
};

type Row = Record<string, unknown>;
type RecordedOp = { op: string; table: unknown; methods: string[]; args: Record<string, unknown>; arg?: unknown };

/** Every table double the restore plan can target, for naming a statement's subject. */
const TABLE_NAMES = new Map<unknown, string>([
  [library, 'library'],
  [rotation, 'rotation'],
  [rotation_urls, 'rotation_urls'],
  [digital_asset, 'digital_asset'],
  [digital_asset_file, 'digital_asset_file'],
  [artist_library_crossreference, 'artist_library_crossreference'],
  [compilation_track_artist, 'compilation_track_artist'],
  [library_urls, 'library_urls'],
  [reviews, 'reviews'],
  [album_critic_reviews, 'album_critic_reviews'],
  [bins, 'bins'],
  [catalog_delete_snapshot, 'catalog_delete_snapshot'],
  [library_delete_denylist, 'library_delete_denylist'],
]);

/**
 * Minimal drizzle-shaped transaction double. `createMockQueryChain` can't be
 * reused: it has no `.for()` and returns one shared chain, which would collapse
 * the per-statement ordering every assertion here depends on. Each builder call
 * records its op, the method chain applied (including `for(<mode>)`) and each
 * method's argument, and is thenable so `await` resolves the next queued SELECT.
 */
const makeTx = (selectResults: unknown[][], throwOnExecuteIndex?: number) => {
  const ops: RecordedOp[] = [];
  let selectIndex = 0;
  let executeIndex = 0;

  const start = (op: string, table: unknown) => {
    const record: RecordedOp = { op, table, methods: [], args: {} };
    ops.push(record);
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'values']) {
      chain[method] = (arg: unknown) => {
        record.methods.push(method);
        record.args[method] = arg;
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
      delete: (table: unknown) => start('delete', table),
      execute: (arg: unknown) => {
        ops.push({ op: 'execute', table: undefined, methods: [], args: {}, arg });
        if (executeIndex++ === throwOnExecuteIndex) {
          return Promise.reject(wrappedPgError('23503'));
        }
        return Promise.resolve([]);
      },
    },
  };
};

/**
 * A database rejection in the shape production actually throws: drizzle wraps
 * every query rejection in a `DrizzleQueryError` whose own `code` is
 * `undefined` and whose `.cause` carries the SQLSTATE. See
 * `shared/database/src/sqlstate.ts`.
 */
const wrappedPgError = (code: string): Error =>
  Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('pg'), { code }) });

const BATCH_ID = '11111111-2222-4333-8444-555555555555';

/** A captured `library` row: every non-generated column, exactly as the capture stores it. */
const capturedLibraryRow = (over: Row = {}): Row => ({
  id: 42,
  artist_id: 7,
  genre_id: 3,
  format_id: 1,
  album_title: 'On Your Own Love Again',
  code_number: 7,
  code_volume_letters: null,
  legacy_release_id: 71234,
  // ISO strings, not Dates — `captured` is jsonb, which is the whole reason the
  // replay goes through `jsonb_populate_recordset` rather than `.values()`.
  add_date: '2019-04-02T00:00:00.000Z',
  last_modified: '2019-04-02T00:00:00.000Z',
  ...over,
});

const snapshotRow = (over: Row = {}): Row => ({
  id: 1,
  batch_id: BATCH_ID,
  entity_kind: 'library',
  entity_id: 42,
  captured: { entity: { table: 'library', row: capturedLibraryRow() }, children: {} },
  captured_at: new Date('2026-09-10T12:00:00Z'),
  actor_user_id: 'librarian-1',
  actor_email: 'md@wxyc.org',
  actor_role: 'musicDirector',
  ...over,
});

/** A shelf row as `probeLibrarySlot` projects it. */
const shelfRow = (over: Row = {}): Row => ({
  id: 99,
  artist_id: 7,
  genre_id: 3,
  code_number: 7,
  code_volume_letters: null,
  ...over,
});

type RunOptions = {
  snapshots?: Row[];
  /** Rows the parent-existence probe answers with. Non-empty means already restored. */
  present?: Row[];
  shelf?: Row[];
  resolution?: 'next_free_code' | 'decline';
  throwOnExecuteIndex?: number;
};

const run = async (options: RunOptions = {}) => {
  const snapshots = options.snapshots ?? [snapshotRow()];
  const selectResults: unknown[][] = [snapshots];
  if (snapshots.length > 0) {
    selectResults.push(options.present ?? []);
    if ((options.present ?? []).length === 0) selectResults.push(options.shelf ?? []);
  }
  const { ops, tx } = makeTx(selectResults, options.throwOnExecuteIndex);
  (db as unknown as { transaction: unknown }).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const outcome = await restoreDeletedBatch(BATCH_ID, options.resolution);
  return { outcome, ops };
};

/**
 * The transaction's SELECTs in order. Position is the only thing that separates
 * two of them: the parent-existence probe and the shelf probe both read
 * `library`, so filtering by table would conflate them.
 *
 *   0 — the batch's `catalog_delete_snapshot` rows
 *   1 — the parent-existence probe (`already_present`)
 *   2 — the shelf probe (`probeLibrarySlot`), reached only when 1 is empty
 */
const selects = (ops: RecordedOp[]): RecordedOp[] => ops.filter((op) => op.op === 'select');

/** Every `execute`d statement, decoded into the table it writes and the rows it carries. */
const insertStatements = (ops: RecordedOp[]): Array<{ table: string; columns: string[]; rows: Row[] }> =>
  ops
    .filter((op) => op.op === 'execute')
    .map((op) => op.arg as { sql?: readonly string[]; values?: readonly unknown[] })
    .filter((chunk) => Array.isArray(chunk.sql) && chunk.sql[0]?.startsWith('INSERT INTO'))
    .map((chunk) => {
      const values = chunk.values ?? [];
      return {
        table: TABLE_NAMES.get(values[0]) ?? 'UNKNOWN',
        columns: renderSql(values[1])
          .split(', ')
          .map((column) => column.replace(/"/g, '')),
        rows: JSON.parse(values[4] as string) as Row[],
      };
    });

const executedText = (ops: RecordedOp[]): string[] =>
  ops.filter((op) => op.op === 'execute').map((op) => renderSql(op.arg));

describe('restoreDeletedBatch (BS#2585 / F2b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('the genre-scoped slot key', () => {
    // TAMPER TARGET 1 — the SQL half. Drop `eq(library.genre_id, ...)` from
    // `probeLibrarySlot`'s predicate and this fails on the `and(...)` argument.
    it('narrows the shelf on artist AND genre, never on artist alone', async () => {
      const { ops } = await run({ shelf: [] });

      const probe = selects(ops)[2];
      expect(probe.table).toBe(library);
      expect(probe.args.where).toEqual(and(eq(library.artist_id, 7), eq(library.genre_id, 3)));
      // Locked, so a librarian cannot renumber a shelf row between the probe
      // and the replay and thereby hide or invent a collision.
      expect(probe.methods).toContain('for(update)');
    });

    // TAMPER TARGET 2 — the TypeScript half, and the one that matters most.
    // Drop `row.genre_id` from `librarySlotKey` and this restore reports a
    // bogus conflict instead of proceeding. This is the 3,035-false-positive
    // case, reduced to one row.
    it('treats a release in a DIFFERENT genre holding the same code number as no collision', async () => {
      const { outcome, ops } = await run({ shelf: [shelfRow({ id: 500, genre_id: 9, code_number: 7 })] });

      expect(outcome).toEqual({
        outcome: 'restored',
        entities: [expect.objectContaining({ entity_id: 42, relocated_code_number: null })],
      });
      expect(insertStatements(ops).map((statement) => statement.table)).toContain('library');
    });

    it('treats the same code number on the same genre shelf as a collision', async () => {
      const { outcome } = await run({ shelf: [shelfRow({ id: 500 })] });

      expect(outcome).toEqual({
        outcome: 'resolution_required',
        conflicts: [
          {
            entity_id: 42,
            artist_id: 7,
            genre_id: 3,
            code_number: 7,
            code_volume_letters: null,
            occupied_by_library_id: 500,
            next_free_code_number: 8,
          },
        ],
      });
    });

    // `D` and `d` are one physical slot: the upstream MySQL catalog compared
    // them case-insensitively, so duplicates exist that Postgres would
    // otherwise read as distinct.
    it('folds the volume letter to upper case on both sides', async () => {
      const captured = capturedLibraryRow({ code_volume_letters: 'D' });
      const { outcome } = await run({
        snapshots: [snapshotRow({ captured: { entity: { table: 'library', row: captured }, children: {} } })],
        shelf: [shelfRow({ id: 501, code_volume_letters: 'd' })],
      });

      expect(outcome).toMatchObject({ outcome: 'resolution_required' });
    });
  });

  describe('the two resolution arms', () => {
    it('refuses an ambiguous request rather than guessing', async () => {
      const { outcome, ops } = await run({ shelf: [shelfRow({ id: 500 })] });

      expect(outcome).toMatchObject({ outcome: 'resolution_required' });
      expect(insertStatements(ops)).toHaveLength(0);
    });

    it('writes nothing when the librarian declines', async () => {
      const { outcome, ops } = await run({ shelf: [shelfRow({ id: 500 })], resolution: 'decline' });

      expect(outcome).toMatchObject({ outcome: 'declined' });
      expect(insertStatements(ops)).toHaveLength(0);
      expect(ops.filter((op) => op.op === 'delete')).toHaveLength(0);
    });

    // MAX(code_number) + 1 over the GENRE-SCOPED shelf, not
    // `generateAlbumCodeNumber`'s artist-wide max.
    it('files the card at the next free code on that shelf when asked to', async () => {
      const { outcome, ops } = await run({
        shelf: [shelfRow({ id: 500, code_number: 7 }), shelfRow({ id: 501, code_number: 11 })],
        resolution: 'next_free_code',
      });

      expect(outcome).toMatchObject({
        outcome: 'restored',
        entities: [expect.objectContaining({ relocated_code_number: 12 })],
      });
      const parent = insertStatements(ops).find((statement) => statement.table === 'library');
      expect(parent?.rows[0]).toMatchObject({ id: 42, code_number: 12 });
    });

    // A resolution against a batch with a free slot is moot, not an error: the
    // client cannot know whether the slot is free before it asks.
    it('ignores a resolution when nothing conflicts', async () => {
      const { outcome, ops } = await run({ shelf: [], resolution: 'next_free_code' });

      expect(outcome).toMatchObject({
        outcome: 'restored',
        entities: [expect.objectContaining({ relocated_code_number: null })],
      });
      const parent = insertStatements(ops).find((statement) => statement.table === 'library');
      expect(parent?.rows[0]).toMatchObject({ code_number: 7 });
    });
  });

  describe('FK-ordered replay', () => {
    const withChildren = () =>
      snapshotRow({
        captured: {
          entity: { table: 'library', row: capturedLibraryRow() },
          children: {
            bins: [{ id: 1, album_id: 42, dj_id: 5 }],
            rotation_urls: [{ id: 3, rotation_id: 8, url: 'https://example.test/a' }],
            rotation: [{ id: 8, album_id: 42, play_freq: 'H' }],
            digital_asset_file: [{ id: 4, asset_id: 9, object_key: 'k' }],
            digital_asset: [{ id: 9, library_id: 42, status: 'rejected' }],
            reviews: [{ id: 2, album_id: 42, author: 'dj' }],
          },
        },
      });

    it('writes the parent first, then every depth-2 child after its own parent', async () => {
      const { ops } = await run({ snapshots: [withChildren()] });

      const order = insertStatements(ops).map((statement) => statement.table);
      expect(order[0]).toBe('library');
      expect(order.indexOf('rotation')).toBeLessThan(order.indexOf('rotation_urls'));
      expect(order.indexOf('digital_asset')).toBeLessThan(order.indexOf('digital_asset_file'));
      expect(order.indexOf('library')).toBeLessThan(order.indexOf('bins'));
    });

    it('reports per-child replay counts and skips child tables with no captured rows', async () => {
      const { outcome, ops } = await run({ snapshots: [withChildren()] });

      expect(outcome).toMatchObject({
        outcome: 'restored',
        entities: [
          expect.objectContaining({
            entity_kind: 'library',
            entity_id: 42,
            table: 'library',
            children: expect.objectContaining({ bins: 1, rotation: 1, rotation_urls: 1, library_urls: 0 }),
          }),
        ],
      });
      // `library_urls` reports 0 and issues no statement — an empty INSERT is
      // a round trip for nothing.
      expect(insertStatements(ops).map((statement) => statement.table)).not.toContain('library_urls');
    });

    // The column list is the captured row's own keys, which IS the insertable
    // set: the capture omits generated columns (`library.search_doc`), which
    // Postgres recomputes and refuses to be handed a value for. A `SELECT *`
    // out of `jsonb_populate_recordset` would try to write it.
    it('names exactly the captured columns, and replays ids verbatim', async () => {
      const { ops } = await run();

      const parent = insertStatements(ops).find((statement) => statement.table === 'library');
      expect(parent?.columns).toEqual(Object.keys(capturedLibraryRow()));
      expect(parent?.columns).not.toContain('search_doc');
      expect(parent?.rows[0]).toMatchObject({ id: 42 });
      expect(executedText(ops).some((text) => text.includes('jsonb_populate_recordset'))).toBe(true);
    });

    it('lifts the library ETL re-import block for the restored release', async () => {
      const { ops } = await run();

      const denylistDeletes = ops.filter((op) => op.op === 'delete' && op.table === library_delete_denylist);
      expect(denylistDeletes).toHaveLength(1);
      expect(denylistDeletes[0].args.where).toEqual(eq(library_delete_denylist.legacy_release_id, 71234));
    });
  });

  describe('the five dependents that are never synthesized', () => {
    const EXCLUDED = [
      'album_metadata',
      'library_identity',
      'library_identity_source',
      'uncovered_release_search_markers',
      'album_review_submissions',
    ];

    // A corrupt or malicious envelope naming an excluded table must not get it
    // written: the replay walks RESTORE_PLAN's list, never the envelope's keys.
    it('ignores excluded tables even when the envelope carries rows for them', async () => {
      const children = Object.fromEntries(EXCLUDED.map((table) => [table, [{ id: 1, album_id: 42 }]]));
      const { ops } = await run({
        snapshots: [snapshotRow({ captured: { entity: { table: 'library', row: capturedLibraryRow() }, children } })],
      });

      expect(insertStatements(ops).map((statement) => statement.table)).toEqual(['library']);
    });

    // ADR 0011: `album_review_submissions.reviewer_raw` holds real names
    // collected under a promise they would not be shared, and the barrier is
    // that one enumerated projection is its only reader. A restore is not a
    // permitted read site, and re-pointing a surviving submission at a restored
    // release is its own issue with its own PII review.
    it('never names album_review_submissions anywhere in the restore block', () => {
      for (const table of EXCLUDED) {
        expect(restoreBlockSource()).not.toContain(`['${table}',`);
      }
      expect(restoreBlockSource()).not.toMatch(/tx\.(select|insert|delete|update)\([^)]*album_review_submissions/);
    });
  });

  describe('404, 503 and rollback', () => {
    it('answers not_found for a batch id no snapshot row carries', async () => {
      const { outcome, ops } = await run({ snapshots: [] });

      expect(outcome).toEqual({ outcome: 'not_found' });
      expect(insertStatements(ops)).toHaveLength(0);
    });

    // Checked BEFORE the slot probe on purpose: an already-restored batch has
    // its own row sitting in its own slot, so probing first would report the
    // restored card as its own collision and offer to relocate it.
    it('answers already_present without probing the shelf', async () => {
      const { outcome, ops } = await run({ present: [{ id: 42 }] });

      expect(outcome).toEqual({ outcome: 'already_present', entity_ids: [42] });
      expect(selects(ops)).toHaveLength(2);
      expect(insertStatements(ops)).toHaveLength(0);
    });

    it('bounds every lock wait below deadlock_timeout, then takes the restore advisory lock', async () => {
      const { ops } = await run({ snapshots: [] });

      const statements = executedText(ops);
      expect(RESTORE_BATCH_LOCK_TIMEOUT_MS).toBeLessThan(1000);
      expect(statements[0]).toBe(`SET LOCAL lock_timeout = '${RESTORE_BATCH_LOCK_TIMEOUT_MS}ms'`);
      expect(statements[1]).toContain('pg_advisory_xact_lock');
    });

    it.each([
      ['55P03', 'our own lock_timeout fired'],
      ['40P01', 'we were chosen as the deadlock victim'],
    ])('stands down with lock_unavailable on %s (%s)', async (code) => {
      (db as unknown as { transaction: unknown }).transaction = jest
        .fn()
        .mockImplementation(() => Promise.reject(wrappedPgError(code)));

      await expect(restoreDeletedBatch(BATCH_ID)).resolves.toEqual({ outcome: 'lock_unavailable' });
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'library.restore', data: expect.objectContaining({ code }) })
      );
    });

    // No arm reports a partial success: a child INSERT that fails propagates,
    // the transaction rolls back, and the caller gets a rejection.
    it('rejects rather than reporting a partial restore when a child replay fails', async () => {
      // Execute 0 is the lock_timeout, 1 the advisory lock, 2 the parent
      // INSERT — so 3 is the first child.
      await expect(
        run({
          snapshots: [
            snapshotRow({
              captured: {
                entity: { table: 'library', row: capturedLibraryRow() },
                children: { bins: [{ id: 1, album_id: 42, dj_id: 5 }] },
              },
            }),
          ],
          throwOnExecuteIndex: 3,
        })
      ).rejects.toThrow('Failed query');
    });
  });
});
