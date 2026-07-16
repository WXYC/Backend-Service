/**
 * Schema-shape sanity check for the album_review_submissions table
 * (album-reviews-sheet-sync plan, PR 2a). Mirrors the pattern of
 * `schema.concerts.test.ts`: read the source as text and assert the
 * columns / FK / indexes are declared as the migration expects, then pin
 * the generated .sql itself.
 *
 * The table is the form-sourced review ARCHIVE (ADR 0011) — deliberately
 * separate from the ADR 0006 `reviews` model. If you rename a column or
 * change a constraint, read the assertion before "fixing" it; usually the
 * right fix is a companion migration, not the test.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('schema: album_review_submissions (album-reviews-etl, ADR 0011)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  // Matched by tag suffix, not idx/prefix: the leading number is allocated
  // by drizzle-kit at generate time and concurrent migration PRs can shift
  // it on rebase.
  const entry = journal.entries.find((e) => e.tag.endsWith('album-review-submissions'));
  const sqlPath = entry ? path.join(migrationsDir, `${entry.tag}.sql`) : null;
  const sql = sqlPath && fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('table declaration (schema.ts)', () => {
    it('is declared as a wxyc_schema table with Infer types exported', () => {
      expect(schemaSource).toMatch(/export const album_review_submissions\s*=\s*wxyc_schema\.table/);
      expect(schemaSource).toMatch(/export type AlbumReviewSubmission = InferSelectModel<typeof album_review_submissions>/);
      expect(schemaSource).toMatch(
        /export type NewAlbumReviewSubmission = InferInsertModel<typeof album_review_submissions>/
      );
    });

    it('FKs album_id to library.id as nullable + ON DELETE SET NULL (best-effort link; free-text identity survives library deletions)', () => {
      const def = extractTableDef('album_review_submissions');
      // Declared without .notNull(), so nullable.
      expect(def).toMatch(/album_id:\s*integer\(['"]album_id['"]\)\s*\.references/);
      expect(def).toMatch(/album_id[\s\S]*?\.references\(\(\)\s*=>\s*library\.id[\s\S]*?onDelete:\s*['"]set null['"]/);
      const column = def.match(/album_id:\s*integer\([^)]*\)[\s\S]*?(?=\n\s{4}\w+:|\n\s{2}\},)/);
      expect(column?.[0]).toBeDefined();
      expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
    });

    it('has the raw form-content text columns', () => {
      const def = extractTableDef('album_review_submissions');
      for (const col of [
        'artist_name',
        'album_title',
        'record_label',
        'artist_blurb',
        'review',
        'recommended_tracks',
        'buzzwords',
        'fcc_violations',
        'review_purpose',
        'reviewer_raw',
        'social_consent_raw',
      ]) {
        expect(def).toMatch(new RegExp(`${col}:\\s*text\\(['"]${col}['"]\\)`));
      }
    });

    it('has the normalized boolean columns, all nullable (messy human input degrades to null, raw kept verbatim)', () => {
      const def = extractTableDef('album_review_submissions');
      for (const col of ['social_consent', 'released_within_six_months', 'rotated']) {
        const column = def.match(new RegExp(`${col}:\\s*boolean\\([^)]*\\)[^,\\n]*`));
        expect(column?.[0]).toBeDefined();
        expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
      }
    });

    it('has submitted_at as a NULLABLE timestamptz (one archive row has no parseable form timestamp)', () => {
      const def = extractTableDef('album_review_submissions');
      const column = def.match(/submitted_at:\s*timestamp\([^)]*\)[^,\n]*/);
      expect(column?.[0]).toBeDefined();
      expect(column?.[0]).toMatch(/withTimezone:\s*true/);
      expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
    });

    it('has source as text NOT NULL DEFAULT google_form (documented vocabulary, not a pgEnum — the 0109 lesson)', () => {
      const def = extractTableDef('album_review_submissions');
      const column = def.match(/source:\s*text\([^)]*\)[^,\n]*/);
      expect(column?.[0]).toBeDefined();
      expect(column?.[0]).toMatch(/\.notNull\(\)/);
      expect(column?.[0]).toMatch(/\.default\(['"]google_form['"]\)/);
    });

    it('has source_key (nullable text) and the persisted norm_artist/norm_album columns', () => {
      const def = extractTableDef('album_review_submissions');
      for (const col of ['source_key', 'norm_artist', 'norm_album']) {
        const column = def.match(new RegExp(`${col}:\\s*text\\([^)]*\\)[^,\\n]*`));
        expect(column?.[0]).toBeDefined();
        expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
      }
    });

    it('has the INSERT-only add_date anchor and last_modified, both NOT NULL defaultNow', () => {
      const def = extractTableDef('album_review_submissions');
      expect(def).toMatch(/add_date:\s*date\(['"]add_date['"]\)\.defaultNow\(\)\.notNull\(\)/);
      const lastModified = def.match(/last_modified:\s*timestamp\([^)]*\)[^,\n]*/);
      expect(lastModified?.[0]).toBeDefined();
      expect(lastModified?.[0]).toMatch(/withTimezone:\s*true/);
      expect(lastModified?.[0]).toMatch(/\.defaultNow\(\)/);
      expect(lastModified?.[0]).toMatch(/\.notNull\(\)/);
    });

    it('declares the partial UNIQUE index on source_key WHERE source_key IS NOT NULL (the UPSERT conflict target)', () => {
      const def = extractTableDef('album_review_submissions');
      expect(def).toMatch(
        /uniqueIndex\(['"]album_review_submissions_source_key_uq['"]\)[\s\S]*?\.on\(table\.source_key\)[\s\S]*?\.where\([\s\S]*?source_key[\s\S]*?IS NOT NULL/
      );
    });

    it('declares the album_id, submitted_at and norm_artist btree indexes', () => {
      const def = extractTableDef('album_review_submissions');
      expect(def).toMatch(/index\(['"]album_review_submissions_album_id_idx['"]\)[\s\S]*?\.on\(table\.album_id\)/);
      expect(def).toMatch(
        /index\(['"]album_review_submissions_submitted_at_idx['"]\)[\s\S]*?\.on\(table\.submitted_at\)/
      );
      expect(def).toMatch(
        /index\(['"]album_review_submissions_norm_artist_idx['"]\)[\s\S]*?\.on\(table\.norm_artist\)/
      );
    });
  });

  describe('migration (generated .sql)', () => {
    it('exists in the journal with a matching .sql file', () => {
      expect(entry).toBeDefined();
      expect(sql.length).toBeGreaterThan(0);
    });

    it('creates the table in wxyc_schema', () => {
      expect(sql).toMatch(/CREATE TABLE "wxyc_schema"\."album_review_submissions"/);
    });

    it('declares the album_id FK with ON DELETE SET NULL', () => {
      expect(sql).toMatch(
        /FOREIGN KEY \("album_id"\) REFERENCES "wxyc_schema"\."library"\("id"\) ON DELETE set null/i
      );
    });

    it('creates the partial UNIQUE source_key index and the three btree indexes, all IF NOT EXISTS (out-of-band CONCURRENTLY runbook)', () => {
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "album_review_submissions_source_key_uq" ON "wxyc_schema"\."album_review_submissions"[\s\S]*?WHERE[\s\S]*?"source_key" IS NOT NULL/
      );
      for (const idx of [
        'album_review_submissions_album_id_idx',
        'album_review_submissions_submitted_at_idx',
        'album_review_submissions_norm_artist_idx',
      ]) {
        expect(sql).toMatch(
          new RegExp(`CREATE INDEX IF NOT EXISTS "${idx}" ON "wxyc_schema"\\."album_review_submissions"`)
        );
      }
      // The comment block must carry the exact out-of-band CONCURRENTLY
      // command (docs/migrations.md if-not-exists-index rule).
      expect(sql).toMatch(/CREATE INDEX CONCURRENTLY|CREATE UNIQUE INDEX CONCURRENTLY/);
      expect(sql).toMatch(/cannot run inside a transaction/i);
    });

    it('carries the @no-precondition-needed annotation (fresh table, no pre-existing rows) so validate-migrations Check 8 stays quiet', () => {
      expect(sql).toMatch(/--\s*@no-precondition-needed:\s*new table, no pre-existing rows/);
    });

    it('is DDL-only (no DML on existing tables)', () => {
      const ddlOnly = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      // `UPDATE ... SET` (DML), not the FK's `ON UPDATE no action` (DDL).
      expect(ddlOnly).not.toMatch(/\bUPDATE\s+"[\w."]+"\s+SET\b/i);
      expect(ddlOnly).not.toMatch(/\bDELETE FROM\b/i);
      expect(ddlOnly).not.toMatch(/\bINSERT INTO\b/i);
    });
  });
});
