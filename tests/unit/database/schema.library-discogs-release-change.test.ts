/**
 * Pins `library_discogs_release_change` and `library_discogs_release_change_before` (BS#3792, plan BS#3790): the
 * record of every music-director change to a release's Discogs link through the release picker, and the before image
 * of the `album_metadata` row each change overwrote.
 *
 * `check:db-mock-sync` compares column names only, and `lint:migrations` validates the journal, not the DDL, so this
 * test pins the column types and nullability, the CHECK, the index, the keys, that only the change table carries the
 * CDC trigger, and that the migration is DDL-only. The integration spec
 * (`tests/integration/library-discogs-release-change-schema.spec.js`) proves the trigger and constraints against a real
 * Postgres.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  library_discogs_release_change,
  library_discogs_release_change_before,
} from '../../../shared/database/src/schema';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8'));
const entry = journal.entries.find((e: { tag: string }) => /_library-discogs-release-change$/.test(e.tag));
if (!entry) throw new Error('No journal entry matches /_library-discogs-release-change$/.');

const ddlOnly = fs
  .readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf-8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const change = getTableConfig(library_discogs_release_change);
const before = getTableConfig(library_discogs_release_change_before);

describe('schema: library_discogs_release_change (BS#3792)', () => {
  it('lives in wxyc_schema with exactly the planned columns', () => {
    expect(change.schema).toBe('wxyc_schema');
    expect(change.name).toBe('library_discogs_release_change');
    expect(change.columns.map((c) => c.name)).toEqual([
      'id',
      'album_id',
      'actor_user_id',
      'changed_at',
      'old_discogs_release_id',
      'new_discogs_release_id',
      'replaced_pin_discogs_release_id',
      'replaced_pin_source',
    ]);
  });

  it.each([
    ['id', 'bigserial', true],
    ['album_id', 'integer', true],
    ['actor_user_id', 'text', true],
    ['changed_at', 'timestamp with time zone', true],
    ['old_discogs_release_id', 'integer', false],
    ['new_discogs_release_id', 'integer', true],
    ['replaced_pin_discogs_release_id', 'integer', false],
    ['replaced_pin_source', 'text', false],
  ])('declares %s as %s (NOT NULL: %s)', (name, sqlType, notNull) => {
    const column = change.columns.find((c) => c.name === name);
    expect(column?.getSQLType()).toBe(sqlType);
    expect(column?.notNull).toBe(notNull);
  });

  it('makes id the primary key and defaults changed_at to now()', () => {
    expect(change.columns.find((c) => c.name === 'id')?.primary).toBe(true);
    expect(change.columns.find((c) => c.name === 'changed_at')?.hasDefault).toBe(true);
  });

  it('has no foreign keys, so the record outlives a delete of the release or the user', () => {
    expect(change.foreignKeys).toHaveLength(0);
  });

  it('indexes album_id for the per-album guard', () => {
    const idx = change.indexes.find((i) => i.config.name === 'library_discogs_release_change_album_id_idx');
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.columns.map((c) => ('name' in c ? c.name : undefined))).toEqual(['album_id']);
  });

  it('declares the release-id CHECKs: new positive, old and replaced-pin NULL or positive (no 0 sentinel)', () => {
    expect(change.checks.map((c) => c.name)).toEqual([
      'library_discogs_release_change_new_release_id_ck',
      'library_discogs_release_change_old_release_id_ck',
      'library_discogs_release_change_replaced_pin_release_id_ck',
    ]);
  });
});

describe('schema: library_discogs_release_change_before (BS#3792)', () => {
  it('lives in wxyc_schema with exactly the planned columns', () => {
    expect(before.schema).toBe('wxyc_schema');
    expect(before.name).toBe('library_discogs_release_change_before');
    expect(before.columns.map((c) => c.name)).toEqual(['change_id', 'before_image']);
  });

  it.each([
    ['change_id', 'bigint'],
    ['before_image', 'jsonb'],
  ])('declares %s as NOT NULL %s', (name, sqlType) => {
    const column = before.columns.find((c) => c.name === name);
    expect(column?.getSQLType()).toBe(sqlType);
    expect(column?.notNull).toBe(true);
  });

  it('is keyed by the change row, and goes with it', () => {
    expect(before.columns.find((c) => c.name === 'change_id')?.primary).toBe(true);
    expect(before.foreignKeys).toHaveLength(1);
    const fk = before.foreignKeys[0].reference();
    expect(getTableConfig(fk.foreignTable).name).toBe('library_discogs_release_change');
    expect(fk.columns.map((c) => c.name)).toEqual(['change_id']);
    expect(fk.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(before.foreignKeys[0].onDelete).toBe('cascade');
  });
});

describe('migration: library-discogs-release-change (BS#3792)', () => {
  it.each([
    [
      'the change table',
      /CREATE TABLE "wxyc_schema"\."library_discogs_release_change" \(\s*"id" bigserial PRIMARY KEY NOT NULL,\s*"album_id" integer NOT NULL,\s*"actor_user_id" text NOT NULL,\s*"changed_at" timestamp with time zone DEFAULT now\(\) NOT NULL,\s*"old_discogs_release_id" integer,\s*"new_discogs_release_id" integer NOT NULL,\s*"replaced_pin_discogs_release_id" integer,\s*"replaced_pin_source" text,/,
    ],
    [
      'the positive new-release CHECK',
      /CONSTRAINT "library_discogs_release_change_new_release_id_ck" CHECK \("wxyc_schema"\."library_discogs_release_change"\."new_discogs_release_id" > 0\)/,
    ],
    [
      'the NULL-or-positive old-release CHECK',
      /CONSTRAINT "library_discogs_release_change_old_release_id_ck" CHECK \("wxyc_schema"\."library_discogs_release_change"\."old_discogs_release_id" IS NULL OR "wxyc_schema"\."library_discogs_release_change"\."old_discogs_release_id" > 0\)/,
    ],
    [
      'the NULL-or-positive replaced-pin CHECK',
      /CONSTRAINT "library_discogs_release_change_replaced_pin_release_id_ck" CHECK \("wxyc_schema"\."library_discogs_release_change"\."replaced_pin_discogs_release_id" IS NULL OR "wxyc_schema"\."library_discogs_release_change"\."replaced_pin_discogs_release_id" > 0\)/,
    ],
    [
      'the before table',
      /CREATE TABLE "wxyc_schema"\."library_discogs_release_change_before" \(\s*"change_id" bigint PRIMARY KEY NOT NULL,\s*"before_image" jsonb NOT NULL\s*\)/,
    ],
    [
      'the cascading foreign key from the before table',
      /FOREIGN KEY \("change_id"\) REFERENCES "wxyc_schema"\."library_discogs_release_change"\("id"\) ON DELETE cascade/,
    ],
    [
      'the album_id index',
      /CREATE INDEX "library_discogs_release_change_album_id_idx" ON "wxyc_schema"\."library_discogs_release_change" USING btree \("album_id"\);/,
    ],
    [
      'the CDC trigger on the change table, on INSERT only (the cache-clear signal)',
      /CREATE TRIGGER cdc_library_discogs_release_change AFTER INSERT ON wxyc_schema\.library_discogs_release_change FOR EACH ROW EXECUTE FUNCTION cdc_notify\(\);/,
    ],
  ])('creates %s', (_label, pattern) => {
    expect(ddlOnly).toMatch(pattern);
  });

  it('puts a CDC trigger on the change table only', () => {
    expect(ddlOnly.match(/CREATE TRIGGER/g)).toHaveLength(1);
    expect(ddlOnly).not.toMatch(/ON wxyc_schema\.library_discogs_release_change_before\b/);
  });

  it('is DDL-only and additive: no DROP, INSERT, UPDATE or DELETE statements', () => {
    // The trigger's event list names INSERT, so match statements, not words.
    expect(ddlOnly).not.toMatch(/^\s*(DROP|INSERT|UPDATE|DELETE)\b/im);
  });
});
