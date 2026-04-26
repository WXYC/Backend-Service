/**
 * Schema-source assertions for the partial functional index that supports
 * the playlist-proxy artwork lookup. The index is the only thing standing
 * between every tubafrenzy SSE event and a 2.6M-row sequential scan, so
 * drift between the migration SQL, the schema declaration, and the query
 * code in `playlist-proxy.service.ts` would silently fall back to that
 * scan without any test failure — exactly the wedge from incident #511.
 *
 * The expression `lower(trim(artist_name)) || '-' || lower(trim(coalesce(album_title, '')))`
 * must appear identically (modulo normalization) in three places:
 *   1. The migration SQL                       — what runs in production
 *   2. The Drizzle schema declaration          — drift detection / typing
 *   3. The query in playlist-proxy.service.ts  — the consumer
 * If any of the three drifts, the others become dead weight or silently
 * regress to seq scans.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const migrationPath = path.join(migrationsDir, '0057_flowsheet-artwork-lookup-partial-idx.sql');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const proxyServicePath = path.resolve(__dirname, '../../../apps/backend/services/playlist-proxy.service.ts');

describe('schema: flowsheet_artwork_lookup_idx (partial functional index)', () => {
  it('migration 0057 exists and creates the index with the exact lookup expression', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE INDEX\s+"flowsheet_artwork_lookup_idx"/i);
    // The expression must use lower(trim(artist_name)) || '-' || lower(trim(coalesce(album_title, '')))
    // — exactly what playlist-proxy.service.ts:flowsheetLookupKey computes.
    // Whitespace-tolerant regex; column quoting tolerated either way.
    expect(sql).toMatch(
      /lower\(\s*trim\(\s*"?artist_name"?\s*\)\s*\)\s*\|\|\s*'-'\s*\|\|\s*lower\(\s*trim\(\s*coalesce\(\s*"?album_title"?\s*,\s*''\s*\)\s*\)\s*\)/i
    );
  });

  it('migration 0057 makes the index partial on artwork_url IS NOT NULL', () => {
    // Critical for size: only ~5-10% of rows have non-null artwork. Without
    // the partial predicate the index is ~10x larger and contains entries
    // that the query never reads.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/WHERE\s+"?artwork_url"?\s+IS\s+NOT\s+NULL/i);
  });

  it('migration 0057 does NOT use CREATE INDEX CONCURRENTLY (must run inside the migration txn)', () => {
    // Drizzle wraps each migration in a transaction. CONCURRENTLY would
    // raise "CREATE INDEX CONCURRENTLY cannot run inside a transaction
    // block". Partial index on ~200K rows builds in seconds; the brief
    // ShareLock on flowsheet is acceptable and keeps the migration shape
    // simple. Match only at the keyword position (after CREATE [UNIQUE]
    // INDEX) to avoid tripping on the word in our own explanatory comment.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
  });

  it('journal includes the 0057 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has57 = journal.entries.some((e: { tag: string }) => e.tag === '0057_flowsheet-artwork-lookup-partial-idx');
    expect(has57).toBe(true);
  });

  it('schema.ts declares the index so drizzle-kit drift detection sees it', () => {
    // If the index lives only in the SQL but not the schema, every future
    // `drizzle-kit generate` run against this schema would see the index
    // as drift and try to drop it. Declaring it in schema.ts keeps drift
    // detection happy.
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/index\(\s*'flowsheet_artwork_lookup_idx'\s*\)/);
    // The schema's expression must mirror the migration's. Loose match for
    // template-literal whitespace; the structure is what matters.
    expect(schemaSource).toMatch(
      /lower\(trim\(\$\{table\.artist_name\}\)\)\s*\|\|\s*'-'\s*\|\|\s*lower\(trim\(coalesce\(\$\{table\.album_title\},\s*''\)\)\)/
    );
    expect(schemaSource).toMatch(/\.where\(sql`\$\{table\.artwork_url\} IS NOT NULL`\)/);
  });

  it('playlist-proxy.service.ts uses the same lookup-key expression', () => {
    // Fail-fast guard against the consumer drifting away from the indexed
    // expression. If someone refactors the lookup key (e.g. drops the
    // coalesce, swaps columns) without updating the index, every SSE event
    // silently regresses to a seq scan.
    const proxySource = fs.readFileSync(proxyServicePath, 'utf-8');
    expect(proxySource).toMatch(
      /lower\(trim\(\$\{flowsheet\.artist_name\}\)\)\s*\|\|\s*'-'\s*\|\|\s*lower\(trim\(coalesce\(\$\{flowsheet\.album_title\},\s*''\)\)\)/
    );
  });
});
