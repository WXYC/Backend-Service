/**
 * Unit tests for the M2.4 mojibake-cache audit (issue #528).
 *
 * The audit walks BS PG's persisted metadata + artwork cache fields on
 * `library` and `flowsheet`, finds rows whose name keys match a list of
 * post-V012 corrected names, and either reports counts (default) or NULLs
 * the cached fields so the next request triggers a fresh LML lookup
 * keyed by the corrected name.
 *
 * Tests pin the SQL shape because:
 *  - missing a name column from the WHERE matrix would silently leak
 *    stale cache rows past the invalidation;
 *  - an UPDATE that forgot to NULL `canonical_entity_resolved_at` would
 *    keep the row out of the B-1 retry path even after the URL was
 *    cleared;
 *  - the schema-qualified table name has to match `wxyc_schema.*` —
 *    Drizzle's default schema is fine for ORM calls but raw SQL has
 *    to spell it out.
 */

import { db } from '@wxyc/database';
import {
  parseFixesCsv,
  hasMojibakeFingerprint,
  countStaleCacheRows,
  invalidateStaleCacheRows,
  LIBRARY_NAME_COLUMNS,
  LIBRARY_CACHE_COLUMNS,
  FLOWSHEET_NAME_COLUMNS,
  FLOWSHEET_CACHE_COLUMNS,
} from '../../../scripts/cache-scan/mojibake_cache_audit';

type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  raw?: string;
  queryChunks?: Array<string | { value?: string | string[] }>;
};

/**
 * Render a drizzle SQL fragment to text by interleaving the static `.sql`
 * parts with each interpolated `.values` entry. `sql.raw` chunks expose
 * their literal as `.raw`; nested template-literal fragments expose `.sql`
 * + `.values`. We recurse so the test regexes can match the raw SQL the
 * script emits.
 */
const renderSql = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const parts = obj.sql;
    const values = obj.values ?? [];
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      out += parts[i];
      if (i < values.length) {
        out += renderSql(values[i]);
      }
    }
    return out;
  }
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '?';
      })
      .join('');
  }
  if (Array.isArray(value)) return `(${(value as unknown[]).map(renderSql).join(',')})`;
  return '?';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

const allExecuteCallsMatching = (pattern: RegExp): unknown[][] => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.filter((call) => pattern.test(renderSql(call[0])));
};

describe('parseFixesCsv', () => {
  it('extracts the proposed (corrected) name from a tubafrenzy-style fix CSV', () => {
    // V012's CSV has columns: table, column, current, proposed, row_count, confidence, script.
    // For BS cache invalidation we only need the corrected ("proposed") names,
    // since post-M2.1 the BS rows already carry those values.
    const csv = [
      'table,column,current,proposed,row_count,confidence,script',
      'FLOWSHEET_ENTRY_PROD,ARTIST_NAME,Î¼-Ziq,µ-Ziq,13,95,GREEK',
      'LIBRARY_RELEASE,ALBUM_ARTIST,Î£tella,Σtella,1,95,GREEK',
    ].join('\n');

    const fixes = parseFixesCsv(csv);

    expect(fixes).toHaveLength(2);
    expect(fixes).toContainEqual({ current: 'Î¼-Ziq', proposed: 'µ-Ziq' });
    expect(fixes).toContainEqual({ current: 'Î£tella', proposed: 'Σtella' });
  });

  it('deduplicates pairs that appear in multiple source tables', () => {
    // The same artist name shows up in FLOWSHEET_ENTRY and LIBRARY_RELEASE; we
    // only need each (current, proposed) pair once when building the WHERE list.
    const csv = [
      'table,column,current,proposed,row_count,confidence,script',
      'FLOWSHEET_ENTRY_PROD,ARTIST_NAME,Î¼-Ziq,µ-Ziq,13,95,GREEK',
      'LIBRARY_RELEASE,ALBUM_ARTIST,Î¼-Ziq,µ-Ziq,2,95,GREEK',
    ].join('\n');

    const fixes = parseFixesCsv(csv);

    expect(fixes).toEqual([{ current: 'Î¼-Ziq', proposed: 'µ-Ziq' }]);
  });

  it('skips blank lines, the header, and rows missing current or proposed', () => {
    const csv = [
      'table,column,current,proposed,row_count',
      '',
      'FLOWSHEET_ENTRY_PROD,ARTIST_NAME,Î¼-Ziq,µ-Ziq,13',
      'FLOWSHEET_ENTRY_PROD,ARTIST_NAME,,onlyproposed,1',
      'FLOWSHEET_ENTRY_PROD,ARTIST_NAME,onlycurrent,,1',
      '',
    ].join('\n');

    expect(parseFixesCsv(csv)).toEqual([{ current: 'Î¼-Ziq', proposed: 'µ-Ziq' }]);
  });

  it('handles CSV values that contain commas via double-quoting', () => {
    // RFC 4180-ish: quoted values may contain commas. The fix CSVs don't lean
    // on this today, but the parser shouldn't choke if a future fix-pair has
    // one (e.g., a track title with a comma).
    const csv = [
      'table,column,current,proposed,row_count',
      'FLOWSHEET_ENTRY_PROD,SONG_TITLE,"Hello, World ÃÂ¶","Hello, World ö",2',
    ].join('\n');

    expect(parseFixesCsv(csv)).toEqual([{ current: 'Hello, World ÃÂ¶', proposed: 'Hello, World ö' }]);
  });
});

