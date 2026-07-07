/**
 * Schema-source assertions for `library_watermark` + its `touch_library_watermark`
 * AFTER STATEMENT trigger (migration 0104, BS#1467).
 *
 * Companion to the runtime behavior spec (tests/integration/library-watermark.spec.js,
 * which exercises the trigger against real Postgres). This is the pure
 * file-reading guard — it cannot run plpgsql, so it locks the two source-level
 * properties that a green integration run alone wouldn't protect against
 * regression:
 *
 *   1. The WATERMARK FORMULA. The trigger MUST use `GREATEST(now(),
 *      last_modified_at)` and MUST NOT carry 0084's `+ interval '1 second'`
 *      floor. Under the library-etl single-transaction writer, now() is frozen
 *      at transaction start, so the +1s floor would land the watermark N
 *      seconds in the future — the drift-forward half of #1106. A future
 *      copy-paste from 0084 reintroducing the floor would be caught here at
 *      unit speed, not only by the (Docker-gated) integration drift guard.
 *
 *   2. The BS#1029 snapshot-parity trap. schema.ts must declare the singleton
 *      CHECK via `sql.raw(`"id" = true`)` with the raw, unqualified text so it
 *      matches the 0104 snapshot byte-for-byte — otherwise `drizzle:generate`
 *      emits a spurious DROP/ADD of the constraint on the next unrelated PR.
 *
 * Mirrors the shape of schema.cta-unique-null-track-partial.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const snapshotPath = path.join(migrationsDir, 'meta/0104_snapshot.json');

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /library-watermark/i.test(e.tag));
if (!journalEntry) {
  throw new Error('No journal entry matches /library-watermark/. Did the 0104 migration land?');
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

// Strip BOTH full-line and inline `--` comments so the header prose (which
// discusses 0084's `+ interval '1 second'` floor and the GREATEST formula) and
// the inline `-- monotonic; NO +1s floor` note can't false-match the SQL
// assertions below. No DDL string literal in this migration contains `--`.
const ddlOnly = migrationSql
  .split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('schema: library_watermark + touch_library_watermark trigger (BS#1467)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('creates the single-row library_watermark table with the singleton CHECK', () => {
    expect(ddlOnly).toMatch(/CREATE\s+TABLE\s+"wxyc_schema"\."library_watermark"/i);
    expect(ddlOnly).toMatch(/"id"\s+boolean\s+PRIMARY\s+KEY/i);
    expect(ddlOnly).toMatch(/"last_modified_at"\s+timestamp\s+with\s+time\s+zone/i);
    expect(ddlOnly).toMatch(/CONSTRAINT\s+"library_watermark_singleton"\s+CHECK\s*\(\s*"id"\s*=\s*true\s*\)/i);
  });

  it('seeds the singleton row idempotently', () => {
    expect(ddlOnly).toMatch(/INSERT\s+INTO\s+"wxyc_schema"\."library_watermark"[\s\S]*?ON\s+CONFLICT\s+DO\s+NOTHING/i);
  });

  it('the trigger function uses the monotonic GREATEST(now(), last_modified_at) formula', () => {
    expect(ddlOnly).toMatch(/last_modified_at\s*=\s*GREATEST\(\s*now\(\)\s*,\s*last_modified_at\s*\)/i);
  });

  it("does NOT carry 0084's `+ interval '1 second'` floor (the #1106 drift-forward guard, in source)", () => {
    // The single most important assertion in this file: under the library-etl
    // single-transaction writer, the +1s floor lands the watermark N seconds in
    // the future. The header prose legitimately *mentions* the floor to explain
    // why it's dropped — hence the assertion runs against the comment-stripped
    // `ddlOnly` view.
    expect(ddlOnly).not.toMatch(/interval\s+'1\s+second'/i);
  });

  it('the trigger is statement-level and fires on INSERT/UPDATE/DELETE/TRUNCATE', () => {
    expect(ddlOnly).toMatch(/FOR\s+EACH\s+STATEMENT/i);
    expect(ddlOnly).toMatch(/AFTER\s+INSERT\s+OR\s+UPDATE\s+OR\s+DELETE\s+OR\s+TRUNCATE\s+ON\s+wxyc_schema\.library/i);
    // Row-level would impose per-row watermark cost on bulk ETL writes.
    expect(ddlOnly).not.toMatch(/FOR\s+EACH\s+ROW/i);
  });

  it('schema.ts declares the table with the raw, unqualified `"id" = true` CHECK (BS#1029 snapshot-parity trap)', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    const start = schemaSource.indexOf('export const library_watermark');
    expect(start).toBeGreaterThan(-1);
    const wmDecl = schemaSource.slice(start, schemaSource.indexOf('\n);', start) + 3);

    // Raw, unqualified check text — must match the snapshot byte-for-byte so
    // drizzle:generate produces no spurious DROP/ADD.
    expect(wmDecl).toMatch(/check\(\s*'library_watermark_singleton'\s*,\s*sql\.raw\(/);
    expect(wmDecl).toMatch(/sql\.raw\(\s*`"id" = true`\s*\)/);

    // Both source-tagged columns carry the confirming eslint-disable (the rule
    // that flags constraint columns lacking a human-confirmed annotation).
    const disables = wmDecl.match(/eslint-disable-next-line wxyc\/source-tagged-constraint-confirmed/g) || [];
    expect(disables.length).toBe(2);
  });

  it('the 0104 snapshot stores the CHECK with the same raw text schema.ts emits (no drift)', () => {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    const table = snapshot.tables['wxyc_schema.library_watermark'];
    expect(table).toBeDefined();
    expect(table.checkConstraints.library_watermark_singleton.value).toBe('"id" = true');
  });
});
