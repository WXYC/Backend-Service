/**
 * General FK ON DELETE guard (WXYC/Backend-Service#2239).
 *
 * `fk-on-delete-flowsheet-rotation-reviews.spec.js` (BS#1126) hard-codes an
 * ALLOWLIST of five FK constraints that had drifted between the Drizzle
 * schema source and the actual migration history. A DIFFERENT five drifted
 * underneath that allowlist (BS#2239: show_djs.show_id,
 * artist_library_crossreference.artist_id, both genre_artist_crossreference
 * FKs, schedule.specialty_id) -- empirical proof that a hand-listed
 * regression spec does not stop recurrence of this bug class, because
 * nothing forces every new/edited FK onto the list.
 *
 * This spec is general instead of another allowlist: it enumerates EVERY
 * foreign key Drizzle knows about -- via `getTableConfig` (drizzle-orm/
 * pg-core) over every exported table in `@wxyc/database`, covering both
 * `public` (where better-auth's tables live) and the domain schema
 * (`WXYC_SCHEMA_NAME`, `wxyc_schema` in CI) -- and compares each one's
 * declared `onDelete` action against the live database's
 * `pg_constraint.confdeltype`. ANY divergence fails, whether or not anyone
 * thought to add that specific constraint to a list.
 *
 * Why the database and not just `drizzle-kit generate`: the normal
 * authoring loop cannot see this class of drift. The Drizzle snapshot
 * records whatever schema.ts said at generation time, so once schema.ts
 * and the snapshot agree with each other, `drizzle-kit generate` emits
 * nothing -- even though the actual applied migration history (and the
 * deployed database) may have taken a different `ON DELETE` action years
 * earlier and never been corrected. The database is the only witness that
 * still remembers the truth, which is why this spec asks Postgres directly
 * via `pg_constraint` rather than re-deriving expectations from the
 * migration files.
 *
 * BS#2239 resolved its five drifts in the OPPOSITE direction from BS#1126:
 * it de-declared the false `onDelete` from schema.ts rather than adding the
 * cascade/set-null action to the database, because nothing in production
 * deletes those five parent rows (shows, artists, genres, specialty_shows)
 * outside of tests. Adding the cascades would arm five destructive deletes
 * across decades of flowsheet/library history for zero current callers. See
 * the code comments at each de-declared FK in schema.ts (schedule
 * .specialty_id, show_djs.show_id, genre_artist_crossreference.artist_id/
 * genre_id, artist_library_crossreference.artist_id) for the full reasoning
 * -- do not "fix" schema.ts back to declaring those actions without
 * re-reading BS#2239.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Map from pg_constraint.confdeltype's single-char encoding to the SQL
// keyword we expect, for readable assertion failures (mirrors the BS#1126
// spec's CONFDELTYPE_LABEL).
const CONFDELTYPE_LABEL = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/**
 * Collect every foreign key `@wxyc/database`'s schema.ts declares (name,
 * onDelete action, owning schema/table, local column names) by delegating
 * to `collect-declared-foreign-keys.js` in a plain `node` child process --
 * see that file's header comment for why this can't run in-process here (a
 * Jest module-resolution interaction between `drizzle-orm/pg-core` and
 * `@wxyc/database` that this spec sidesteps entirely rather than depends
 * on). Returns a Map keyed by `identityKey()` (schema+table+columns, NOT
 * constraint name -- see identityKey's own comment for why).
 */
function collectDeclaredForeignKeys() {
  const scriptPath = path.join(__dirname, '..', 'utils', 'collect-declared-foreign-keys.js');
  const output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });

  // `@wxyc/database` logs a startup line to stdout as an import side
  // effect, so the child's JSON payload is wrapped in sentinel markers
  // (see collect-declared-foreign-keys.js) rather than assumed to be the
  // entirety of stdout.
  const match = output.match(/===FK_JSON_START===\n([\s\S]*?)\n===FK_JSON_END===/);
  if (!match) {
    throw new Error(`collect-declared-foreign-keys.js produced unparseable output:\n${output}`);
  }
  const rows = JSON.parse(match[1]);

  const declared = new Map();
  for (const row of rows) {
    declared.set(identityKey(row.schema, row.table, row.columns), {
      constraint: row.constraint,
      expectedChar: row.expectedChar,
      action: row.action,
      table: row.table,
      schema: row.schema,
      columns: row.columns,
    });
  }
  return declared;
}

