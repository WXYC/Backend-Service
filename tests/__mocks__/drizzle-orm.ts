// Mock drizzle-orm for unit tests
export const eq = jest.fn((a, b) => ({ eq: [a, b] }));
// `ne` was missing until a unit test first drove production code that uses it
// (`findLibrarySlotOccupant`'s `exclude_library_id` clause). An absent operator
// here is not an inert gap: the import resolves to `undefined` and the call
// fails as "ne is not a function" from inside the service, so add the operator
// rather than routing a suite around it.
export const ne = jest.fn((a, b) => ({ ne: [a, b] }));
export const and = jest.fn((...conditions: unknown[]) => ({ and: conditions }));
export const or = jest.fn((...conditions: unknown[]) => ({ or: conditions }));

// The real `drizzle-orm/utils.cjs#orderSelectedFields` (unmocked — pg-core's
// own internals resolve relative-path requires within the real package, not
// through this mock) walks a view/query's field map and brand-checks each
// value against `SQL`/`SQL.Aliased` via `Object.getPrototypeOf(value)
// .constructor[entityKind]` (drizzle's `is()`, entity.cjs). A plain object
// shaped like `{ sql, values, as }` fails that check and falls into
// `orderSelectedFields`'s "nested fields object" branch, which recurses into
// a real embedded `Column`'s own circular table/column back-references and
// blows the stack (BS#2476: `library_artist_view.card_id` is this repo's
// first schema.ts view field built from a raw `sql` tag). Tagging these
// return values with drizzle's own global `entityKind` symbol satisfies that
// brand check without importing the real classes.
const entityKind = Symbol.for('drizzle:entityKind');
class MockSQL {
  static [entityKind] = 'SQL';
  constructor(
    public sql: TemplateStringsArray,
    public values: unknown[]
  ) {}
  as(alias: string) {
    return new MockSQLAliased(this, alias);
  }
}
class MockSQLAliased {
  static [entityKind] = 'SQL.Aliased';
  constructor(
    public sql: MockSQL,
    public fieldAlias: string
  ) {}
}
export const sql = Object.assign(
  jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => new MockSQL(strings, values)),
  {
    raw: jest.fn((s: string) => ({ raw: s })),
    join: jest.fn((fragments: unknown[], separator?: unknown) => ({ join: fragments, sep: separator })),
    identifier: jest.fn((name: string) => ({ identifier: name })),
  }
);
export const desc = jest.fn((col) => ({ desc: col }));
export const asc = jest.fn((col) => ({ asc: col }));
export const inArray = jest.fn((col, values) => ({ inArray: [col, values] }));
export const notInArray = jest.fn((col, values) => ({ notInArray: [col, values] }));
export const isNull = jest.fn((col) => ({ isNull: col }));
export const isNotNull = jest.fn((col) => ({ isNotNull: col }));
export const gt = jest.fn((a, b) => ({ gt: [a, b] }));
export const lt = jest.fn((a, b) => ({ lt: [a, b] }));
export const gte = jest.fn((a, b) => ({ gte: [a, b] }));
export const lte = jest.fn((a, b) => ({ lte: [a, b] }));
export const exists = jest.fn((sub) => ({ exists: sub }));
export const notExists = jest.fn((sub) => ({ notExists: sub }));
export const like = jest.fn((col, pattern) => ({ like: [col, pattern] }));
