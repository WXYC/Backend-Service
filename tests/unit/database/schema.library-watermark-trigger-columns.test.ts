/**
 * Pins the `UPDATE OF` column list of the `touch_library_watermark` trigger on
 * `wxyc_schema.library` to the columns the catalog export actually reads.
 *
 * Migration 0142's OBLIGATION block: any `library` column the export starts reading
 * MUST be added to the trigger's `UPDATE OF` list in the same PR, or a write that
 * touches only that column never advances `library_watermark` and GET /library/catalog
 * serves a stale body / 304.
 *
 * Both sides are DERIVED from source text, so neither can drift silently:
 *   - the expected set is every `${library.<prop>}` token in
 *     `apps/backend/services/catalog-export.service.ts` (the export queries) plus the
 *     `library.<prop>` arguments handed to `logicalAlbumKeySql(...)`, mapped from Drizzle
 *     property names to SQL column names via the `library` table in
 *     `shared/database/src/schema.ts`;
 *   - the actual set is the `UPDATE OF` list of the LATEST migration (journal order)
 *     whose `CREATE TRIGGER touch_library_watermark ... ON wxyc_schema.library` statement
 *     (any identifier quoting or whitespace) defines it. If that latest definition cannot
 *     be parsed the test throws rather than falling back to an older migration.
 *
 * The two sets must be EQUAL: a missing column is a stale-cache bug; an extra one is a
 * trigger firing on columns the export never reads (0142 narrowed it deliberately).
 *
 * BS#2919 generalizes the obligation to every table the export interpolates a column from (the scrape and
 * trigger parse live in `tests/utils/catalog-export-source.ts`): the latest `touch_library_watermark*` trigger
 * on each must be unrestricted, or its `UPDATE OF` list must cover every column the export reads from that
 * table, or the table must be on the explicit trigger-less allowlist below with a reason.
 */

import { exportedColumnsByTable, latestWatermarkTriggers } from '../../utils/catalog-export-source';

const readSet = exportedColumnsByTable();
const triggers = latestWatermarkTriggers();

/** Export sources with deliberately no watermark trigger; the reason must say why a stale body is acceptable. */
const TRIGGERLESS_SOURCES: Record<string, string> = {
  album_plays: 'materialized view; a view cannot carry a row trigger, and popularity is a slow-moving signal (0142)',
  album_popularity:
    'plain table rebuilt by album-popularity-refresh.service.ts, which deliberately does not advance library_watermark (BS#1486 decision 4)',
};

const libraryTrigger = triggers.get('library');
if (!libraryTrigger?.columns) {
  throw new Error('The latest touch_library_watermark trigger on library has no parseable UPDATE OF list');
}
const { tag, columns } = { tag: libraryTrigger.tag, columns: libraryTrigger.columns };
const expected = readSet.get('library') ?? [];

describe('touch_library_watermark UPDATE OF list equals the catalog export read set', () => {
  it('derives a non-trivial export read set that includes code_volume_letters', () => {
    expect(expected.length).toBeGreaterThanOrEqual(15);
    expect(expected).toContain('code_volume_letters');
  });

  it('lists no duplicate columns', () => {
    expect(new Set(columns).size).toBe(columns.length);
  });

  it.each(expected.map((column) => [column]))('includes %s', (column) => {
    expect(columns).toContain(column);
  });

  it('lists no column the export never reads', () => {
    expect(columns.filter((c) => !expected.includes(c))).toEqual([]);
  });

  it(`matches exactly (latest definition: ${tag})`, () => {
    expect([...columns].sort()).toEqual(expected);
  });
});

describe('every table the catalog export reads is covered by the library watermark (BS#2919)', () => {
  it('derives the eleven export sources', () => {
    expect([...readSet.keys()].sort()).toEqual(
      [
        'album_plays',
        'album_popularity',
        'artist_crossreference',
        'artists',
        'compilation_track_artist',
        'digital_asset',
        'format',
        'genre_artist_crossreference',
        'genres',
        'library',
        'rotation',
      ].sort()
    );
  });

  it('keeps the trigger-less allowlist honest: no entry has a trigger, none is unread', () => {
    for (const table of Object.keys(TRIGGERLESS_SOURCES)) {
      expect(triggers.has(table)).toBe(false);
      expect(readSet.has(table)).toBe(true);
    }
  });

  it.each([...readSet.keys()].filter((t) => !(t in TRIGGERLESS_SOURCES)).map((t) => [t]))(
    '%s has a trigger that covers every column the export reads',
    (table) => {
      const trigger = triggers.get(table);
      if (!trigger) throw new Error(`${table} is read by the export but has no touch_library_watermark* trigger`);
      if (trigger.columns === null) return;
      const missing = (readSet.get(table) ?? []).filter((c) => !trigger.columns!.includes(c));
      expect({ table, tag: trigger.tag, missing }).toEqual({ table, tag: trigger.tag, missing: [] });
    }
  );
});
