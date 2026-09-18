/**
 * Unit tests for shared/database/src/catalog-delete-snapshot.ts (BS#2560 /
 * F1). Tests the REAL module directly (bypassing the package-level
 * `@wxyc/database` mock, mirroring tests/unit/database/account-audit.test.ts
 * and concerts-recompute.test.ts) with a hand-rolled `tx` double, so this
 * pins the helper's OWN contract rather than exercising it only through
 * `deleteAlbumFromDB` (which jest-mocks this helper entirely — see
 * `tests/mocks/database.mock.ts`'s `captureCatalogDeleteSnapshot` double).
 *
 * That mock-everywhere gap was a review finding on the original PR: nothing
 * unit-level proved the `batchId` grouping contract, an `entityKind` other
 * than `'library'`, a zero-row-but-INCLUDED child (vs. one simply absent
 * from `children`), or that `actor_email`/`actor_role` are threaded through
 * — all of which WXYC/Backend-Service#2562's artist delete leans on
 * immediately. Pinned here so #2562 inherits a helper whose contract is
 * actually tested, not just its one `entityKind: 'library'` call site.
 *
 * **`jest.unmock('drizzle-orm')` is load-bearing, and replaces a wrong
 * explanation.** An earlier revision of this file said `getTableName`
 * "doesn't survive this suite's ts-jest/CJS interop for `drizzle-orm`'s root
 * export". That was false, and it mattered, because it was cited as the
 * reason not to derive a captured child's key from its column in PRODUCTION.
 * The real cause was `tests/__mocks__/drizzle-orm.ts` — a manual node-module
 * mock, applied automatically to every unit spec — which omits `getTableName`
 * and `getTableColumns` entirely and replaces `inArray` with a `jest.fn`.
 * Unmocking the root export here gets the real functions, so the derivation
 * this helper now depends on is exercised rather than worked around, and the
 * `via` branch builds its subquery with the real `inArray` instead of a mock
 * that records its arguments. (`drizzle-orm/pg-core`, which `schema.ts`
 * builds its tables from, was never mocked — so unmocking the root makes the
 * two consistent rather than mixing a real table with a fake operator.)
 *
 * What is still NOT proven here is that the `via` subquery is correct SQL: a
 * hand double can satisfy `isSQLWrapper` without a planner ever seeing the
 * statement. That proof is `tests/integration/library-delete.spec.js`'s
 * `rotation_urls` round-trip against the real database. What IS pinned here
 * is that the `via` wiring reads the PARENT table for the id lookup and the
 * CHILD table for the rows, not the reverse.
 */
jest.unmock('drizzle-orm');

import { getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { captureCatalogDeleteSnapshot, type DbTransaction } from '../../../shared/database/src/catalog-delete-snapshot';
import { bins, library, reviews, rotation, rotation_urls } from '../../../shared/database/src/schema';

type Captured = {
  entity: { table: string; row: Record<string, unknown> | null };
  children: Record<string, unknown[]>;
};
type Insert = { batch_id: string; entity_kind: string; entity_id: number; captured: Captured } & Record<
  string,
  unknown
>;

/**
 * A `.where(...)` result has to be BOTH awaitable (the capture awaits the
 * depth-1 read, and `.limit(1)` / `.for('share')` return the same chain) and
 * shaped like a Drizzle `SQLWrapper` — `typeof value.getSQL === 'function'`,
 * duck-typed per `drizzle-orm/sql/sql.js`'s `isSQLWrapper` — because the
 * depth-2 path hands an UN-awaited `.where(...)` result straight to
 * `inArray(...)` as a subquery. `getSQL` returns a real `SQL` fragment rather
 * than `{}` so the wrapper is genuine under the unmocked drizzle.
 *
 * Keyed by TABLE OBJECT REFERENCE rather than by name: reference identity is
 * the more precise assertion, distinguishing `rotation` from `rotation_urls`
 * even where a name would round-trip. The derived KEY is asserted separately,
 * against `getTableName`, which is the whole point of deriving it.
 */
const makeFakeTx = (rowsByTable: Map<PgTable, unknown[]>) => {
  const selectedTables: PgTable[] = [];
  const lockModes: string[] = [];
  const inserts: Insert[] = [];

  const select = () => ({
    from: (table: PgTable) => ({
      where: (_whereExpr: unknown) => {
        selectedTables.push(table);
        const query = Promise.resolve(rowsByTable.get(table) ?? []) as Promise<unknown[]> & {
          getSQL: () => unknown;
          limit: (n: number) => unknown;
          for: (mode: string) => unknown;
        };
        query.getSQL = () => sql`1`;
        query.limit = () => query;
        query.for = (mode: string) => {
          lockModes.push(mode);
          return query;
        };
        return query;
      },
    }),
  });

  const insert = (_table: unknown) => ({
    values: (vals: Insert) => {
      inserts.push(vals);
      return Promise.resolve();
    },
  });

  return {
    tx: { select, insert } as unknown as DbTransaction,
    selectedTables,
    lockModes,
    inserts,
  };
};

const capturedOf = (inserts: Insert[]): Captured => inserts[0].captured;

describe('captureCatalogDeleteSnapshot (BS#2560)', () => {
  it('captures one row set per child, keyed by the table name DERIVED from the column', async () => {
    const { tx, inserts } = makeFakeTx(
      new Map<PgTable, unknown[]>([
        [library, [{ id: 42, album_title: 'DOGA' }]],
        [bins, [{ id: 1, album_id: 42 }]],
        [reviews, [{ id: 2, album_id: 42, review: 'probe' }]],
      ])
    );

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id, reviews.album_id],
    });

    expect(inserts).toHaveLength(1);
    // The keys are `getTableName(column.table)`, not string literals a call
    // site typed — that derivation is what makes a table/column mismatch
    // unrepresentable, so it is asserted against `getTableName` itself.
    expect(capturedOf(inserts).children).toEqual({
      [getTableName(bins)]: [{ id: 1, album_id: 42 }],
      [getTableName(reviews)]: [{ id: 2, album_id: 42, review: 'probe' }],
    });
    expect(Object.keys(capturedOf(inserts).children)).toEqual(['bins', 'reviews']);
  });

  it('captures the deleted PARENT row under `entity`, namespaced away from every child', async () => {
    const parentRow = { id: 42, album_title: 'DOGA', label: 'Sonamos', discogs_unavailable: false };
    const { tx, inserts } = makeFakeTx(
      new Map<PgTable, unknown[]>([
        [library, [parentRow]],
        [bins, [{ id: 1, album_id: 42 }]],
      ])
    );

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });

    const captured = capturedOf(inserts);
    expect(captured.entity).toEqual({ table: 'library', row: parentRow });
    // The envelope is the collision guard: a child can never shadow `entity`,
    // and `entity.table` disambiguates an `entity_kind` that isn't a table
    // name (`'artist'` / `artists`).
    expect(Object.keys(captured)).toEqual(['entity', 'children']);
    expect(captured.children.library).toBeUndefined();
  });

  it('records a null parent row rather than throwing when the parent read comes back empty', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });

    expect(capturedOf(inserts).entity).toEqual({ table: 'library', row: null });
  });

  /**
   * The capture's own lock (BS#2560 review finding 1). `db.transaction()` runs
   * at READ COMMITTED and Postgres takes no lock on a referenced parent row
   * for an UPDATE that leaves the FK column alone, so without `FOR SHARE` a
   * concurrent edit to a captured child commits between the capture and the
   * cascade and is destroyed with only its pre-edit version snapshotted.
   */
  it('takes FOR SHARE on every child read, and no lock on the parent read', async () => {
    const { tx, lockModes } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id, reviews.album_id],
    });

    // Two children, two FOR SHARE reads. The parent read takes none — the
    // caller already holds that row FOR UPDATE.
    expect(lockModes).toEqual(['share', 'share']);
  });

  it('includes a captured child as an empty array, distinct from a child never passed at all', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });

    const { children } = capturedOf(inserts);
    expect(children.bins).toEqual([]);
    expect('reviews' in children).toBe(false);
  });

  it('plumbs an entityKind other than "library" straight through', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'artist',
      entityId: 7,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });

    expect(inserts[0].entity_kind).toBe('artist');
    expect(inserts[0].entity_id).toBe(7);
  });

  it('groups two calls under one caller-supplied batchId, the #2562 artist+release grouping mechanism', async () => {
    const first = makeFakeTx(new Map());
    const second = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(first.tx, {
      entityKind: 'artist',
      entityId: 7,
      entityIdColumn: library.id,
      children: [bins.album_id],
      batchId: 'shared-batch-id',
    });
    await captureCatalogDeleteSnapshot(second.tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [reviews.album_id],
      batchId: 'shared-batch-id',
    });

    expect(first.inserts[0].batch_id).toBe('shared-batch-id');
    expect(second.inserts[0].batch_id).toBe('shared-batch-id');
  });

  it('mints a fresh batchId per call when none is supplied, rather than sharing one across unrelated deletes', async () => {
    const a = makeFakeTx(new Map());
    const b = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(a.tx, {
      entityKind: 'library',
      entityId: 1,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });
    await captureCatalogDeleteSnapshot(b.tx, {
      entityKind: 'library',
      entityId: 2,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });

    expect(typeof a.inserts[0].batch_id).toBe('string');
    expect(a.inserts[0].batch_id).not.toBe(b.inserts[0].batch_id);
  });

  it('threads every actor field through to the insert, and NULLs a field the caller omitted', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id],
      actor: { userId: 'user-1', email: 'md@wxyc.org', role: null },
    });

    expect(inserts[0].actor_user_id).toBe('user-1');
    expect(inserts[0].actor_email).toBe('md@wxyc.org');
    expect(inserts[0].actor_role).toBeNull();
  });

  it('NULLs every actor field when no actor is supplied at all, rather than throwing', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [bins.album_id],
    });

    expect(inserts[0].actor_user_id).toBeNull();
    expect(inserts[0].actor_email).toBeNull();
    expect(inserts[0].actor_role).toBeNull();
  });

  /**
   * The depth-2 shape. Not a SQL-correctness proof (see the file docstring) —
   * this pins that the `via` parent lookup resolves against the PARENT table
   * (`rotation`) while the outer read resolves against the CHILD table
   * (`rotation_urls`), and that the child's key is derived from the child's
   * own column rather than the parent's. Both are wiring mistakes a
   * hand-written `via` literal can make.
   */
  it('resolves a via child by reading the parent table for the id lookup and the child table for the rows', async () => {
    const { tx, selectedTables, inserts } = makeFakeTx(
      new Map<PgTable, unknown[]>([
        [library, [{ id: 42 }]],
        [rotation, [{ id: 900 }]],
        [rotation_urls, [{ id: 1, rotation_id: 900, url: 'https://example.com' }]],
      ])
    );

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      entityIdColumn: library.id,
      children: [{ column: rotation_urls.rotation_id, via: { column: rotation.album_id, idColumn: rotation.id } }],
    });

    // Parent read first, then the via id lookup against `rotation`, then the
    // child rows from `rotation_urls`.
    expect(selectedTables).toEqual([library, rotation, rotation_urls]);
    expect(capturedOf(inserts).children[getTableName(rotation_urls)]).toEqual([
      { id: 1, rotation_id: 900, url: 'https://example.com' },
    ]);
    // Keyed on the CHILD table, not the parent it was reached through.
    expect(capturedOf(inserts).children.rotation).toBeUndefined();
  });
});
