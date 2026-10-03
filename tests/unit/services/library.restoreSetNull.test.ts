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

import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../../shared/database/src/schema';
import { RESTORE_PLAN_REPLAYED_TABLE_NAMES, SET_NULL_REFERENCES } from '../../../apps/backend/services/library.service';

const schemaTables = Object.values(schema).filter((value): value is PgTable => value instanceof PgTable);

const tableNamed = (name: string): PgTable => {
  const table = schemaTables.find((candidate) => getTableConfig(candidate).name === name);
  if (!table) throw new Error(`no schema table named ${name}`);
  return table;
};

/** `table.column` for every nullable `ON DELETE SET NULL` foreign key on a replayed table. */
const derivedSetNullColumns = (): string[] =>
  RESTORE_PLAN_REPLAYED_TABLE_NAMES.flatMap((name) => {
    const config = getTableConfig(tableNamed(name));
    return config.foreignKeys
      .filter((foreignKey) => foreignKey.onDelete === 'set null')
      .flatMap((foreignKey) =>
        foreignKey
          .reference()
          .columns.filter((column) => !column.notNull)
          .map((column) => `${name}.${column.name}`)
      );
  });

const declaredSetNullColumns = (): string[] =>
  Object.entries(SET_NULL_REFERENCES).flatMap(([table, columns]) =>
    Object.keys(columns).map((column) => `${table}.${column}`)
  );

describe('SET_NULL_REFERENCES (catalog restore replay)', () => {
  it('declares every nullable ON DELETE SET NULL reference on a table the restore replays', () => {
    expect(declaredSetNullColumns().sort()).toEqual(derivedSetNullColumns().sort());
  });

  it('declares the two existing dangling-reference columns', () => {
    expect(declaredSetNullColumns()).toEqual(
      expect.arrayContaining(['rotation.card_id', 'compilation_track_artist.track_artist_id'])
    );
  });
});
