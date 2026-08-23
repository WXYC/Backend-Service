/**
 * Plain-Node helper (deliberately NOT run through Jest's module system) that
 * walks every table exported by `@wxyc/database` via `getTableConfig`
 * (drizzle-orm/pg-core) and prints each foreign key's constraint name,
 * declared `onDelete` action, and (schema, table, local columns) identity
 * as JSON on stdout.
 *
 * Why a subprocess: requiring `drizzle-orm/pg-core` directly inside a Jest
 * test file that ALSO requires `@wxyc/database` makes Jest's resolver
 * re-resolve the `@wxyc/database` bare specifier to its TypeScript SOURCE
 * (`shared/database/src/index.ts` -> `schema.ts`) instead of the built
 * `dist/index.js` -- confirmed by isolating the two requires in throwaway
 * specs; requiring `@wxyc/database` alone resolves dist correctly, and
 * merely adding a `require('drizzle-orm/pg-core')` anywhere in the same
 * file (in either order) flips the OTHER require to source. Source
 * resolution then pulls in `schema.ts`'s `import ... from 'drizzle-orm'`,
 * which IS Jest-automocked by `tests/__mocks__/drizzle-orm.ts` (present for
 * unit tests), and that mock file's TypeScript syntax fails to parse under
 * the integration config's plain (non-TS) babel-jest transform. Running
 * this collection in a plain `node` child process sidesteps the whole
 * interaction: neither package is ever seen by Jest's resolver/automock.
 *
 * Invoked via `node collect-declared-foreign-keys.js`. Inherits the
 * calling process's env (DB_* vars are required by `@wxyc/database`'s
 * client module at import time, even though this script never queries the
 * database itself).
 */

const { getTableConfig } = require('drizzle-orm/pg-core');
const database = require('@wxyc/database');

const FK_JSON_START = '===FK_JSON_START===';
const FK_JSON_END = '===FK_JSON_END===';

// The reverse of pg_constraint.confdeltype's single-char encoding: the
// `onDelete` action string Drizzle's ForeignKey carries -> the confdeltype
// char Postgres records for it. Drizzle defaults `onDelete` to the literal
// string 'no action' when a reference() call omits it, so every foreign
// key -- including ones with no explicit onDelete in schema.ts -- resolves
// to one of these five keys, never undefined.
const ACTION_TO_CONFDELTYPE = {
  cascade: 'c',
  restrict: 'r',
  'no action': 'a',
  'set null': 'n',
  'set default': 'd',
};

const declared = [];

for (const value of Object.values(database)) {
  if (!value || typeof value !== 'object') continue;

  let config;
  try {
    config = getTableConfig(value);
  } catch {
    // Not a PgTable (getTableConfig throws for anything else) -- skip.
    continue;
  }
  if (!Array.isArray(config.foreignKeys) || config.foreignKeys.length === 0) continue;

  for (const fk of config.foreignKeys) {
    const name = fk.getName();
    const action = fk.onDelete ?? 'no action';
    const expectedChar = ACTION_TO_CONFDELTYPE[action];
    if (!expectedChar) {
      throw new Error(
        `schema.ts declares onDelete: '${action}' on constraint ${name}, which is not a ` +
          `recognized Postgres ON DELETE action. Fix the declaration or extend ACTION_TO_CONFDELTYPE.`
      );
    }
    // Identify the FK by (schema, table, local column names) rather than by
    // constraint name string. Two real-world naming quirks make name-string
    // matching unreliable: (1) Postgres silently truncates identifiers over
    // 63 bytes, so Drizzle's own un-truncated getName() for a long
    // constraint (e.g. the auth_oauth_* tables) never matches what's
    // actually stored; (2) at least one migration (0067,
    // flowsheet_linkage_review) was hand-written with an inline `REFERENCES
    // ... ON DELETE CASCADE` column constraint, which Postgres names via
    // its OWN default convention (`<table>_<column>_fkey`) rather than
    // Drizzle's `<table>_<column>_<reftable>_<refcolumn>_fk` convention.
    // Neither case is an actual onDelete drift (both constraints are
    // CASCADE, matching schema.ts) -- they're just names, and the
    // (table, columns) tuple is what Postgres actually enforces identity by.
    const columns = fk.reference().columns.map((col) => col.name);
    declared.push({
      constraint: name,
      expectedChar,
      action,
      table: config.name,
      schema: config.schema ?? 'public',
      columns,
    });
  }
}

// `@wxyc/database`'s client module logs a startup line to stdout as a
// side effect of import (e.g. "[database] statement_timeout=...ms"), so the
// JSON payload is wrapped in sentinel markers rather than assumed to be the
// only stdout content -- the caller extracts the text between them.
process.stdout.write(`\n${FK_JSON_START}\n${JSON.stringify(declared)}\n${FK_JSON_END}\n`);
