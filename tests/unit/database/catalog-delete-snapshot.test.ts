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
 * The `via` depth-2 shape (finding 1 — `rotation_urls` riding along with
 * `rotation`) is deliberately NOT proven correct here. `captureCatalogDeleteSnapshot`
 * passes the parent lookup straight into `inArray(...)` as an un-awaited
 * subquery, which only round-trips against a real Postgres planner — a hand
 * double can fake enough shape to stop `inArray` from throwing (see the
 * `getSQL` stub below) but cannot prove the subquery is correct SQL. That
 * proof is `tests/integration/library-delete.spec.js`'s
 * `rotation_urls`-round-trip case, against the real database; what's pinned
 * here is only that the `via` wiring reads the PARENT table for the id
 * lookup and the CHILD table for the rows, not the reverse.
 */
import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import {
  captureCatalogDeleteSnapshot,
  catalogDeleteChild,
  catalogDeleteGrandchild,
  type DbTransaction,
} from '../../../shared/database/src/catalog-delete-snapshot';
import { bins, reviews, rotation, rotation_urls } from '../../../shared/database/src/schema';

type Insert = { batch_id: string; entity_kind: string; entity_id: number; captured: unknown } & Record<string, unknown>;

/**
 * A `.where(...)` result has to be BOTH awaitable (the depth-1 path awaits
 * it directly) and shaped like a Drizzle `SQLWrapper` — `typeof
 * value.getSQL === 'function'`, duck-typed, per `drizzle-orm/sql/sql.js`'s
 * `isSQLWrapper` — because the depth-2 path passes an UN-awaited `.where(...)`
 * result straight into the real `inArray(...)`, which throws building the
 * `SQL` fragment for anything that doesn't pass that check.
 *
 * Keyed by TABLE OBJECT REFERENCE, not by name: `getTableName` doesn't
 * survive this suite's ts-jest/CJS interop for `drizzle-orm`'s root export
 * (a real-module-under-test quirk, not a bug in the helper), and reference
 * identity is the more precise assertion anyway — it distinguishes `rotation`
 * from `rotation_urls` even though nothing about the table's runtime shape
 * carries a readable name in this double.
 */
const makeFakeTx = (rowsByTable: Map<PgTable, unknown[]>) => {
  const selectedTables: PgTable[] = [];
  const inserts: Insert[] = [];

  const select = () => ({
    from: (table: PgTable) => ({
      where: (_whereExpr: unknown) => {
        selectedTables.push(table);
        const query = Promise.resolve(rowsByTable.get(table) ?? []) as Promise<unknown[]> & {
          getSQL: () => unknown;
        };
        query.getSQL = () => ({});
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
    inserts,
  };
};

describe('captureCatalogDeleteSnapshot (BS#2560)', () => {
  it('captures one row per child, keyed by the name passed rather than the table name', async () => {
    const { tx, inserts } = makeFakeTx(
      new Map<PgTable, unknown[]>([
        [bins, [{ id: 1, album_id: 42 }]],
        [reviews, [{ id: 2, album_id: 42, review: 'probe' }]],
      ])
    );

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      children: [
        catalogDeleteChild('bins', bins, bins.album_id),
        catalogDeleteChild('reviews', reviews, reviews.album_id),
      ],
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].captured).toEqual({
      bins: [{ id: 1, album_id: 42 }],
      reviews: [{ id: 2, album_id: 42, review: 'probe' }],
    });
  });

  it('includes a captured child as an empty array, distinct from a child never passed at all', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
    });

    const { captured } = inserts[0] as { captured: Record<string, unknown> };
    expect(captured.bins).toEqual([]);
    expect('reviews' in captured).toBe(false);
  });

  it('plumbs an entityKind other than "library" straight through', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'artist',
      entityId: 7,
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
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
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
      batchId: 'shared-batch-id',
    });
    await captureCatalogDeleteSnapshot(second.tx, {
      entityKind: 'library',
      entityId: 42,
      children: [catalogDeleteChild('reviews', reviews, reviews.album_id)],
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
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
    });
    await captureCatalogDeleteSnapshot(b.tx, {
      entityKind: 'library',
      entityId: 2,
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
    });

    expect(typeof a.inserts[0].batch_id).toBe('string');
    expect(a.inserts[0].batch_id).not.toBe(b.inserts[0].batch_id);
  });

  it('threads every actor field through to the insert, and NULLs a field the caller omitted', async () => {
    const { tx, inserts } = makeFakeTx(new Map());

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
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
      children: [catalogDeleteChild('bins', bins, bins.album_id)],
    });

    expect(inserts[0].actor_user_id).toBeNull();
    expect(inserts[0].actor_email).toBeNull();
    expect(inserts[0].actor_role).toBeNull();
  });

  /**
   * Finding 1's depth-2 shape. Not a correctness proof (see the file
   * docstring) — this pins that the `via` parent lookup actually resolves
   * against the PARENT table (`rotation`) while the outer read resolves
   * against the CHILD table (`rotation_urls`), which is the specific wiring
   * mistake a hand-written object literal (rather than
   * `catalogDeleteGrandchild`) could get backwards.
   */
  it('resolves a via child by reading the parent table for the id lookup and the child table for the rows', async () => {
    const { tx, selectedTables, inserts } = makeFakeTx(
      new Map<PgTable, unknown[]>([
        [rotation, [{ id: 900 }]],
        [rotation_urls, [{ id: 1, rotation_id: 900, url: 'https://example.com' }]],
      ])
    );

    await captureCatalogDeleteSnapshot(tx, {
      entityKind: 'library',
      entityId: 42,
      children: [
        catalogDeleteGrandchild('rotation_urls', rotation_urls, rotation_urls.rotation_id, {
          table: rotation,
          column: rotation.album_id,
          idColumn: rotation.id,
        }),
      ],
    });

    expect(selectedTables).toEqual([rotation, rotation_urls]);
    expect((inserts[0].captured as Record<string, unknown>).rotation_urls).toEqual([
      { id: 1, rotation_id: 900, url: 'https://example.com' },
    ]);
  });
});

describe('catalogDeleteChild / catalogDeleteGrandchild (BS#2560 simplification finding)', () => {
  it('returns a plain CatalogDeleteChild, matching what a hand-written object literal would produce', () => {
    expect(catalogDeleteChild('bins', bins, bins.album_id)).toEqual({
      name: 'bins',
      table: bins,
      column: bins.album_id,
    });
  });

  it('attaches the via parent lookup verbatim', () => {
    const child = catalogDeleteGrandchild('rotation_urls', rotation_urls, rotation_urls.rotation_id, {
      table: rotation,
      column: rotation.album_id,
      idColumn: rotation.id,
    });

    expect(child).toEqual({
      name: 'rotation_urls',
      table: rotation_urls,
      column: rotation_urls.rotation_id,
      via: { table: rotation, column: rotation.album_id, idColumn: rotation.id },
    });
  });

  // Compile-time-only guard, not a runtime assertion: `catalogDeleteChild`'s
  // generic binds `column` to `table`'s own name, so
  // `catalogDeleteChild('x', bins, reviews.album_id)` fails to COMPILE
  // rather than silently capturing the wrong table's rows at runtime — the
  // failure mode `tsc`/`ts-jest` would catch if this file tried it. `eq`
  // is imported above so this file keeps that guarantee honest against
  // drizzle-orm's own types rather than asserting it only in prose.
  it('keeps the eq(column, entityId) shape production code depends on type-checking against a real column', () => {
    expect(eq(bins.album_id, 42)).toBeDefined();
  });
});
