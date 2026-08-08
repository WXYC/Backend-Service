/**
 * Schema-source assertions for the composite partial B-tree covering linked
 * flowsheet rows — BS#2032's migration 0139, which superseded BS#1022's
 * `flowsheet_album_id_enriched_idx` (migration 0080).
 *
 * 0080 predicated on `album_id IS NOT NULL AND metadata_attempt_at IS NOT NULL`
 * so its WHERE clause matched album-metadata-backfill's verify query verbatim.
 * That made it useless for a bare `album_id = <id>` equality: the equality
 * implies the first conjunct but says nothing about the second, so the planner
 * could not prove the partial predicate held and seq-scanned the ~1.7 GB heap.
 *
 * 0139 drops the second conjunct from the PREDICATE but keeps the column as a
 * KEY. Both halves matter, and this file pins both:
 *
 *   1. Predicate is `album_id IS NOT NULL` alone  — so `album_id = <id>` is
 *      provably covered and uses the index.
 *   2. `metadata_attempt_at` remains a key column — so every column the verify
 *      query references is still available FROM the index, keeping it on an
 *      Index Only Scan. Drop the column as well as the conjunct and that filter
 *      needs the heap; at ~46% selectivity the planner reverts to the 2.6M-row
 *      Seq Scan that BS#1022 / BS#1019 built 0080 to avoid.
 *
 * The invariant is therefore no longer "predicate matches the consumer's WHERE
 * clause verbatim" but the weaker, sufficient "consumer's WHERE clause implies
 * the predicate, and references no column absent from the index." A future PR
 * that narrows the predicate again, or drops `metadata_attempt_at` from the key
 * list, breaks one of those and surfaces here.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const jobPath = path.resolve(__dirname, '../../../jobs/album-metadata-backfill/job.ts');

// Resolve the migration filename from the journal at load-time so the test
// stays correct if the idx number shifts during rebase. Throwing here turns
// "no journal entry yet" into a clear top-level setup failure rather than a
// confusing per-test cascade.
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /album-id-linked/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /album-id-linked/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

// The comment block legitimately quotes the CONCURRENTLY runbook and the old
// index name, so keyword matches must run against DDL lines only.
const ddlOnly = migrationSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('schema: flowsheet_album_id_linked_idx (composite partial B-tree on album_id)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates the index with IF NOT EXISTS so a prod-prebuilt CONCURRENTLY index is a no-op', () => {
    // The prod ops flow is: build via `CREATE INDEX CONCURRENTLY` against the
    // live RDS to avoid the ShareLock window, then merge the migration.
    // Without IF NOT EXISTS the regular CREATE INDEX would fail on prod. Same
    // shape as 0070 / 0074 / 0078 / 0080 — docs/migrations.md#if-not-exists-index.
    expect(ddlOnly).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_album_id_linked_idx"/i);
  });

  it('migration retires 0080 index with IF EXISTS so the swap is index-count-neutral', () => {
    // Dropped rather than left in place: flowsheet's index bloat is an open
    // concern (BS#1058), and this index is a strict superset of 0080's.
    expect(ddlOnly).toMatch(/DROP INDEX\s+IF EXISTS\s+"wxyc_schema"\."flowsheet_album_id_enriched_idx"/i);
  });

  it('migration keys the index on album_id FIRST, then metadata_attempt_at', () => {
    // Order is load-bearing. `album_id` must lead or a bare `album_id = <id>`
    // equality cannot use the index, which is the entire point of BS#2032.
    expect(ddlOnly).toMatch(
      /ON\s+"wxyc_schema"\."flowsheet"\s+(?:USING\s+btree\s+)?\(\s*"album_id"\s*,\s*"metadata_attempt_at"\s*\)/i
    );
  });

  it('migration predicate is album_id IS NOT NULL ALONE, so an equality on album_id is provably covered', () => {
    expect(ddlOnly).toMatch(/WHERE[\s\S]*"album_id"\s+IS\s+NOT\s+NULL/i);
    // The regression this guards: re-adding the `metadata_attempt_at IS NOT
    // NULL` conjunct to the PREDICATE (as opposed to the key list) puts the
    // index back out of reach of a bare `album_id = <id>` equality.
    const whereClause = ddlOnly.slice(ddlOnly.search(/WHERE/i));
    expect(whereClause).not.toMatch(/"metadata_attempt_at"\s+IS\s+NOT\s+NULL/i);
    // Guard against accidental drift to a track-only predicate. Non-track
    // entries always have `album_id IS NULL`, so the predicate restricts to
    // track rows on its own; an explicit guard would only narrow it further.
    expect(whereClause).not.toMatch(/"entry_type"\s*=\s*'track'/i);
  });

  it('migration does NOT use CONCURRENTLY in actual DDL (incompatible with drizzle txn wrapping)', () => {
    // Drizzle wraps each migration in a transaction. CONCURRENTLY would raise
    // "cannot run inside a transaction block". The runbook builds out-of-band
    // and lets IF NOT EXISTS / IF EXISTS make the apply a no-op.
    expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
    expect(ddlOnly).not.toMatch(/DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+CONCURRENTLY/i);
  });

  it('schema.ts declares the index with both key columns so drizzle-kit drift detection sees it', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/index\(\s*'flowsheet_album_id_linked_idx'\s*\)/);
    expect(schemaSource).toMatch(/\.on\(\s*table\.album_id\s*,\s*table\.metadata_attempt_at\s*\)/);
    expect(schemaSource).toMatch(/\$\{table\.album_id\}\s+IS\s+NOT\s+NULL/);
    // 0080's declaration is gone, not merely edited around.
    expect(schemaSource).not.toMatch(/index\(\s*'flowsheet_album_id_enriched_idx'\s*\)/);
  });

  it('album-metadata-backfill verify query references no column absent from the index', () => {
    // The Index Only Scan invariant. The verify query filters on
    // `metadata_attempt_at`, which this index no longer covers via its
    // predicate — it covers it as a stored key instead. If that column ever
    // leaves the key list while this consumer still filters on it, the query
    // drops to a heap-touching scan and re-hits BS#1022.
    const jobSource = fs.readFileSync(jobPath, 'utf-8');
    expect(jobSource).toMatch(/"album_id"\s+IS\s+NOT\s+NULL[\s\S]*?AND[\s\S]*?"metadata_attempt_at"\s+IS\s+NOT\s+NULL/);
    expect(ddlOnly).toMatch(/"metadata_attempt_at"/);
  });
});
