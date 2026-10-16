/**
 * Pins the error shape a real drizzle instance throws for a failing query (BS#2605).
 *
 * This exists to guard every hand-built `{ cause: { code } }` double in the repo (the unit specs for `sqlstate`,
 * `legacy-linkage-resolve`, `deleteAlbum`, `database-check`, ...). Each of them encodes one assumption about
 * drizzle-orm's wrapper: that a query rejection is a `DrizzleQueryError` whose own `code` is `undefined` and whose
 * `.cause` is the postgres-js `PostgresError`, carrying the SQLSTATE on `.code` and the constraint on
 * `.constraint_name`. Nothing else in the suite observes the wrapper, so they would all stay green together if a
 * drizzle upgrade changed it, while production classified nothing. If this spec fails after a bump, the wrap changed
 * (double nesting under `.cause.cause`, a renamed field, a wrapper `code`): fix `shared/database/src/sqlstate.ts`
 * and the doubles, do not loosen this spec.
 *
 * Verified against drizzle-orm 0.45.3 with postgres-js. Asserts structure, never drizzle's `Failed query: …` prose.
 */

// The unit-tier drizzle-orm double sits under tests/__mocks__ and jest applies it to node modules here too.
jest.unmock('drizzle-orm');

const { drizzle } = require('drizzle-orm/postgres-js');
const { sql: rawSql } = require('drizzle-orm');
const { DrizzleQueryError } = require('drizzle-orm/errors');
const { extractSqlState, extractConstraintName } = require('@wxyc/database');
const { getTestDb } = require('../utils/db');

// A private, uniquely named schema keeps the scratch tables and their foreign key out of `wxyc_schema`, where
// fk-on-delete-general-guard.spec.js would flag the FK as undeclared (in parallel, or after an interrupted run).
const SCHEMA = `wxyc_test_drizzle_err_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
const PARENT = `"${SCHEMA}".bs2605_parent`;
const CHILD = `"${SCHEMA}".bs2605_child`;

describe('drizzle thrown error shape (real PG)', () => {
  let client;
  let db;

  const caught = async (query) => {
    try {
      await db.execute(rawSql.raw(query));
    } catch (error) {
      return error;
    }
    throw new Error('expected the query to reject');
  };

  beforeAll(async () => {
    client = getTestDb();
    db = drizzle(client);
    await client.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await client.unsafe(`CREATE TABLE ${PARENT} (id integer PRIMARY KEY)`);
    await client.unsafe(
      `CREATE TABLE ${CHILD} (id integer PRIMARY KEY, parent_id integer NOT NULL,
         CONSTRAINT bs2605_child_parent_fk FOREIGN KEY (parent_id) REFERENCES ${PARENT} (id))`
    );
  });

  afterAll(async () => {
    await client.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  it('wraps a foreign-key violation: wrapper code undefined, SQLSTATE and constraint on .cause', async () => {
    const error = await caught(`INSERT INTO ${CHILD} (id, parent_id) VALUES (1, 999)`);

    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect(error.code).toBeUndefined();
    expect(error.cause).toBeDefined();
    expect(error.cause.code).toBe('23503');
    expect(error.cause.constraint_name).toBe('bs2605_child_parent_fk');
    expect(error.cause.cause).toBeUndefined();

    expect(extractSqlState(error)).toBe('23503');
    expect(extractConstraintName(error)).toBe('bs2605_child_parent_fk');
  });

  it('wraps a NOT NULL violation the same way', async () => {
    const error = await caught(`INSERT INTO ${CHILD} (id, parent_id) VALUES (2, NULL)`);

    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect(error.code).toBeUndefined();
    expect(error.cause.code).toBe('23502');

    expect(extractSqlState(error)).toBe('23502');
  });
});