/**
 * The join key for matching a schema.ts-declared FK to its live
 * `pg_constraint` row: (schema, table, local column names) rather than the
 * constraint name string. Two real naming quirks make name matching
 * unreliable (neither is an actual onDelete drift -- see
 * collect-declared-foreign-keys.js for the full explanation): Postgres
 * silently truncates identifiers over 63 bytes (hits the long auth_oauth_*
 * constraint names), and migration 0067 hand-wrote an inline `REFERENCES`
 * column constraint that Postgres named via its own default convention
 * instead of Drizzle's. A (schema, table, columns) tuple is what Postgres
 * actually enforces uniqueness by, so it's a stable join key regardless of
 * how the constraint itself got named.
 */
function identityKey(schema, table, columns) {
  return `${schema}.${table}(${[...columns].sort().join(',')})`;
}

describe('FK ON DELETE guard: every constraint matches its schema.ts declaration (#2239)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  test('pg_constraint.confdeltype matches schema.ts for every FK in public + wxyc_schema', async () => {
    const declared = collectDeclaredForeignKeys();

    // Sanity floor so a broken getTableConfig call (e.g. an export shape
    // change upstream in drizzle-orm) fails loudly as "found nothing"
    // rather than silently passing an empty comparison.
    expect(declared.size).toBeGreaterThan(0);

    // Resolve each FK's local column names too (not just its name), via
    // conkey -> pg_attribute, so rows can be matched to schema.ts's
    // declarations by (schema, table, columns) -- see identityKey().
    const rows = await sql`
      SELECT c.conname,
             c.confdeltype,
             n.nspname AS schema,
             t.relname AS table,
             array_agg(a.attname ORDER BY k.ord) AS columns
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND n.nspname IN ('public', ${SCHEMA})
       GROUP BY c.conname, c.confdeltype, n.nspname, t.relname
    `;
    const observed = new Map(
      rows.map((r) => [
        identityKey(r.schema, r.table, r.columns),
        { conname: r.conname, confdeltype: r.confdeltype, schema: r.schema, table: r.table },
      ])
    );

    const mismatches = [];
    for (const [key, expected] of declared) {
      const actual = observed.get(key);
      if (!actual) {
        mismatches.push({
          table: `${expected.schema}.${expected.table}(${expected.columns.join(',')})`,
          'schema.ts declares': `${expected.constraint}: ${expected.expectedChar} (${CONFDELTYPE_LABEL[expected.expectedChar]})`,
          database: '(no FK found on these columns in public or ' + SCHEMA + ')',
        });
        continue;
      }
      if (actual.confdeltype !== expected.expectedChar) {
        mismatches.push({
          table: `${expected.schema}.${expected.table}(${expected.columns.join(',')})`,
          'schema.ts declares': `${expected.constraint}: ${expected.expectedChar} (${CONFDELTYPE_LABEL[expected.expectedChar]})`,
          database: `${actual.conname}: ${actual.confdeltype} (${CONFDELTYPE_LABEL[actual.confdeltype] ?? 'unknown'})`,
        });
      }
    }

    // One assertion covering every constraint: a run with multiple
    // divergences reports all of them, not just the first.
    expect(mismatches).toEqual([]);

    // The converse direction: a foreign key the database has but schema.ts
    // never declared (e.g. a hand-written migration that adds a raw FK
    // Drizzle doesn't model) is its own kind of drift and should also fail
    // this guard rather than pass silently.
    const undeclared = rows
      .map((r) => ({ key: identityKey(r.schema, r.table, r.columns), conname: r.conname }))
      .filter((r) => !declared.has(r.key));
    expect(undeclared).toEqual([]);
  });
});
