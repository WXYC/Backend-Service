/**
 * Tests for the wxyc/restricted-library-rotation-insert ESLint rule (BS#2808).
 *
 * The allow-list names top-level functions inside library.service.ts rather
 * than exempting the file, and resolves the enclosing name outward past inner
 * closures (the gated inserts sit inside `const run = async (tx) => ...`).
 * The allow-list lives in the rule module, so these cases exercise it through
 * RuleTester's `filename`.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose, same as the other *.rule.test.ts files here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wxycLocalRules = require('../../../eslint-rules/restricted-library-rotation-insert.cjs') as {
  rules: { 'restricted-library-rotation-insert': unknown };
};

const rule = wxycLocalRules.rules['restricted-library-rotation-insert'];

// The TypeScript parser, so `as` / `!` / `satisfies` wrappers parse. It handles
// plain JS too. Required (not imported) to avoid ESM/CJS default-interop doubt.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser') as { parseForESLint: unknown };

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tsParser },
});

const LIBRARY_SERVICE = 'apps/backend/services/library.service.ts';
const OTHER_FILE = 'apps/backend/services/some-random.service.ts';

ruleTester.run('restricted-library-rotation-insert', rule, {
  valid: [
    // The gated functions, directly and through an inner closure.
    {
      code: `export async function insertAlbum(x) { return db.insert(library).values(x); }`,
      filename: LIBRARY_SERVICE,
    },
    {
      code: `export const insertAlbum = async (x) => {
        const run = async (t) => { await t.insert(library).values(x).returning(); };
        return run(db);
      };`,
      filename: LIBRARY_SERVICE,
    },
    {
      code: `export const addToRotation = async (x) => {
        const run = async (tx) => { await tx.insert(rotation).values(x).returning(); };
        return db.transaction(run);
      };`,
      filename: LIBRARY_SERVICE,
    },
    {
      code: `async function replayCapturedRows(t) { await t.execute(sql\`INSERT INTO library (a) VALUES (1)\`); }`,
      filename: LIBRARY_SERVICE,
    },
    // The legacy ETL jobs are allowed as whole directories.
    { code: `await db.insert(library).values(rows);`, filename: 'jobs/library-etl/job.ts' },
    { code: `await db.insert(rotation).values(rows);`, filename: 'jobs/rotation-etl/job.ts' },
    // Unrelated tables, and names that only start with a restricted name.
    { code: `await db.insert(reviews).values(x);`, filename: OTHER_FILE },
    { code: `await db.execute(sql\`INSERT INTO library_identity (a) VALUES (1)\`);`, filename: OTHER_FILE },
    {
      code: `await db.execute(sql\`INSERT INTO wxyc_schema.library_identity_source (a) VALUES (1)\`);`,
      filename: OTHER_FILE,
    },
    // An interpolated table cannot be resolved, so it is not flagged.
    { code: `await db.execute(sql\`INSERT INTO \${table} (a) VALUES (1)\`);`, filename: OTHER_FILE },
    // A parameter named `table` is not a restricted table binding, whether it
    // is a plain template target or a schema-qualified one.
    {
      code: `async function replayCapturedRows(t, table) { await t.execute(sql\`INSERT INTO \${table} (a) VALUES (1)\`); }`,
      filename: LIBRARY_SERVICE,
    },
    { code: `await db.execute(sql\`INSERT INTO \${reviews} (a) VALUES (1)\`);`, filename: OTHER_FILE },
    // Interpolations that do not directly follow INSERT INTO are not targets.
    { code: `await db.execute(sql\`INSERT INTO reviews (a) SELECT a FROM \${library}\`);`, filename: OTHER_FILE },
    // Aliases of unrelated tables, and an import that only borrows a restricted name.
    {
      code: `import { reviews as library } from '@wxyc/database'; await db.insert(library).values(x);`,
      filename: OTHER_FILE,
    },
    { code: `const t = reviews; await db.insert(t).values(x);`, filename: OTHER_FILE },
    // Restricted-table forms are fine inside the gated functions.
    {
      code: `import { library as lib } from '@wxyc/database';
        export async function insertAlbum(x) { return db.insert(lib).values(x); }`,
      filename: LIBRARY_SERVICE,
    },
    {
      code: `export const addToRotation = async (x) => {
        const t = rotation;
        const run = async (tx) => { await tx.insert(t as any).values(x); };
        return db.transaction(run);
      };`,
      filename: LIBRARY_SERVICE,
    },
    {
      code: `export async function insertAlbum(x) { await db.execute(sql\`INSERT INTO \${library} (a) VALUES (1)\`); }`,
      filename: LIBRARY_SERVICE,
    },
    {
      code: `export async function insertAlbum(x) { await db.insert(library!).values(x); await db.insert((library as X)).values(x); }`,
      filename: LIBRARY_SERVICE,
    },
    // Selecting from the tables is fine; only inserts are restricted.
    { code: `await db.select().from(library);`, filename: OTHER_FILE },
    // A non-sql tag is not SQL.
    { code: `const s = html\`INSERT INTO library\`;`, filename: OTHER_FILE },
  ],

  invalid: [
    // Drizzle inserts outside the allow-list.
    {
      code: `await db.insert(library).values(x);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'none' } }],
    },
    {
      code: `export async function f(x) { await db.insert(rotation).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export async function f(x) { await db.insert(schema.library).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    // Raw SQL inserts.
    {
      code: `export const f = () => db.execute(sql\`INSERT INTO library (a) VALUES (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `export const f = () => db.execute(sql\`INSERT INTO wxyc_schema.rotation (a) VALUES (\${1})\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export const f = () => db.execute(sql\`insert into "library" (a) values (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    // Raw SQL with the Drizzle table object interpolated as the target.
    {
      code: `export const f = () => db.execute(sql\`INSERT INTO \${library} (a) VALUES (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `export const f = () => db.execute(sql\`insert into \${rotation} (a) values (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export const f = () => db.execute(sql\`INSERT INTO \${schema.rotation} (a) VALUES (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: 'export const f = () => db.execute(sql`INSERT\n  INTO\n  ${library} (a) VALUES (1)`);',
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `export const f = () => db.execute(sql\`INSERT INTO wxyc_schema.\${library} (a) VALUES (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    // Aliases: a renamed import, a local const, and TS wrappers.
    {
      code: `import { library as lib } from '@wxyc/database';
        export async function f(x) { await db.insert(lib).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `import { rotation as rot } from '@wxyc/database';
        export const f = () => db.execute(sql\`INSERT INTO \${rot} (a) VALUES (1)\`);`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { const t = library; await tx.insert(t).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `import { rotation as rot } from '@wxyc/database';
        const t = rot;
        export async function f(tx, x) { await tx.insert(t).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { const t = schema.rotation; await tx.insert(t).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { await tx.insert(library as X).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { await tx.insert(library!).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { await tx.insert(rotation satisfies X).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { await tx.insert((library)).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    {
      code: `export async function f(tx, x) { const t = library as X; await tx.insert(t!).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'f' } }],
    },
    // A new function in library.service.ts is not exempted by the file.
    {
      code: `export async function importAlbums(rows) { await db.insert(library).values(rows); }`,
      filename: LIBRARY_SERVICE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'importAlbums' } }],
    },
    // An inner closure named `run` of any other top-level function fails:
    // the name resolves outward, so `run` is never what gets compared.
    {
      code: `export const copyAlbum = async (x) => {
        const run = async (t) => { await t.insert(library).values(x); };
        return run(db);
      };`,
      filename: LIBRARY_SERVICE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'copyAlbum' } }],
    },
    {
      code: `async function sneaky(x) {
        const run = async (tx) => { await tx.insert(rotation).values(x); };
        return run(db);
      }`,
      filename: LIBRARY_SERVICE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'sneaky' } }],
    },
    // Only the declarator that holds the insert counts, not the first one.
    {
      code: `const insertAlbum = 1, other = async (x) => { await db.insert(library).values(x); };`,
      filename: LIBRARY_SERVICE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'other' } }],
    },
    // A class method has no nameable top-level declaration.
    {
      code: `export class Importer { async go(x) { await db.insert(library).values(x); } }`,
      filename: LIBRARY_SERVICE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'none' } }],
    },
    // The allow-listed names apply only in library.service.ts.
    {
      code: `export async function insertAlbum(x) { await db.insert(library).values(x); }`,
      filename: OTHER_FILE,
      errors: [{ messageId: 'restrictedInsert', data: { table: 'library', enclosing: 'insertAlbum' } }],
    },
    // The routes that used to insert are not allow-listed.
    {
      code: `export const handler = async (req) => { await db.insert(rotation).values(req.body); };`,
      filename: 'apps/backend/routes/internal.route.ts',
      errors: [{ messageId: 'restrictedInsert', data: { table: 'rotation', enclosing: 'handler' } }],
    },
  ],
});
