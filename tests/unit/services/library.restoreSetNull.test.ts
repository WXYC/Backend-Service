/**
 * Guards for the `ON DELETE SET NULL` references the catalog restore replays
 * (`restoreDeletedBatch`, `library.service.ts`).
 *
 * A captured row is re-inserted verbatim. A nullable column whose
 * `ON DELETE SET NULL` target was deleted between the catalog delete and the
 * restore would fail that insert on its FK and roll the whole batch back, and
 * snapshots are permanent, so the release could never come back. The replay
 * therefore declares every such column in `SET_NULL_REFERENCES` and NULLs the
 * ones whose target is gone.
 *
 * The declaration is checked against the schema rather than hand-copied: this
 * test derives every nullable `SET NULL` foreign key on the tables
 * `RESTORE_PLAN` replays from the real Drizzle schema, and fails when the plan
 * does not declare one of them. Adding a `SET NULL` column to a replayed table
 * without declaring it here fails this test.
 */

import { jest } from '@jest/globals';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../../shared/database/src/schema';
import {
  CASCADE_DROP_REFERENCES,
  dropOrphanedCascadeRows,
  nullDanglingSetNullReferences,
  REFUSE_REFERENCES,
  RESTORE_PLAN_REPLAYED_TABLE_NAMES,
  SET_NULL_REFERENCES,
} from '../../../apps/backend/services/library.service';

const schemaTables = Object.values(schema).filter((value): value is PgTable => value instanceof PgTable);

const tableNamed = (name: string): PgTable => {
  const table = schemaTables.find((candidate) => getTableConfig(candidate).name === name);
  if (!table) throw new Error(`no schema table named ${name}`);
  return table;
};

/**
 * The schema module's export name for `table`. The unit tier resolves
 * `@wxyc/database` to `tests/mocks/database.mock.ts`, whose column sentinels
 * are `'<export name>.<db column>'` (`user.id`, although its table is
 * `auth_user`), so this is the qualifier a declared target reads as here.
 */
const exportNameOf = (table: unknown): string => {
  const entry = Object.entries(schema).find(([, value]) => value === table);
  if (!entry) throw new Error('foreign table is not a schema export');
  return entry[0];
};

/** Every nullable `ON DELETE SET NULL` foreign key on a replayed table, from the real schema. */
const derivedSetNullReferences = () =>
  RESTORE_PLAN_REPLAYED_TABLE_NAMES.flatMap((name) =>
    getTableConfig(tableNamed(name))
      .foreignKeys.filter((foreignKey) => foreignKey.onDelete === 'set null')
      .flatMap((foreignKey) => {
        const { columns, foreignColumns, foreignTable } = foreignKey.reference();
        return columns.flatMap((column, index) =>
          column.notNull
            ? []
            : [
                {
                  table: name,
                  column: column.name,
                  targetTable: getTableConfig(foreignTable).name,
                  target: `${exportNameOf(foreignTable)}.${foreignColumns[index].name}`,
                },
              ]
        );
      })
  );

/** `table.column` -> the target the schema says it references. */
const derivedSetNullColumns = (): Record<string, string> =>
  Object.fromEntries(derivedSetNullReferences().map(({ table, column, target }) => [`${table}.${column}`, target]));

/**
 * `table.column` -> the target `SET_NULL_REFERENCES` declares, which is the
 * column the replay's probe reads. Under the unit tier each declared target is
 * the double's `'<export name>.<db column>'` sentinel string (see
 * `exportNameOf`), not a `PgColumn`, hence the cast.
 */
const declaredSetNullColumns = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(SET_NULL_REFERENCES).flatMap(([table, columns]) =>
      Object.entries(columns).map(([column, target]) => [`${table}.${column}`, target as unknown as string])
    )
  );

describe('SET_NULL_REFERENCES (catalog restore replay)', () => {
  // Compares the TARGET too, not only the referencing column's name: the
  // target is what the replay probes, so a copy-pasted `library.id` where the
  // schema says `auth_user.id` would silently null valid references.
  it('declares every nullable ON DELETE SET NULL reference on a table the restore replays, with its real target', () => {
    expect(declaredSetNullColumns()).toEqual(derivedSetNullColumns());
  });

  it('declares the two existing dangling-reference columns', () => {
    expect(declaredSetNullColumns()).toEqual(
      expect.objectContaining({
        'rotation.card_id': 'rotation_cards.id',
        'compilation_track_artist.track_artist_id': 'artists.id',
      })
    );
  });

  // The replay probes a target before inserting the referencing table's rows.
  // A target table replayed EARLIER is already live in the transaction, and
  // one in the same table is answered from the rows being inserted; one
  // replayed LATER reads as gone and is nulled. Before SET_NULL_REFERENCES
  // that mis-order was a loud 23503; this keeps it from becoming silent.
  it('replays every SET NULL target that the restore also replays at or before its referencing table', () => {
    const position = (name: string) => RESTORE_PLAN_REPLAYED_TABLE_NAMES.indexOf(name);
    const misordered = derivedSetNullReferences()
      .filter(({ table, targetTable }) => position(targetTable) > position(table))
      .map(({ table, column, targetTable }) => `${table}.${column} -> ${targetTable}`);

    expect(misordered).toEqual([]);
  });
});

