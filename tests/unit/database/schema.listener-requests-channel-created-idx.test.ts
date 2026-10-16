/**
 * Pins `listener_requests_channel_created_idx` to `(slack_channel_id, created_at DESC NULLS FIRST)` (BS#2679). Migration 0175 shipped it `DESC NULLS LAST` (drizzle's emission for a bare `.desc()`), which no `ORDER BY created_at DESC` can use because Postgres reads that as `DESC NULLS FIRST`, so the planner sorts instead of walking the index. The correction is a later migration, since 0175 is applied and hash-frozen.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { listener_requests } from '../../../shared/database/src/schema';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8'));
const entry = journal.entries.find((e: { tag: string }) =>
  /_listener-requests-channel-created-idx-nulls-first$/.test(e.tag)
);
if (!entry) {
  throw new Error('No journal entry matches /_listener-requests-channel-created-idx-nulls-first$/.');
}

const ddlOnly = fs
  .readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf-8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('schema: listener_requests_channel_created_idx (BS#2679)', () => {
  it('declares created_at DESC NULLS FIRST behind slack_channel_id', () => {
    const idx = getTableConfig(listener_requests).indexes.find(
      (i) => i.config.name === 'listener_requests_channel_created_idx'
    );
    const columns = idx?.config.columns.map((c) => {
      const col = c as { name: string; indexConfig: { order: string; nulls: string } };
      return [col.name, col.indexConfig.order, col.indexConfig.nulls];
    });
    expect(columns).toEqual([
      ['slack_channel_id', 'asc', 'last'],
      ['created_at', 'desc', 'first'],
    ]);
  });

  it('migration drops the NULLS LAST index and recreates it DESC NULLS FIRST', () => {
    expect(ddlOnly).toMatch(/DROP INDEX "wxyc_schema"\."listener_requests_channel_created_idx"/);
    expect(ddlOnly).toContain(
      'CREATE INDEX "listener_requests_channel_created_idx" ON "wxyc_schema"."listener_requests" USING btree ("slack_channel_id","created_at" DESC NULLS FIRST);'
    );
  });

  it('migration is DDL-only', () => {
    expect(ddlOnly).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
