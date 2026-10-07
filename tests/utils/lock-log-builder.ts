import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * A stand-in for a drizzle query builder, for the unit tests that pin which rows a transaction locks, in what order and
 * how strongly. `createLockLog()` returns:
 *
 * - `builder(rows, label?, updated?)`: a chainable object that resolves to `rows` when awaited. Pass it as what a `tx.select`
 *   (or `tx.update`, ...) mock returns. A `label` is pushed onto `log` when the builder is made, to pin the order of
 *   statements against the locks.
 * - `log`: one line per `.for(strength)` call, spelled `<table> for <strength>`, where `<table>` is the table passed
 *   to `from()`. A second `for` argument (such as `{ of }`) appends ` with options`. The first parameter the last
 *   `where()` bound appends ` id <param>`, so a test can pin WHICH row was locked.
 * - `sets`: the argument of every `.set()` call, in order. `setsByTable` holds the latest one per table, for a builder
 *   made with `updated` (the name of the table a `tx.update(table)` call got).
 * - `wheres`: the argument of every `.where()` call, in order, as drizzle `SQL`, for a test that renders one with `PgDialect`
 *   to pin a predicate (reset with `wheres.length = 0`).
 * - `callsOf(built)`: for one builder `builder()` returned, the arguments of the latest call to each chained method, by
 *   method name (`from`, `set`, `where`, `orderBy`, `returning`, ...), so a test can render ONE statement's `where()`,
 *   read its `set()`, or assert that `returning` was called, when the statements share no ordering to pin them by.
 *
 * It needs the real schema (`jest.requireActual` of `schema`), since it reads table names with `getTableName` and
 * renders `where()` with `PgDialect`. Reset between cases with `log.length = 0; sets.length = 0`, and clear `setsByTable`'s keys if a
 * case reads it.
 */
export const createLockLog = () => {
  const log: string[] = [];
  const sets: Record<string, unknown>[] = [];
  const setsByTable: Record<string, Record<string, unknown>> = {};
  const wheres: SQL[] = [];
  const callLogs = new WeakMap<object, Record<string, unknown[]>>();
  const dialect = new PgDialect();
  const builder = (rows: unknown[], label?: string, updated?: string): unknown => {
    if (label !== undefined) log.push(label);
    let table = '';
    let bound: unknown[] = [];
    const calls: Record<string, unknown[]> = {};
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(rows);
        return (...args: unknown[]) => {
          calls[prop] = args;
          if (prop === 'from') table = getTableName(args[0] as Parameters<typeof getTableName>[0]);
          if (prop === 'where') {
            wheres.push(args[0] as SQL);
            bound = dialect.sqlToQuery(args[0] as SQL).params;
          }
          if (prop === 'set') {
            sets.push(args[0] as Record<string, unknown>);
            if (updated !== undefined) setsByTable[updated] = args[0] as Record<string, unknown>;
          }
          if (prop === 'for') {
            const id = bound.length > 0 ? ` id ${JSON.stringify(bound[0])}` : '';
            log.push(`${table} for ${args[0] as string}${args.length > 1 ? ' with options' : ''}${id}`);
          }
          return proxy;
        };
      },
    });
    callLogs.set(proxy as object, calls);
    return proxy;
  };
  const callsOf = (built: unknown): Record<string, unknown[]> => callLogs.get(built as object) ?? {};
  return { builder, callsOf, log, sets, setsByTable, wheres };
};