describe('hasMojibakeFingerprint', () => {
  it('detects values whose bytes round-trip from latin1 → utf-8 to a different valid string', () => {
    // 'Î¼-Ziq' is the double-encoded form of 'µ-Ziq': encoded as latin1 then
    // decoded as utf-8 yields the Greek micro sign.
    expect(hasMojibakeFingerprint('Î¼-Ziq')).toBe(true);
    expect(hasMojibakeFingerprint('Î£tella')).toBe(true);
  });

  it('returns false for clean ASCII and clean non-ASCII text', () => {
    // Clean text has no double-encoding fingerprint. We don't want false
    // positives invalidating cache for legitimate diacritics.
    expect(hasMojibakeFingerprint('µ-Ziq')).toBe(false);
    expect(hasMojibakeFingerprint('Σtella')).toBe(false);
    expect(hasMojibakeFingerprint('Nilüfer Yanya')).toBe(false);
    expect(hasMojibakeFingerprint('Hello World')).toBe(false);
  });

  it('returns false for empty / null / undefined', () => {
    expect(hasMojibakeFingerprint(null)).toBe(false);
    expect(hasMojibakeFingerprint(undefined)).toBe(false);
    expect(hasMojibakeFingerprint('')).toBe(false);
  });

  it('returns false for values that round-trip into U+FFFD (lossy)', () => {
    // A '?' inside a latin1-supplement string usually means a byte was dropped
    // by an earlier conversion. The latin1→utf-8 round-trip will surface the
    // replacement char; we treat that as "not a clean fingerprint" so the
    // audit doesn't try to act on it.
    expect(hasMojibakeFingerprint('Astrid Ã?ster Mortenson')).toBe(false);
  });
});

describe('cache column inventories', () => {
  it('exposes the library cache columns the audit will NULL', () => {
    // Pinning these as exported constants makes the contract loud: any new
    // cache column added to `library` should be added here too, or the
    // invalidation will silently miss it.
    expect(LIBRARY_CACHE_COLUMNS).toEqual([
      'artwork_url',
      'canonical_entity_id',
      'canonical_entity_confidence',
      'canonical_entity_resolved_at',
    ]);
  });

  it('exposes the flowsheet cache columns the audit will NULL', () => {
    expect(FLOWSHEET_CACHE_COLUMNS).toEqual([
      'artwork_url',
      'discogs_url',
      'release_year',
      'spotify_url',
      'apple_music_url',
      'youtube_music_url',
      'bandcamp_url',
      'soundcloud_url',
      'artist_bio',
      'artist_wikipedia_url',
    ]);
  });

  it('exposes the library / flowsheet name columns matched against the fix list', () => {
    // album_title is in both: a record_label string can collide with another
    // album title across rows, but we only match exact strings, so over-matching
    // is bounded.
    expect(LIBRARY_NAME_COLUMNS).toEqual(['artist_name', 'album_artist', 'alternate_artist_name', 'album_title']);
    expect(FLOWSHEET_NAME_COLUMNS).toEqual(['artist_name', 'album_title', 'track_title', 'record_label']);
  });
});

