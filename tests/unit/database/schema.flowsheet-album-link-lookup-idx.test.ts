/**
 * Schema-source assertions for the post-D5 partial functional index that
 * supports the playlist-proxy artwork lookup.
 *
 * The lookup-key expression and the partial WHERE predicate must appear
 * identically in three places:
 *   1. The migration SQL (0081)                    — what runs in production
 *   2. The Drizzle schema declaration              — drift detection / typing
 *   3. The playlist-proxy SQL builder              — `flowsheetLookupKey` + the
 *                                                    `innerJoin(album_metadata, ...)`
 *                                                    in `apps/backend/services/playlist-proxy.service.ts`
 * If any drifts, the partial index becomes dead weight (planner declines it
 * when the query's filter doesn't match) and the playlist-proxy lookup
 * regresses to a seq scan of the 2.6M-row flowsheet table — exactly the
 * incident #511 failure mode this index exists to prevent.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const proxyPath = path.resolve(__dirname, '../../../apps/backend/services/playlist-proxy.service.ts');

// Resolve the migration filename from the journal at load-time so the test
// stays correct if the idx number shifts during rebase. Throwing here turns
// "no journal entry yet" into a clear top-level setup failure rather than a
// confusing per-test cascade.
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /album-link-lookup/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /album-link-lookup/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

describe('schema: flowsheet_album_link_lookup_idx (partial functional index for playlist-proxy)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates the index with IF NOT EXISTS so a prod-prebuilt CONCURRENTLY index is a no-op', () => {
    // Same prod-ops pattern as 0068 / 0070 / 0074 / 0078 / 0080: build
    // CONCURRENTLY first to avoid the ShareLock window on the 2.6M-row
    // flowsheet table, then merge the migration with IF NOT EXISTS.
    expect(migrationSql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_album_link_lookup_idx"/i);
  });

  it('migration scopes the index to flowsheet using btree on the lookup-key expression', () => {
    expect(migrationSql).toMatch(
      /ON\s+"wxyc_schema"\."flowsheet"\s+(?:USING\s+btree\s+)?\(\(lower\(trim\("artist_name"\)\)\s+\|\|\s+'-'\s+\|\|\s+lower\(trim\(coalesce\("album_title",\s*''\)\)\)\)\)/i
    );
  });

  it('migration carries the partial WHERE predicate (album_id IS NOT NULL)', () => {
    expect(migrationSql).toMatch(/WHERE[\s\S]*"album_id"\s+IS\s+NOT\s+NULL/i);
  });

  it('migration does NOT use CREATE INDEX CONCURRENTLY in actual DDL (incompatible with drizzle txn wrapping)', () => {
    // The comment block legitimately mentions CONCURRENTLY in its prose +
    // runbook example, so filter SQL-comment lines (`-- ...`) before matching.
    const ddlOnly = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
  });

  it('schema.ts declares the index so drizzle-kit drift detection sees it', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/index\(\s*'flowsheet_album_link_lookup_idx'\s*\)/);
    // The schema's WHERE expression must mirror the migration's predicate.
    expect(schemaSource).toMatch(/\$\{table\.album_id\}\s+IS\s+NOT\s+NULL/);
  });

  it('playlist-proxy SQL builder uses the same lookup-key expression the index covers', () => {
    // `flowsheetLookupKey` in playlist-proxy.service.ts must compute the
    // same `lower(trim(artist_name)) || '-' || lower(trim(coalesce(album_title, '')))`
    // expression. If the casing, trimming, or coalesce default ever drifts,
    // the planner declines the functional index and the query falls back to
    // a 2.6M-row seq scan (incident #511).
    const proxySource = fs.readFileSync(proxyPath, 'utf-8');
    expect(proxySource).toMatch(
      /lower\(trim\(\$\{flowsheet\.artist_name\}\)\)\s*\|\|\s*'-'\s*\|\|\s*lower\(trim\(coalesce\(\$\{flowsheet\.album_title\},\s*''\)\)\)/
    );
  });
});
