/**
 * Schema-shape sanity check for the venues + concerts tables (migration
 * 0091). Mirrors the pattern of `schema.artist-search-alias.test.ts`:
 * read the source as text and assert the columns / FKs / indexes are
 * declared as the migration expects.
 *
 * If you rename a column or change a constraint, this test will fail —
 * read the assertion before "fixing" it; usually the right fix is the
 * companion migration, not the test.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('schema: venues + concerts (migration 0091, venue-events-scraper)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  const entry91 = journal.entries.find((e) => e.idx === 91);
  const sqlPath91 = entry91 ? path.join(migrationsDir, `${entry91.tag}.sql`) : null;
  const sql91 = sqlPath91 && fs.existsSync(sqlPath91) ? fs.readFileSync(sqlPath91, 'utf-8') : '';

  const entry93 = journal.entries.find((e) => e.idx === 93);
  const sqlPath93 = entry93 ? path.join(migrationsDir, `${entry93.tag}.sql`) : null;
  const sql93 = sqlPath93 && fs.existsSync(sqlPath93) ? fs.readFileSync(sqlPath93, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('venues table', () => {
    it('is declared as a wxyc_schema table', () => {
      expect(schemaSource).toMatch(/export const venues\s*=\s*wxyc_schema\.table/);
    });

    it('has slug, name, city, state, address columns', () => {
      const def = extractTableDef('venues');
      expect(def).toMatch(/slug:\s*varchar\(['"]slug['"]/);
      expect(def).toMatch(/name:\s*varchar\(['"]name['"]/);
      expect(def).toMatch(/city:\s*varchar\(['"]city['"]/);
      expect(def).toMatch(/state:\s*varchar\(['"]state['"]/);
      expect(def).toMatch(/address:\s*varchar\(['"]address['"]/);
    });

    it('declares a unique index on slug (one row per scraper venue id)', () => {
      const def = extractTableDef('venues');
      expect(def).toMatch(/uniqueIndex\(['"]venues_slug_idx['"]\).on\(table.slug\)/);
    });
  });

  describe('concerts table', () => {
    it('is declared as a wxyc_schema table', () => {
      expect(schemaSource).toMatch(/export const concerts\s*=\s*wxyc_schema\.table/);
    });

    it('has the source-tagged identity columns', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(/source:\s*concertSourceEnum\(['"]source['"]/);
      expect(def).toMatch(/source_id:\s*varchar\(['"]source_id['"]/);
    });

    it('FKs venue_id to venues.id with ON DELETE restrict (concerts live only when their venue does)', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(/venue_id[\s\S]*?\.references\(\(\)\s*=>\s*venues\.id[\s\S]*?onDelete:\s*['"]restrict['"]/);
    });

    it('FKs headlining_artist_id to artists.id as nullable + ON DELETE set null (best-effort LML link)', () => {
      const def = extractTableDef('concerts');
      // The column is declared without .notNull(), so it's nullable.
      expect(def).toMatch(/headlining_artist_id:\s*integer\(['"]headlining_artist_id['"]\)\.references/);
      expect(def).toMatch(
        /headlining_artist_id[\s\S]*?\.references\(\(\)\s*=>\s*artists\.id[\s\S]*?onDelete:\s*['"]set null['"]/
      );
    });

    it('has supporting_artists_raw as a text[] with default empty array', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(/supporting_artists_raw:\s*text\(['"]supporting_artists_raw['"]\)[\s\S]*?\.array\(\)/);
    });

    it('declares the (source, source_id) unique index (the per-source dedup key)', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(
        /uniqueIndex\(['"]concerts_source_source_id_idx['"]\)[\s\S]*?\.on\(table\.source,\s*table\.source_id\)/
      );
    });

    it('declares the (venue_id, starts_at) index for "what is playing at X this week?" queries', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(
        /index\(['"]concerts_venue_starts_at_idx['"]\)[\s\S]*?\.on\(table\.venue_id,\s*table\.starts_at\)/
      );
    });

    it('declares the (headlining_artist_id, starts_at) index for "next tour date for artist Y?" queries', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(
        /index\(['"]concerts_headlining_artist_starts_at_idx['"]\)[\s\S]*?\.on\(table\.headlining_artist_id,\s*table\.starts_at\)/
      );
    });

    it('stores raw_data as jsonb (forensic when source format changes)', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(/raw_data:\s*jsonb\(['"]raw_data['"]/);
    });

    it('declares first_scraped_at as a NOT NULL timestamptz with DEFAULT now() (INSERT-only scraper-stability anchor, BS#1385)', () => {
      const def = extractTableDef('concerts');
      // Pin each fact independently so an equivalent reorder of the
      // chain (e.g. `.notNull().defaultNow()`) doesn't fail the test —
      // the SQL is identical either way. The writer's tests separately
      // pin that the column is omitted from both `values` and the ON
      // CONFLICT `set` clause.
      const column = def.match(/first_scraped_at:\s*timestamp\([^)]*\)[^,]*/);
      expect(column?.[0]).toBeDefined();
      expect(column?.[0]).toMatch(/['"]first_scraped_at['"]/);
      expect(column?.[0]).toMatch(/withTimezone:\s*true/);
      expect(column?.[0]).toMatch(/\.defaultNow\(\)/);
      expect(column?.[0]).toMatch(/\.notNull\(\)/);
    });
  });

  describe('enums', () => {
    it('declares concert_source_enum with rhp_scrape as initial value', () => {
      expect(schemaSource).toMatch(/concertSourceEnum\s*=\s*wxyc_schema\.enum\(['"]concert_source_enum['"]/);
      expect(schemaSource).toMatch(/['"]rhp_scrape['"]/);
    });

    it('declares concert_status_enum with the four lifecycle states', () => {
      expect(schemaSource).toMatch(/concertStatusEnum\s*=\s*wxyc_schema\.enum\(['"]concert_status_enum['"]/);
      for (const v of ['on_sale', 'sold_out', 'cancelled', 'rescheduled']) {
        expect(schemaSource).toMatch(new RegExp(`['"]${v}['"]`));
      }
    });
  });

  describe('migration 0091', () => {
    it('exists in the journal', () => {
      expect(entry91).toBeDefined();
      expect(entry91?.tag).toMatch(/^0091_/);
    });

    it('creates both enums and both tables', () => {
      expect(sql91).toMatch(/CREATE TYPE "wxyc_schema"\."concert_source_enum"/);
      expect(sql91).toMatch(/CREATE TYPE "wxyc_schema"\."concert_status_enum"/);
      expect(sql91).toMatch(/CREATE TABLE "wxyc_schema"\."venues"/);
      expect(sql91).toMatch(/CREATE TABLE "wxyc_schema"\."concerts"/);
    });

    it('carries the precondition-guard opt-out comment so validate-migrations:check-8 stays quiet', () => {
      expect(sql91).toMatch(/precondition-guard:\s*not-required/);
    });
  });

  describe('migration 0093 (concerts.first_scraped_at, BS#1385)', () => {
    it('exists in the journal', () => {
      expect(entry93).toBeDefined();
      expect(entry93?.tag).toMatch(/^0093_concerts-first-scraped-at$/);
    });

    it('adds first_scraped_at to wxyc_schema.concerts as NOT NULL DEFAULT now()', () => {
      expect(sql93).toMatch(/ALTER TABLE "wxyc_schema"\."concerts" ADD COLUMN "first_scraped_at"/);
      expect(sql93).toMatch(/timestamp with time zone\s+DEFAULT now\(\)\s+NOT NULL/);
    });

    it('carries the precondition-guard opt-out comment (ADD COLUMN with non-null DEFAULT is safe by construction)', () => {
      expect(sql93).toMatch(/precondition-guard:\s*not-required/);
    });
  });
});
