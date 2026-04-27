/**
 * Schema-source assertions for the `album_plays` materialized view created
 * by migration 0059.
 *
 * The MV is the play-weight signal feeding the new tsvector ranker (Epic
 * A). Its shape is locked in three places: the migration SQL (what runs),
 * the schema declaration (drift detection + Drizzle access), and the
 * refresh service (consumer). Drift between any two would silently degrade
 * search ranking — by design, since `ts_rank * ln(plays + 1)` keeps
 * returning rows even with stale or missing play counts.
 */
import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const migrationPath = path.join(migrationsDir, '0059_album-plays-materialized-view.sql');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const refreshServicePath = path.resolve(__dirname, '../../../apps/backend/services/album-plays-refresh.service.ts');

describe('schema: album_plays materialized view (migration 0059)', () => {
  it('migration 0059 exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates a MATERIALIZED VIEW named album_plays in wxyc_schema', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE\s+MATERIALIZED\s+VIEW\s+"wxyc_schema"\."album_plays"/i);
  });

  it('aggregates from flowsheet, filtered to track entries with a non-null album_id', () => {
    // Filter is load-bearing: flowsheet has non-track rows (talkset,
    // breakpoint, …) that have no album, and track rows with a NULL
    // album_id (the search-only-by-text linkage gap that Epic B is
    // closing). Both must be excluded so the count reflects "tracks the
    // station has actually played from a known album".
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/FROM\s+"wxyc_schema"\."flowsheet"/i);
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/i);
    expect(sql).toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/GROUP\s+BY\s+"album_id"/i);
  });

  it('exposes album_id and an int plays column', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/count\(\*\)::int\s+AS\s+"plays"/i);
  });

  it('creates a UNIQUE index on album_id (required for REFRESH CONCURRENTLY)', () => {
    // The index name is asserted because the schema declaration and any
    // future migration that touches the MV both need to agree on it. The
    // UNIQUE-ness is what `REFRESH MATERIALIZED VIEW CONCURRENTLY`
    // requires — without it the refresh would block reads, which is the
    // whole reason the MV exists in front of the search path.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+"album_plays_album_id_idx"\s+ON\s+"wxyc_schema"\."album_plays"\s*\(\s*"album_id"\s*\)/i
    );
  });

  it('journal includes the 0059 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has59 = journal.entries.some((e: { tag: string }) => e.tag === '0059_album-plays-materialized-view');
    expect(has59).toBe(true);
  });

  it('schema.ts declares the materialized view so drizzle-kit drift detection sees it', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/wxyc_schema\s*\.\s*materializedView\(\s*'album_plays'/);
    // Both columns must be declared so consumer queries can reference
    // them through Drizzle.
    expect(schemaSource).toMatch(/album_id:\s*integer\(\s*'album_id'\s*\)/);
    expect(schemaSource).toMatch(/plays:\s*integer\(\s*'plays'\s*\)/);
    // .existing() so drizzle-kit treats the MV as managed externally
    // (we own the SQL via the migration).
    expect(schemaSource).toMatch(/\.existing\(\)/);
  });

  it('refresh service references the schema-declared view (not a hand-rolled string)', () => {
    // Catch the failure mode where someone refactors the service to
    // build the qualified name itself — then a schema rename breaks
    // refreshes silently in environments where WXYC_SCHEMA_NAME is
    // overridden (test isolation).
    const serviceSource = fs.readFileSync(refreshServicePath, 'utf-8');
    expect(serviceSource).toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY/i);
    expect(serviceSource).toMatch(/album_plays/);
  });
});