describe('countStaleCacheRows', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('returns zero rows when the corrected-name list is empty without touching the database', async () => {
    const counts = await countStaleCacheRows([]);

    expect(counts).toEqual([]);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('counts library + flowsheet rows whose name fields match any corrected name AND have a non-null cache field', async () => {
    // The script issues one SELECT per table. Each SELECT returns a wide row
    // with one COUNT(*) FILTER per cache column, so a single round trip
    // covers all fields without needing per-column queries.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          artwork_url: 4,
          canonical_entity_id: 2,
          canonical_entity_confidence: 2,
          canonical_entity_resolved_at: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          artwork_url: 3,
          discogs_url: 3,
          release_year: 1,
          spotify_url: 0,
          apple_music_url: 0,
          youtube_music_url: 0,
          bandcamp_url: 0,
          soundcloud_url: 0,
          artist_bio: 1,
          artist_wikipedia_url: 1,
        },
      ]);

    const counts = await countStaleCacheRows(['µ-Ziq', 'Σtella']);

    // One entry per (table, cache_column) pair, even if the count is 0 —
    // operators looking at the CSV should see the full audit shape.
    expect(counts).toContainEqual({ table: 'library', cachedField: 'artwork_url', matchedRows: 4 });
    expect(counts).toContainEqual({ table: 'library', cachedField: 'canonical_entity_id', matchedRows: 2 });
    expect(counts).toContainEqual({ table: 'flowsheet', cachedField: 'artwork_url', matchedRows: 3 });
    expect(counts).toContainEqual({ table: 'flowsheet', cachedField: 'spotify_url', matchedRows: 0 });
  });

  it('issues a SELECT against wxyc_schema.library matching every library name column', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{}]);

    await countStaleCacheRows(['µ-Ziq']);

    const librarySelect = findExecuteCallMatching(/SELECT[\s\S]*FROM[\s\S]*"wxyc_schema"\."library"/i);
    expect(librarySelect).toBeDefined();
    const sqlText = renderSql(librarySelect?.[0]);
    // OR matrix across name columns — the cache lookup only knows the row
    // by its name fields, so any of them being a corrected name implicates
    // the cache.
    for (const col of LIBRARY_NAME_COLUMNS) {
      expect(sqlText).toMatch(new RegExp(`"${col}"\\s*=\\s*ANY`, 'i'));
    }
    // FILTER once per cache column.
    for (const col of LIBRARY_CACHE_COLUMNS) {
      expect(sqlText).toMatch(new RegExp(`FILTER\\s*\\(WHERE\\s*"${col}"\\s+IS\\s+NOT\\s+NULL\\)`, 'i'));
    }
  });

  it('issues a SELECT against wxyc_schema.flowsheet matching every flowsheet name column', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{}]);

    await countStaleCacheRows(['µ-Ziq']);

    const flowsheetSelect = findExecuteCallMatching(/SELECT[\s\S]*FROM[\s\S]*"wxyc_schema"\."flowsheet"/i);
    expect(flowsheetSelect).toBeDefined();
    const sqlText = renderSql(flowsheetSelect?.[0]);
    for (const col of FLOWSHEET_NAME_COLUMNS) {
      expect(sqlText).toMatch(new RegExp(`"${col}"\\s*=\\s*ANY`, 'i'));
    }
    for (const col of FLOWSHEET_CACHE_COLUMNS) {
      expect(sqlText).toMatch(new RegExp(`FILTER\\s*\\(WHERE\\s*"${col}"\\s+IS\\s+NOT\\s+NULL\\)`, 'i'));
    }
  });
});

describe('invalidateStaleCacheRows', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('issues UPDATEs that NULL every cache column on rows whose names match', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 4 }).mockResolvedValueOnce({ count: 5 });

    const result = await invalidateStaleCacheRows(['µ-Ziq']);

    const libraryUpdate = findExecuteCallMatching(/UPDATE[\s\S]*"wxyc_schema"\."library"/i);
    expect(libraryUpdate).toBeDefined();
    const librarySql = renderSql(libraryUpdate?.[0]);
    for (const col of LIBRARY_CACHE_COLUMNS) {
      expect(librarySql).toMatch(new RegExp(`"${col}"\\s*=\\s*NULL`, 'i'));
    }

    const flowsheetUpdate = findExecuteCallMatching(/UPDATE[\s\S]*"wxyc_schema"\."flowsheet"/i);
    expect(flowsheetUpdate).toBeDefined();
    const flowsheetSql = renderSql(flowsheetUpdate?.[0]);
    for (const col of FLOWSHEET_CACHE_COLUMNS) {
      expect(flowsheetSql).toMatch(new RegExp(`"${col}"\\s*=\\s*NULL`, 'i'));
    }

    expect(result).toEqual([
      { table: 'library', rowsAffected: expect.any(Number) },
      { table: 'flowsheet', rowsAffected: expect.any(Number) },
    ]);
  });

  it('is a no-op (no SQL issued) when the corrected-name list is empty', async () => {
    const result = await invalidateStaleCacheRows([]);

    expect(result).toEqual([]);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('only updates rows where a name field matches AND at least one cache field is non-null', async () => {
    // Without the "any cache field non-null" guard we'd UPDATE clean rows for
    // no reason — adds row churn and triggers CDC notifications on rows that
    // have nothing to invalidate.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await invalidateStaleCacheRows(['µ-Ziq']);

    const updates = allExecuteCallsMatching(/UPDATE[\s\S]*"wxyc_schema"/i);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const call of updates) {
      const sqlText = renderSql(call[0]);
      // At least one IS NOT NULL guard on a cache column.
      expect(sqlText).toMatch(/IS\s+NOT\s+NULL/i);
    }
  });
});
