import * as fs from 'fs';
import * as path from 'path';

describe('migration 0056: album_plays materialized view', () => {
  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0056_album_plays_materialized_view.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  it('migration 0056 SQL file exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('creates a materialized view aggregating flowsheet plays per album_id', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE\s+MATERIALIZED\s+VIEW[^;]*"wxyc_schema"\."album_plays"/i);
    // The view's value is summing track plays per album, so the aggregation
    // must filter out non-track entry types and rows missing album_id.
    expect(sql).toMatch(/FROM\s+"wxyc_schema"\."flowsheet"/i);
    expect(sql).toMatch(/entry_type\s*=\s*'track'/i);
    expect(sql).toMatch(/album_id\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/GROUP\s+BY\s+album_id/i);
  });

  it('selects album_id and a plays count column', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/album_id/i);
    // count(*) cast to int and aliased as plays — REFRESH CONCURRENTLY needs
    // a stable unique key, so the column has to materialize.
    expect(sql).toMatch(/count\(\*\)[^,]*\bplays\b/i);
  });

  it('creates a unique index on album_id (required for REFRESH CONCURRENTLY)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[^;]*"album_plays_album_id_idx"[^;]*"wxyc_schema"\."album_plays"[^;]*\(\s*"?album_id"?\s*\)/i
    );
  });

  it('journal includes the 0056 entry after 0055', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0056_album_plays_materialized_view');
    const prev = journal.entries.find((e) => e.idx === 55);
    if (!entry) throw new Error('0056 journal entry missing');
    if (!prev) throw new Error('0055 journal entry missing');
    expect(entry.idx).toBe(56);
    expect(entry.when).toBeGreaterThan(prev.when);
  });
});
