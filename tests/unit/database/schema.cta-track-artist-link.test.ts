/**
 * Schema-shape sanity check for the compilation_track_artist per-track
 * artist link (migration 0140, BS#1990 / #801 S1). Mirrors
 * schema.artist-similar-artists.test.ts: read the schema source + the
 * migration SQL as text and assert the columns / FK / CHECK / indexes are
 * declared as the migration expects.
 *
 * Scope: additive columns only (track_artist_id, track_artist_link_confidence,
 * track_artist_link_method), a btree on track_artist_id, and two GIN trgm
 * indexes matching the CTA suggest query's exact-ILIKE artist_name +
 * prefix-ILIKE track_title shape. The (library_id, artist_name, track_title)
 * unique key (0037's cta_unique_idx) is PERMANENT per #801 D7 and must not
 * change. The issue's 2026-08-06 amendment also proposed dropping
 * cta_unique_null_track_idx (0099 / BS#1135); this migration deliberately
 * does NOT do that — `library.controller.ts`'s `validateCompilationTracksBody`
 * coerces blank track_title to NULL specifically so that index still dedupes
 * titleless compilation credits submitted through the live write path, and
 * the "zero rows" audit that motivated the drop can't distinguish "never
 * happens" from "this index is preventing it." See the migration file's own
 * comment for the full reasoning; kept pending a follow-up decision.
 *
 * If you rename a column or change a constraint, this test fails — read the
 * assertion before "fixing" it; usually the right fix is the companion
 * migration, not the test.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('schema: compilation_track_artist per-track artist link (migration 0140, BS#1990)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  const entry = journal.entries.find((e) => e.tag.startsWith('0140_'));
  const sqlPath = entry ? path.join(migrationsDir, `${entry.tag}.sql`) : null;
  const sql = sqlPath && fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('journal + migration file', () => {
    it('registers the 0140 migration in the journal', () => {
      expect(entry).toBeDefined();
    });

    it('has a strictly-increasing `when` above 0138', () => {
      const prev = journal.entries.find((e) => e.tag.startsWith('0138_'));
      expect(entry?.when).toBeGreaterThan(prev?.when ?? 0);
    });

    it('adds the three columns as ADD COLUMN (additive only, no data migration)', () => {
      expect(sql).toMatch(/ALTER TABLE "wxyc_schema"\."compilation_track_artist" ADD COLUMN "track_artist_id" integer/);
      expect(sql).toMatch(
        /ALTER TABLE "wxyc_schema"\."compilation_track_artist" ADD COLUMN "track_artist_link_confidence" real/
      );
      expect(sql).toMatch(
        /ALTER TABLE "wxyc_schema"\."compilation_track_artist" ADD COLUMN "track_artist_link_method" text/
      );
    });

    it('adds track_artist_id as a real FK to artists.id with ON DELETE set null', () => {
      expect(sql).toMatch(
        /ADD CONSTRAINT .*FOREIGN KEY \("track_artist_id"\) REFERENCES "wxyc_schema"\."artists"\("id"\) ON DELETE set null/
      );
    });

    it('adds a CHECK constraint on track_artist_link_confidence bounded [0, 1]', () => {
      expect(sql).toMatch(/ADD CONSTRAINT "cta_track_artist_link_confidence_range" CHECK/);
      expect(sql).toMatch(/track_artist_link_confidence.*BETWEEN 0 AND 1/);
    });

    it('does NOT drop cta_unique_null_track_idx — kept pending a follow-up decision (see file header)', () => {
      expect(sql).not.toMatch(/DROP INDEX[^;]*"cta_unique_null_track_idx"/i);
    });

    it('does NOT touch or drop cta_unique_idx — the permanent key per #801 D7', () => {
      expect(sql).not.toMatch(/DROP INDEX[^;]*"cta_unique_idx"/i);
      expect(sql).not.toMatch(/ALTER INDEX[^;]*"cta_unique_idx"/i);
    });

    it('contains no DROP INDEX statement at all', () => {
      expect(sql).not.toMatch(/DROP INDEX/i);
    });

    it('creates a btree index on track_artist_id', () => {
      expect(sql).toMatch(
        /CREATE INDEX "cta_track_artist_id_idx" ON "wxyc_schema"\."compilation_track_artist" USING btree \("track_artist_id"\)/
      );
    });

    it('creates GIN trgm indexes on both artist_name and track_title (D15 — matches the suggest.service.ts query shape)', () => {
      expect(sql).toMatch(
        /CREATE INDEX "cta_artist_name_trgm_idx" ON "wxyc_schema"\."compilation_track_artist" USING gin \("artist_name" gin_trgm_ops\)/
      );
      expect(sql).toMatch(
        /CREATE INDEX "cta_track_title_trgm_idx" ON "wxyc_schema"\."compilation_track_artist" USING gin \("track_title" gin_trgm_ops\)/
      );
    });

    it('documents the no-precondition-needed marker (new nullable column: FK/CHECK are vacuously satisfied by existing all-NULL rows)', () => {
      expect(sql).toMatch(/@no-precondition-needed/);
    });

    it('is DDL-only — no destructive or bulk-data statements', () => {
      expect(sql).not.toMatch(/^\s*DROP TABLE\b/im);
      expect(sql).not.toMatch(/^\s*UPDATE\b/im);
      expect(sql).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    });
  });

  describe('schema.ts declaration', () => {
    const tableDef = extractTableDef('compilation_track_artist');

    it('declares track_artist_id nullable, referencing artists.id with onDelete set null', () => {
      expect(tableDef).toMatch(/track_artist_id:\s*integer\('track_artist_id'\)/);
      expect(tableDef).toMatch(
        /\.references\(\(\)\s*=>\s*artists\.id,\s*\{\s*\n?\s*onDelete:\s*'set null',?\s*\n?\s*\}\)/
      );
    });

    it('declares track_artist_link_confidence as a nullable real column', () => {
      expect(tableDef).toMatch(/track_artist_link_confidence:\s*real\('track_artist_link_confidence'\),/);
    });

    it('declares track_artist_link_method as a nullable text column', () => {
      expect(tableDef).toMatch(/track_artist_link_method:\s*text\('track_artist_link_method'\),/);
    });

    it('declares the confidence CHECK constraint bounded [0, 1]', () => {
      expect(tableDef).toMatch(
        /check\(\s*'cta_track_artist_link_confidence_range',\s*sql`\$\{table\.track_artist_link_confidence\}\s+BETWEEN 0 AND 1`\s*\)/
      );
    });

    it('declares the btree index on track_artist_id', () => {
      expect(tableDef).toMatch(/index\('cta_track_artist_id_idx'\)\.on\(table\.track_artist_id\)/);
    });

    it('declares GIN trgm indexes on artist_name and track_title', () => {
      expect(tableDef).toMatch(
        /index\('cta_artist_name_trgm_idx'\)\.using\(\s*'gin',\s*sql`\$\{table\.artist_name\}\s+gin_trgm_ops`\s*\)/
      );
      expect(tableDef).toMatch(
        /index\('cta_track_title_trgm_idx'\)\.using\(\s*'gin',\s*sql`\$\{table\.track_title\}\s+gin_trgm_ops`\s*\)/
      );
    });

    it('leaves cta_unique_idx unchanged — the permanent key per #801 D7', () => {
      expect(tableDef).toMatch(
        /uniqueIndex\('cta_unique_idx'\)\.on\(table\.library_id,\s*table\.artist_name,\s*table\.track_title\)/
      );
    });

    it('still declares cta_unique_null_track_idx (kept, not dropped — see file header)', () => {
      expect(tableDef).toMatch(/uniqueIndex\('cta_unique_null_track_idx'\)/);
      expect(tableDef).toMatch(/\.on\(table\.library_id,\s*table\.artist_name\)/);
      expect(tableDef).toMatch(/\$\{table\.track_title\}\s+IS\s+NULL/);
    });

    it('exports the select + insert models unchanged', () => {
      expect(schemaSource).toMatch(
        /export type CompilationTrackArtist = InferSelectModel<typeof compilation_track_artist>/
      );
      expect(schemaSource).toMatch(
        /export type NewCompilationTrackArtist = InferInsertModel<typeof compilation_track_artist>/
      );
    });
  });
});
