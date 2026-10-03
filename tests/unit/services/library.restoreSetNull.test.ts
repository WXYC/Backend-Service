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
  nullDanglingSetNullReferences,
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
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // The first row is the preservation direction: a reference whose target is
  // still live must come back with its captured value, not merely "not fail".
  it.each([
    ['keeps a value whose target is live', { id: 8, card_id: 5 }, [5], { id: 8, card_id: 5 }, false],
    ['nulls a value whose target is gone, and says so', { id: 8, card_id: 5 }, [], { id: 8, card_id: null }, true],
    ['leaves a captured NULL alone', { id: 8, card_id: null }, [], { id: 8, card_id: null }, false],
    ['leaves a row that never captured the column alone', { id: 8 }, [], { id: 8 }, false],
  ])('%s', async (_name, record, live, expected, logged) => {
    const records: Record<string, unknown>[] = [{ ...record }];
    const { tx } = probeTx(live);

    await nullDanglingSetNullReferences(tx, 'rotation', schema.rotation, records, cardReference);

    expect(records).toEqual([expected]);
    expect(warn).toHaveBeenCalledTimes(logged ? 1 : 0);
    if (logged) expect(warn.mock.calls[0]).toEqual([expect.any(String), 'rotation', 'card_id', '[5]']);
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
