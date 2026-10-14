/**
 * Pins `album_metadata_reask_backup` (BS#3139, tracker BS#3137 decision 7): the one backup table the album_metadata re-ask writes for all three targets (`album_metadata`, `library`, `flowsheet`) plus the per-album `restore` marker.
 * `check:db-mock-sync` compares column names only, and `lint:migrations` validates the journal, not the DDL, so this test pins the column types, nullability, the `target_table` CHECK, the indexes, the absence of foreign keys (a backup must outlive a delete), and that the migration is DDL-only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { album_metadata_reask_backup } from '../../../shared/database/src/schema';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8'));
const entry = journal.entries.find((e: { tag: string }) => /_album-metadata-reask-backup$/.test(e.tag));
if (!entry) throw new Error('No journal entry matches /_album-metadata-reask-backup$/.');

const ddlOnly = fs
  .readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf-8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const config = getTableConfig(album_metadata_reask_backup);

describe('schema: album_metadata_reask_backup (BS#3139)', () => {
  it('lives in wxyc_schema', () => {
    expect(config.schema).toBe('wxyc_schema');
    expect(config.name).toBe('album_metadata_reask_backup');
  });

  it('has exactly the planned columns', () => {
    expect(config.columns.map((c) => c.name)).toEqual([
      'id',
      'run_id',
      'target_table',
      'row_id',
      'album_id',
      'before_image',
      'after_image',
      'provenance',
      'written_at',
    ]);
  });

  it.each([
    ['id', 'bigserial'],
    ['run_id', 'text'],
    ['target_table', 'text'],
    ['row_id', 'integer'],
    ['album_id', 'integer'],
    ['before_image', 'jsonb'],
    ['after_image', 'jsonb'],
    ['provenance', 'jsonb'],
    ['written_at', 'timestamp with time zone'],
  ])('declares %s as NOT NULL %s', (name, sqlType) => {
    const column = config.columns.find((c) => c.name === name);
    expect(column?.notNull).toBe(true);
    expect(column?.getSQLType()).toBe(sqlType);
  });

  it('makes id the primary key', () => {
    expect(config.columns.find((c) => c.name === 'id')?.primary).toBe(true);
  });

  it('has no foreign keys, so a backup outlives a delete of the row it saved', () => {
    expect(config.foreignKeys).toHaveLength(0);
  });

  it.each([
    ['album_metadata_reask_backup_run_target_idx', ['run_id', 'target_table']],
    ['album_metadata_reask_backup_album_id_idx', ['album_id']],
  ])('declares index %s on %j', (name, columns) => {
    const idx = config.indexes.find((i) => i.config.name === name);
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.columns.map((c) => ('name' in c ? c.name : undefined))).toEqual(columns);
  });

  it('declares the target_table CHECK in the schema', () => {
    expect(config.checks.map((c) => c.name)).toEqual(['album_metadata_reask_backup_target_table_ck']);
  });

  it.each([
    [
      'the table',
      /CREATE TABLE "wxyc_schema"\."album_metadata_reask_backup" \(\s*"id" bigserial PRIMARY KEY NOT NULL,\s*"run_id" text NOT NULL,\s*"target_table" text NOT NULL,\s*"row_id" integer NOT NULL,\s*"album_id" integer NOT NULL,\s*"before_image" jsonb NOT NULL,\s*"after_image" jsonb NOT NULL,\s*"provenance" jsonb NOT NULL,\s*"written_at" timestamp with time zone NOT NULL,/,
    ],
    [
      'the target_table CHECK with exactly the four targets',
      /CONSTRAINT "album_metadata_reask_backup_target_table_ck" CHECK \("wxyc_schema"\."album_metadata_reask_backup"\."target_table" IN \('album_metadata', 'library', 'flowsheet', 'restore'\)\)/,
    ],
    [
      'the (run_id, target_table) index',
      /CREATE INDEX "album_metadata_reask_backup_run_target_idx" ON "wxyc_schema"\."album_metadata_reask_backup" USING btree \("run_id","target_table"\);/,
    ],
    [
      'the album_id index',
      /CREATE INDEX "album_metadata_reask_backup_album_id_idx" ON "wxyc_schema"\."album_metadata_reask_backup" USING btree \("album_id"\);/,
    ],
  ])('migration creates %s', (_label, pattern) => {
    expect(ddlOnly).toMatch(pattern);
  });

  it('migration is DDL-only and additive: no DROP, INSERT, UPDATE, DELETE or REFERENCES', () => {
    expect(ddlOnly).not.toMatch(/\b(DROP|INSERT|UPDATE|DELETE|REFERENCES)\b/i);
  });
});
