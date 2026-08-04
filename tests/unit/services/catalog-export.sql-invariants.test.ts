import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Source-level guards on the two catalog-export queries (BS#1965).
 *
 * # Why these are source greps and not runtime assertions
 *
 * The pg integration spec (`tests/integration/library-catalog-producer-export.spec.js`)
 * asserts the OBSERVABLE result of these queries, which is the right primary
 * signal. But for the `COLLATE "C"` ordering it cannot be the ONLY signal,
 * because the test environment is physically unable to distinguish a query that
 * pins the collation from one that does not:
 *
 *   CI and dev run `postgres:18.0-alpine` (`.github/workflows/test.yml`,
 *   `dev_env/docker-compose.yml`). Alpine is musl. musl does not implement
 *   glibc locales, so a database created with `en_US.utf8` reports
 *   `datcollate=en_US.utf8` but collates by BYTE ORDER — which is exactly what
 *   `COLLATE "C"` produces. Measured on `postgres:18.0-alpine` with the
 *   integration spec's own fixture names:
 *
 *     without COLLATE "C" -> {BS1965 Xref Beta, BS1965 Xref Gamma, bs1965 Xref Delta}
 *     with    COLLATE "C" -> {BS1965 Xref Beta, BS1965 Xref Gamma, bs1965 Xref Delta}
 *
 *   Identical. Deleting the COLLATE from the query leaves the integration spec
 *   green. On prod (RDS PostgreSQL 14.22, glibc) the same names give:
 *
 *     without COLLATE "C" -> {BS1965 Xref Beta, bs1965 Xref Delta, BS1965 Xref Gamma}
 *     with    COLLATE "C" -> {BS1965 Xref Beta, BS1965 Xref Gamma, bs1965 Xref Delta}
 *
 *   They differ. So the collation does real work exactly where no test runs, and
 *   its removal is invisible everywhere a test does run.
 *
 * That asymmetry is why this file exists. The SSOT (wxyc-shared api.yaml,
 * CatalogExportRow.cross_reference_names) MANDATES code-point ordering, and the
 * library.db producer (discogs-etl#351) joins these names with `" | "` into a
 * SQLite column that discogs-etl#346's byte-parity gate compares. A silent
 * reordering breaks that gate with no failing test in between.
 *
 * Same idiom as the BS#1477 parity guard (`catalog-export.parity.test.ts`),
 * which reads its source artifacts as text for the same reason: the unit suite
 * runs through ts-jest with `isolatedModules: true`, so nothing here is
 * type-checked at run time and the grep is the assertion that actually fails CI.
 *
 * If a future change makes the export environment glibc (or pins an ICU
 * collation), replace these greps with a real behavioral assertion — a runtime
 * check that can actually fail is strictly better than a source grep.
 */

const SERVICE_SRC = readFileSync(
  resolve(__dirname, '../../../apps/backend/services/catalog-export.service.ts'),
  'utf-8'
);

/**
 * Body of a named exported query function, up to its closing template literal.
 * Throws (rather than using `expect`) because this runs at module scope during
 * collection, where jest's `expect` is not available.
 */
function queryBody(fnName: string): string {
  const start = SERVICE_SRC.indexOf(`export const ${fnName}`);
  if (start === -1) {
    throw new Error(`${fnName} not found in catalog-export.service.ts — did the query get renamed?`);
  }
  const body = SERVICE_SRC.slice(start);
  const end = body.indexOf('`);');
  if (end === -1) {
    throw new Error(`${fnName}'s SQL template literal is not terminated`);
  }
  return stripSqlComments(body.slice(0, end));
}

/**
 * Drop `--` line comments so these greps assert on the SQL that actually
 * executes, not on prose about it. Without this, the comment explaining why the
 * wire value is NOT `' | '`-joined would itself match a grep for `' | '`.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('catalog-export.service SQL invariants (BS#1965)', () => {
  describe('cross_reference_names ordering is collation-pinned', () => {
    const sql = queryBody('getCatalogExportRows');

    it('aggregates cross_reference_names with array_agg, not a pipe-joined string_agg', () => {
      // A regression to string_agg would reintroduce the delimiter the wire
      // contract removed: artist names may contain '|' or ' | ', which would
      // split into phantom aliases downstream (LML splits this field on the pipe).
      expect(sql).toContain('array_agg(DISTINCT');
      expect(sql).not.toMatch(/string_agg\s*\(\s*DISTINCT/);
      expect(sql).not.toContain("' | '");
    });

    it('pins COLLATE "C" on BOTH the aggregate argument and its ORDER BY', () => {
      // Postgres requires an aggregate's ORDER BY expression to appear in its
      // argument list, and a bare column is a DIFFERENT expression from that
      // column COLLATE "C" — so the collation must appear twice or the query
      // fails to plan. Both occurrences are load-bearing; assert the pair.
      const match = sql.match(/array_agg\(DISTINCT[\s\S]*?\)\s*\n?\s*AS cross_reference_names/);
      expect(match).not.toBeNull(); // array_agg(...) AS cross_reference_names
      const aggregate = match === null ? '' : match[0];

      const collateCount = (aggregate.match(/COLLATE "C"/g) ?? []).length;
      expect(collateCount).toBe(2);
      expect(aggregate).toMatch(/ORDER BY[\s\S]*COLLATE "C"/);
    });

    it('COALESCEs a missing alias set to an empty array, never null', () => {
      // Contract: "Empty array when the artist has no cross-references."
      expect(sql).toMatch(/COALESCE\([\s\S]*?cross_reference_names,\s*ARRAY\[\]::varchar\[\]\)/);
    });
  });

  describe('the CTA export repeats the catalog export row-eligibility predicate', () => {
    const catalogSql = queryBody('getCatalogExportRows');
    const ctaSql = queryBody('getCompilationTrackExportRows');

    // The four INNER JOINs that decide whether a library row is exportable. An
    // unfiltered CTA export ships library_release_id values that join to nothing
    // in the library.db `library` table the sibling endpoint produces.
    const ELIGIBILITY_TABLES = ['artists', 'format', 'genres', 'genre_artist_crossreference'];

    it.each(ELIGIBILITY_TABLES)('both queries INNER JOIN %s', (table) => {
      const pattern = new RegExp(`INNER JOIN \\$\\{${table}\\}`);
      expect(catalogSql).toMatch(pattern);
      expect(ctaSql).toMatch(pattern);
    });

    it('joins genre_artist_crossreference on the artist_id + genre_id PAIR in both', () => {
      // The pair is what makes this predicate able to drop rows at all — a
      // single-column join would match far more broadly and silently stop
      // filtering, defeating the guard while still looking like one.
      const pair =
        /genre_artist_crossreference\.artist_id\}\s*=\s*\$\{library\.artist_id\}[\s\S]{0,120}genre_artist_crossreference\.genre_id\}\s*=\s*\$\{library\.genre_id\}/;
      expect(catalogSql).toMatch(pair);
      expect(ctaSql).toMatch(pair);
    });
  });
});
