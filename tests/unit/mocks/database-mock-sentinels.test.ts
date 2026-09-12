/**
 * Pins the table-qualified sentinel convention of `tests/mocks/database.mock.ts`
 * (BS#2448).
 *
 * The convention is not cosmetic. Before it, every double mapped a column to
 * the bare column NAME, so `library.label_id` and `flowsheet.label_id` were the
 * same string and two EMPTY doubles (`labels`, `format`) were the same value as
 * far as jest's structural equality is concerned. That made two whole classes
 * of assertion silently unable to fail:
 *
 *   - `expect(chain.from).toHaveBeenCalledWith(labels)` was satisfied by a call
 *     that passed `format` (or `schedule`, or `cronjob_runs`).
 *   - Any assertion phrased over a projection's *values* — the referent rule
 *     guarding that `GET /library/rotation/:id` publishes rotation's own
 *     columns and never the joined library release's — could not distinguish
 *     `rotation.label_id` from `library.label_id`, and was catching wrong-table
 *     substitutions only where the column happened to be ABSENT from the other
 *     double. Filling the double in would have disarmed it.
 *
 * These tests are what stops a new or edited double from reintroducing either.
 * They deliberately talk about the double alone — conformance against the real
 * `schema.ts` column set is a separate concern.
 */
import * as mock from '../../mocks/database.mock';

/**
 * Every exported plain-object double, by export name. Filters to objects whose
 * values are all strings (or which are empty), which is exactly the table
 * doubles — `db`, the `jest.fn()` stubs, and the re-exported pure helpers are
 * all functions or carry non-string values.
 */
const tableDoubles = (): Array<[string, Record<string, string>]> =>
  Object.entries(mock as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, string>] =>
      typeof entry[1] === 'object' &&
      entry[1] !== null &&
      Object.getPrototypeOf(entry[1]) === Object.prototype &&
      Object.values(entry[1] as Record<string, unknown>).every((v) => typeof v === 'string')
  );

/** Doubles still declared bare `{}`. Recorded drift — this list may only SHRINK. */
const EMPTY_DOUBLES = [
  'anonymous_devices',
  'user_activity',
  'specialty_shows',
  'schedule',
  'artist_crossreference',
  'cronjob_runs',
];

describe('database.mock table doubles: table-qualified sentinels', () => {
  it('finds the doubles at all (guards the filter above against a silent zero)', () => {
    // A filter that matched nothing would make every test below vacuous — the
    // exact failure mode this whole file exists to prevent.
    expect(tableDoubles().length).toBeGreaterThan(40);
  });

  it('every sentinel is `<thisTable>.<column>`, qualified by its own double', () => {
    // Qualified by THIS double's own export name. A copy-paste that leaves a
    // neighbouring table's qualifier behind is the realistic mistake, and it
    // would reintroduce exactly the cross-table collision the convention
    // removes.
    const violations: string[] = [];
    for (const [table, double] of tableDoubles()) {
      for (const [column, sentinel] of Object.entries(double)) {
        // The suffix is the DB column name and need NOT equal the key — the
        // `user` double maps camelCase keys to snake_case DB names. Only the
        // qualifier is pinned.
        if (!sentinel.startsWith(`${table}.`) || sentinel.length <= table.length + 1) {
          violations.push(`${table}.${column} = '${sentinel}' (expected '${table}.<column>')`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no sentinel value is shared by two different doubles', () => {
    // The property the referent rule depends on. Before qualification, 49
    // distinct column-name values were shared by more than one double.
    const owners = new Map<string, string[]>();
    for (const [table, double] of tableDoubles()) {
      for (const sentinel of Object.values(double)) {
        owners.set(sentinel, [...(owners.get(sentinel) ?? []), table]);
      }
    }
    const shared = [...owners.entries()]
      .filter(([, tables]) => tables.length > 1)
      .map(([sentinel, tables]) => `${sentinel} on ${tables.join(', ')}`);
    expect(shared).toEqual([]);
  });

  it('no two NON-empty doubles are structurally equal (the `labels` === `format` hazard)', () => {
    // `toHaveBeenCalledWith(x)` compares structurally, so two doubles of the
    // same shape are interchangeable in every such assertion. Qualified
    // sentinels make every populated pair distinct; the bare `{}` ones below
    // are still interchangeable, which is why they are tracked as drift.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [table, double] of tableDoubles()) {
      if (Object.keys(double).length === 0) continue;
      const shape = JSON.stringify(double);
      const prior = seen.get(shape);
      if (prior !== undefined) collisions.push(`${prior} === ${table}`);
      else seen.set(shape, table);
    }
    expect(collisions).toEqual([]);
  });

  it('the set of bare `{}` doubles is exactly the recorded backlog', () => {
    // Every member is mutually indistinguishable from every other, so this set
    // is a debt marker, not a design. Adding one is a regression; the fix is to
    // fill the double in from schema.ts, which shrinks this list.
    const empty = tableDoubles()
      .filter(([, double]) => Object.keys(double).length === 0)
      .map(([table]) => table);
    expect(empty.sort()).toEqual([...EMPTY_DOUBLES].sort());
  });

  it('same-named columns on different tables are distinguishable', () => {
    // `album_id` and `artist_name` are the realistic wrong-table substitutions:
    // a projection built from the wrong table's object still type-checks and
    // still renders plausible SQL. These are the pairs a values-based assertion
    // could not separate before qualification.
    expect(mock.flowsheet.album_id).not.toBe(mock.rotation.album_id);
    expect(mock.flowsheet.album_id).not.toBe(mock.album_metadata.album_id);
    expect(mock.library.artist_name).not.toBe(mock.artists.artist_name);
    expect(mock.library.artist_name).not.toBe(mock.flowsheet.artist_name);
    // `labels` and `format` were both `{}` — the acute form of the same bug.
    expect(mock.labels).not.toEqual(mock.format);
  });
});