type ReferenceAction = 'set null' | 'cascade drop' | 'refuse';

/**
 * Every foreign key from a replayed table to a table the restore does NOT
 * replay, from the real schema, keyed `table.column`. What the replay must do
 * when the target is gone follows from the delete rule: SET NULL nulls,
 * CASCADE drops the row, and everything else (NO ACTION, nullable or not) is
 * refused. A target the restore replays itself is outside this: it is live or
 * restored by the same batch, never missing.
 */
const derivedExternalReferences = (): Record<string, { action: ReferenceAction; target: string }> =>
  Object.fromEntries(
    RESTORE_PLAN_REPLAYED_TABLE_NAMES.flatMap((name) =>
      getTableConfig(tableNamed(name)).foreignKeys.flatMap((foreignKey) => {
        const { columns, foreignColumns, foreignTable } = foreignKey.reference();
        if (RESTORE_PLAN_REPLAYED_TABLE_NAMES.includes(getTableConfig(foreignTable).name)) return [];
        const action: ReferenceAction =
          foreignKey.onDelete === 'set null'
            ? 'set null'
            : foreignKey.onDelete === 'cascade'
              ? 'cascade drop'
              : 'refuse';
        return columns.map((column, index) => [
          `${name}.${column.name}`,
          { action, target: `${exportNameOf(foreignTable)}.${foreignColumns[index].name}` },
        ]);
      })
    )
  );

const declaredExternalReferences = (): Record<string, { action: ReferenceAction; target: string }> =>
  Object.fromEntries(
    (
      [
        ['set null', SET_NULL_REFERENCES],
        ['cascade drop', CASCADE_DROP_REFERENCES],
        ['refuse', REFUSE_REFERENCES],
      ] as const
    ).flatMap(([action, references]) =>
      Object.entries(references).flatMap(([table, columns]) =>
        Object.entries(columns).map(([column, target]) => [
          `${table}.${column}`,
          { action, target: target as unknown as string },
        ])
      )
    )
  );

