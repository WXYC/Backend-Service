/**
 * Pins the `UPDATE OF` column list of the `touch_library_watermark` trigger on
 * `wxyc_schema.library` against the columns the catalog export reads.
 *
 * Migration 0142's OBLIGATION block: any column added to `CatalogExportRow` (or a
 * join key the export queries start using) MUST be added to the trigger's
 * `UPDATE OF` list in the same PR, or a write that touches only that column never
 * advances `library_watermark` and GET /library/catalog serves a stale body / 304.
 * This test reads the LATEST migration in journal order that (re)creates the
 * trigger, so a later migration that drops a column from the list fails here.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8')) as {
  entries: { tag: string }[];
};

/** Library columns the export queries project or join on (0142's 14, plus code_volume_letters from BS#2826). */
const EXPORTED_LIBRARY_COLUMNS = [
  'id',
  'legacy_release_id',
  'artist_id',
  'genre_id',
  'format_id',
  'alternate_artist_name',
  'album_artist',
  'album_title',
  'label',
  'code_number',
  'code_volume_letters',
  'on_streaming',
  'artwork_url',
  'artist_name',
  'canonical_entity_id',
];

const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');

const TRIGGER_RE =
  /CREATE\s+TRIGGER\s+touch_library_watermark\s+AFTER\s+INSERT\s+OR\s+UPDATE\s+OF\s+([\s\S]*?)\s+OR\s+DELETE\s+OR\s+TRUNCATE\s+ON\s+wxyc_schema\.library\b/i;

function latestLibraryTriggerColumns(): { tag: string; columns: string[] } {
  for (const entry of [...journal.entries].reverse()) {
    const sql = stripComments(fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf-8'));
    const match = sql.match(TRIGGER_RE);
    if (match) {
      return {
        tag: entry.tag,
        columns: match[1]
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      };
    }
  }
  throw new Error('No migration creates the touch_library_watermark trigger on wxyc_schema.library');
}

describe('touch_library_watermark UPDATE OF list covers the catalog export read set', () => {
  const { tag, columns } = latestLibraryTriggerColumns();

  it.each(EXPORTED_LIBRARY_COLUMNS)('includes %s (latest definition: %s)', (column) => {
    expect(columns).toContain(column);
  });

  it('lists no duplicates', () => {
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('does not list internal-only columns the export never reads', () => {
    expect(columns).not.toContain('unresolved_attempted_at');
    expect(tag).toBeTruthy();
  });
});
