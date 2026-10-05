/**
 * Schema-source assertions for `genre_artist_crossreference.code_comp_letter` (BS#2833, epic BS#2828). The
 * runtime behaviour of the constraints is covered against a real Postgres by
 * `tests/integration/genre-artist-crossreference-code-comp-letter.spec.js`; this asserts that `schema.ts` declares the
 * column, that the migration SQL contains the column, the partial unique index and the two CHECKs, and that the
 * migration is additive (no DROP, UPDATE or SET NOT NULL).
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const schemaSource = fs.readFileSync(path.resolve(__dirname, '../../../shared/database/src/schema.ts'), 'utf-8');

const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8'));
const entry = journal.entries.find((e: { tag: string }) =>
  /2833-genre-artist-crossreference-code-comp-letter/.test(e.tag)
);
if (!entry) throw new Error('No journal entry matches /2833-genre-artist-crossreference-code-comp-letter/.');

const ddlOnly = fs
  .readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf-8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('schema: genre_artist_crossreference.code_comp_letter (BS#2833)', () => {
  it('declares a nullable varchar(1) column', () => {
    expect(schemaSource).toMatch(/code_comp_letter: varchar\('code_comp_letter', \{ length: 1 \}\),/);
  });

  it.each([
    ['the column', /ADD COLUMN "code_comp_letter" varchar\(1\);/],
    [
      'the partial unique index',
      /CREATE UNIQUE INDEX "genre_artist_crossreference_genre_comp_letter_key"[^;]*\("genre_id","code_comp_letter"\) WHERE [^;]*"code_comp_letter" IS NOT NULL;/,
    ],
    [
      'the shape CHECK',
      /ADD CONSTRAINT "genre_artist_crossreference_code_comp_letter_shape_ck" CHECK \([^;]*~ '\^\[A-Z\]\$'\);/,
    ],
    [
      'the slot CHECK',
      /ADD CONSTRAINT "genre_artist_crossreference_code_comp_letter_slot_ck" CHECK \([^;]*"code_comp_letter" IS NULL OR [^;]*"artist_genre_code" = 0\);/,
    ],
  ])('migration adds %s', (_label, pattern) => {
    expect(ddlOnly).toMatch(pattern);
  });

  it('migration is additive: no DROP, no UPDATE, no SET NOT NULL', () => {
    expect(ddlOnly).not.toMatch(/\bDROP\b|\bUPDATE\b|SET NOT NULL/i);
  });
});