describe('every foreign key from a replayed table to a non-replayed table (catalog restore replay)', () => {
  // The failing case this guards: a new FK on a replayed table that no map
  // classifies makes a captured row whose target is gone a permanent 500 (23503
  // at INSERT), because the snapshot never changes. Comparing the whole map
  // fails on a missing declaration, a stale one, a wrong target, and a
  // declaration filed under the wrong action for its delete rule.
  it('is classified exactly once, under the action its delete rule implies, with its real target', () => {
    expect(declaredExternalReferences()).toEqual(derivedExternalReferences());
  });

  it('never declares one column under two actions', () => {
    const declared = [SET_NULL_REFERENCES, CASCADE_DROP_REFERENCES, REFUSE_REFERENCES].flatMap((references) =>
      Object.entries(references).flatMap(([table, columns]) =>
        Object.keys(columns).map((column) => `${table}.${column}`)
      )
    );

    expect(declared.filter((key, index) => declared.indexOf(key) !== index)).toEqual([]);
  });

  // The refusal names the first missing reference "in column order", and that
  // order is the one the schema declares them in.
  it("lists each refused table's columns in schema order", () => {
    for (const [table, columns] of Object.entries(REFUSE_REFERENCES)) {
      const schemaOrder = getTableConfig(tableNamed(table)).columns.map((column) => column.name);
      const declaredOrder = Object.keys(columns);
      expect(declaredOrder).toEqual(schemaOrder.filter((name) => declaredOrder.includes(name)));
    }
  });

  // A dropped row's own dependents would have to be dropped with it. None of
  // today's cascade-drop tables has any, and this keeps it that way until the
  // replay learns transitive drops.
  it('declares a cascade-drop only on a table no other replayed table references', () => {
    const referenced = RESTORE_PLAN_REPLAYED_TABLE_NAMES.flatMap((name) =>
      getTableConfig(tableNamed(name)).foreignKeys.map(
        (foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name
      )
    );

    expect(Object.keys(CASCADE_DROP_REFERENCES).filter((table) => referenced.includes(table))).toEqual([]);
  });
});

/**
 * A transaction double for the one existence probe `nullDanglingSetNullReferences`
 * issues per declared column. It answers every probe with `live` (the target
 * values that still exist) and records each probe's table and lock mode, so a
 * test can see whether a probe ran at all and how it locked.
 */
const probeTx = (live: unknown[]) => {
  const probes: Array<{ table?: unknown; mode?: string }> = [];
  const tx = {
    select: () => {
      const probe: { table?: unknown; mode?: string } = {};
      probes.push(probe);
      const chain = {
        from: (table: unknown) => {
          probe.table = table;
          return chain;
        },
        where: () => chain,
        for: (mode: string) => {
          probe.mode = mode;
          return chain;
        },
        then: (resolve: (rows: unknown) => void) => resolve(live.map((value) => ({ value }))),
      };
      return chain;
    },
  };
  return { tx: tx as unknown as Parameters<typeof nullDanglingSetNullReferences>[0], probes };
};

describe('nullDanglingSetNullReferences', () => {
  // Real Drizzle columns, not the unit tier's sentinels: the self-reference
  // case below depends on `target.table` being the table being replayed.
  const cardReference = { card_id: schema.rotation_cards.id };

  // The first row is the preservation direction: a reference whose target is
  // still live must come back with its captured value, not merely "not fail".
  it.each([
    ['keeps a value whose target is live', { id: 8, card_id: 5 }, [5], { id: 8, card_id: 5 }, false],
    ['nulls a value whose target is gone, and reports it', { id: 8, card_id: 5 }, [], { id: 8, card_id: null }, true],
    ['leaves a captured NULL alone', { id: 8, card_id: null }, [], { id: 8, card_id: null }, false],
    ['leaves a row that never captured the column alone', { id: 8 }, [], { id: 8 }, false],
  ])('%s', async (_name, record, live, expected, reported) => {
    const records: Record<string, unknown>[] = [{ ...record }];
    const { tx } = probeTx(live);

    const deviations = await nullDanglingSetNullReferences(tx, 'rotation', schema.rotation, records, cardReference);

    expect(records).toEqual([expected]);
    expect(deviations).toEqual(
      reported ? [{ kind: 'nulled', table: 'rotation', row_id: 8, column: 'card_id', captured_value: '5' }] : []
    );
  });

  it('probes the target under FOR KEY SHARE, so a concurrent delete of it cannot land before the insert', async () => {
    const { tx, probes } = probeTx([5]);

    await nullDanglingSetNullReferences(tx, 'rotation', schema.rotation, [{ id: 8, card_id: 5 }], cardReference);

    expect(probes).toEqual([{ table: schema.rotation_cards, mode: 'key share' }]);
  });

  it('issues no probe when no record carries a value for the column', async () => {
    const { tx, probes } = probeTx([]);

    await nullDanglingSetNullReferences(tx, 'rotation', schema.rotation, [{ id: 8, card_id: null }], cardReference);

    expect(probes).toHaveLength(0);
  });

  // The self-referential shape slice 16a declares (`rotation.moved_from_rotation_id`
  // -> `rotation.id`): the target is restored by the SAME insert, so it is not
  // live when the probe runs, but Postgres checks a non-deferrable FK at the end
  // of the statement and would accept it. Nulling it would sever a reference the
  // snapshot held and the database would have kept.
  it('keeps a reference to a row restored by the same replay, which the live probe cannot see yet', async () => {
    const records: Record<string, unknown>[] = [
      { id: 1, moved_from_rotation_id: null },
      { id: 2, moved_from_rotation_id: 1 },
      { id: 3, moved_from_rotation_id: 99 },
    ];
    const { tx } = probeTx([]);

    await nullDanglingSetNullReferences(tx, 'rotation', schema.rotation, records, {
      moved_from_rotation_id: schema.rotation.id,
    });

    expect(records).toEqual([
      { id: 1, moved_from_rotation_id: null },
      { id: 2, moved_from_rotation_id: 1 },
      { id: 3, moved_from_rotation_id: null },
    ]);
  });
});

describe('dropOrphanedCascadeRows', () => {
  const djReference = { dj_id: schema.user.id };

  // Preservation first: a bin row whose DJ account is still there must come
  // back, and the report must be empty.
  it.each([
    ['keeps a row whose parent is live', [{ id: 1, dj_id: 'dj-a' }], ['dj-a'], [1], []],
    [
      'drops a row whose parent is gone, and reports it as dropped with the missing id',
      [{ id: 1, dj_id: 'dj-a' }],
      [],
      [],
      [{ kind: 'dropped', table: 'bins', row_id: 1, column: 'dj_id', captured_value: 'dj-a' }],
    ],
    [
      'drops only the rows whose parent is gone',
      [
        { id: 1, dj_id: 'dj-a' },
        { id: 2, dj_id: 'dj-b' },
      ],
      ['dj-b'],
      [2],
      [{ kind: 'dropped', table: 'bins', row_id: 1, column: 'dj_id', captured_value: 'dj-a' }],
    ],
  ])('%s', async (_name, records, live, keptIds, expected) => {
    const { tx } = probeTx(live);

    const { kept, deviations } = await dropOrphanedCascadeRows(tx, 'bins', schema.bins, records, djReference);

    expect(kept.map((record) => record.id)).toEqual(keptIds);
    expect(deviations).toEqual(expected);
  });

  it('probes the parent under FOR KEY SHARE', async () => {
    const { tx, probes } = probeTx(['dj-a']);

    await dropOrphanedCascadeRows(tx, 'bins', schema.bins, [{ id: 1, dj_id: 'dj-a' }], djReference);

    expect(probes).toEqual([{ table: schema.user, mode: 'key share' }]);
  });
});
