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
  // Post-#1131 the migration is matched by tag prefix, not idx. The
  // duplicate-idx-47 fix shifted every idx >= 48 by +1; tags (and so
  // .sql filenames) are stable, so prefix-matching survives the
  // renumber.
  const entry91 = journal.entries.find((e) => e.tag.startsWith('0091_'));
  const sqlPath91 = entry91 ? path.join(migrationsDir, `${entry91.tag}.sql`) : null;
  const sql91 = sqlPath91 && fs.existsSync(sqlPath91) ? fs.readFileSync(sqlPath91, 'utf-8') : '';

  const entry93 = journal.entries.find((e) => e.tag.startsWith('0093_'));
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

    it('has the source-tagged identity columns (source_id is text post-0112 — triangle-shows venue-qualified keys reach ~1165 chars)', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(/source:\s*concertSourceEnum\(['"]source['"]/);
      expect(def).toMatch(/source_id:\s*text\(['"]source_id['"]/);
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

    it('declares the (venue_id, starts_at) index for "what is playing at X this week?" queries (timed rows only post-0112 — date-only rows window on starts_on)', () => {
      const def = extractTableDef('concerts');
      expect(def).toMatch(
        /index\(['"]concerts_venue_starts_at_idx['"]\)[\s\S]*?\.on\(table\.venue_id,\s*table\.starts_at\)/
      );
    });

    it('declares the (headlining_artist_id, starts_at) index for "next tour date for artist Y?" queries (timed rows only post-0112 — date-only rows window on starts_on)', () => {
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

  // Migration 0112 (BS#1589): triangle-shows substrate. starts_on is the
  // NOT NULL venue-local windowing column; starts_at goes nullable
  // (date-only events, no fabricated times); promoted columns are all
  // nullable so existing rhp_scrape rows are untouched.
  describe('concerts table — 0112 triangle-shows substrate (BS#1589)', () => {
    const def = () => extractTableDef('concerts');

    it('declares starts_on as a NOT NULL date (the windowing column)', () => {
      expect(def()).toMatch(/starts_on:\s*date\(['"]starts_on['"]\)\.notNull\(\)/);
    });

    it('declares starts_at as a NULLABLE timestamptz (date-only events carry no time)', () => {
      const column = def().match(/starts_at:\s*timestamp\([^)]*\)[^,]*/);
      expect(column?.[0]).toBeDefined();
      expect(column?.[0]).toMatch(/withTimezone:\s*true/);
      expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
    });

    it('has the promoted columns, all nullable', () => {
      const d = def();
      expect(d).toMatch(/title:\s*text\(['"]title['"]\)/);
      expect(d).toMatch(/doors_at:\s*timestamp\(['"]doors_at['"]/);
      expect(d).toMatch(/price_min:\s*numeric\(['"]price_min['"],\s*\{\s*precision:\s*8,\s*scale:\s*2\s*\}\)/);
      expect(d).toMatch(/price_max:\s*numeric\(['"]price_max['"],\s*\{\s*precision:\s*8,\s*scale:\s*2\s*\}\)/);
      expect(d).toMatch(/age_restriction:\s*varchar\(['"]age_restriction['"],\s*\{\s*length:\s*50\s*\}\)/);
      expect(d).toMatch(/removed_at:\s*timestamp\(['"]removed_at['"]/);
      // Paren-bounded extraction (the idiom the first_scraped_at pin above
      // uses): `X: builder([...])<chain-until-comma-or-newline>`. A naive
      // `[^,\n]*` from the column name stops at the comma INSIDE the
      // builder call and never sees a chained .notNull() — which is the
      // exact thing this test exists to catch.
      for (const promoted of ['title', 'doors_at', 'price_min', 'price_max', 'age_restriction', 'removed_at']) {
        const column = d.match(new RegExp(`${promoted}:\\s*\\w+\\([^)]*\\)[^,\\n]*`));
        expect(column?.[0]).toBeDefined();
        expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
      }
    });

    it('declares the concerts_derive_starts_on trigger in 0112 (DB owns the starts_on <-> starts_at invariant)', () => {
      const sql112 = fs.readFileSync(
        path.join(
          migrationsDir,
          `${journal.entries.find((e) => e.tag.startsWith('0112_'))?.tag ?? '0112-missing'}.sql`
        ),
        'utf-8'
      );
      expect(sql112).toMatch(/CREATE OR REPLACE FUNCTION wxyc_schema\.concerts_derive_starts_on\(\)/);
      expect(sql112).toMatch(
        /CREATE TRIGGER concerts_derive_starts_on\s*\nBEFORE INSERT OR UPDATE ON wxyc_schema\.concerts/
      );
      // The NULL guard is what preserves date-only rows' writer-supplied
      // starts_on; without it the trigger would null-out their windowing.
      expect(sql112).toMatch(/IF NEW\.starts_at IS NOT NULL THEN/);
    });

    it('declares the starts_on-first curated-feed partial index (resolver-stamped, not tombstoned)', () => {
      // Predicate widened by migration 0116 (BS#1614), then again by
      // migration 0129 (BS#1762): three resolution lanes (catalog FK,
      // Discogs artist id, or a resolved support act) count as curated.
      // Must stay an exact twin of buildWhere's curated branch in
      // concerts.service.ts.
      expect(def()).toMatch(
        /index\(['"]concerts_curated_starts_on_idx['"]\)[\s\S]*?\.on\(table\.starts_on\)[\s\S]*?\.where\([\s\S]*?sql`[\s\S]*?\([\s\S]*?headlining_artist_id[\s\S]*?IS NOT NULL OR [\s\S]*?headlining_discogs_artist_id[\s\S]*?IS NOT NULL OR [\s\S]*?has_resolved_support[\s\S]*?\)[\s\S]*?removed_at[\s\S]*?IS NULL/
      );
    });

    it('migration 0129 drops and recreates the index in-transaction (non-CONCURRENTLY) with the three-term predicate', () => {
      // Drizzle wraps every migration in a transaction, and
      // CREATE INDEX CONCURRENTLY cannot run inside one — mirrors the same
      // constraint migration 0116 documents for this same index.
      const entry129 = journal.entries.find((e) => e.tag.startsWith('0129_'));
      const sqlPath129 = entry129 ? path.join(migrationsDir, `${entry129.tag}.sql`) : null;
      const sql129 = sqlPath129 && fs.existsSync(sqlPath129) ? fs.readFileSync(sqlPath129, 'utf-8') : '';

      expect(entry129).toBeDefined();
      expect(sql129).toMatch(/DROP INDEX IF EXISTS "wxyc_schema"\."concerts_curated_starts_on_idx"/);
      expect(sql129).toMatch(
        /CREATE INDEX IF NOT EXISTS "concerts_curated_starts_on_idx" ON "wxyc_schema"\."concerts"/
      );
      expect(sql129).toMatch(
        /WHERE \("wxyc_schema"\."concerts"\."headlining_artist_id" IS NOT NULL OR "wxyc_schema"\."concerts"\."headlining_discogs_artist_id" IS NOT NULL OR "wxyc_schema"\."concerts"\."has_resolved_support"\) AND "wxyc_schema"\."concerts"\."removed_at" IS NULL/
      );

      // The load-bearing negative: the DDL itself must never say
      // CONCURRENTLY outside of the commented ops-runbook example, or the
      // migration fails at apply inside Drizzle's transaction wrapper and
      // wedges the deploy.
      const ddlOnly = sql129
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(ddlOnly).not.toMatch(/CONCURRENTLY/);
    });
  });

  describe('migration 0112 (triangle-shows substrate, BS#1589)', () => {
    const entry112 = journal.entries.find((e) => e.tag.startsWith('0112_'));
    const sqlPath112 = entry112 ? path.join(migrationsDir, `${entry112.tag}.sql`) : null;
    const sql112 = sqlPath112 && fs.existsSync(sqlPath112) ? fs.readFileSync(sqlPath112, 'utf-8') : '';

    it('exists in the journal', () => {
      expect(entry112).toBeDefined();
      expect(entry112?.tag).toMatch(/^0112_triangle-shows-concerts$/);
    });

    it('adds the triangle_shows enum value and widens source_id to text', () => {
      expect(sql112).toMatch(/ALTER TYPE "wxyc_schema"\."concert_source_enum" ADD VALUE 'triangle_shows'/);
      expect(sql112).toMatch(/ALTER COLUMN "source_id" SET DATA TYPE text/);
    });

    it('backfills starts_on before SET NOT NULL and pairs the UPDATE with an ANALYZE', () => {
      // Scan DDL lines only for EVERY position probe — the migration's
      // comment header quotes 'ADD COLUMN "starts_on" date NOT NULL' when
      // explaining the hand-split, so an indexOf against the raw file
      // would anchor on the comment and make the ordering pin vacuous.
      const ddlOnly = sql112
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      // Order matters: add nullable -> backfill -> SET NOT NULL. A plain
      // `ADD COLUMN starts_on date NOT NULL` cannot apply to a non-empty
      // table, which is exactly the deploy-wedge this pin guards against.
      const addIdx = ddlOnly.indexOf('ADD COLUMN "starts_on" date');
      const backfillIdx = ddlOnly.indexOf('SET "starts_on" =');
      const notNullIdx = ddlOnly.indexOf('ALTER COLUMN "starts_on" SET NOT NULL');
      expect(addIdx).toBeGreaterThan(-1);
      expect(backfillIdx).toBeGreaterThan(addIdx);
      expect(notNullIdx).toBeGreaterThan(backfillIdx);
      expect(ddlOnly).not.toMatch(/ADD COLUMN "starts_on" date NOT NULL/);
      expect(ddlOnly).toMatch(/AT TIME ZONE 'America\/New_York'/);
      expect(ddlOnly).toMatch(/ANALYZE "wxyc_schema"\."concerts"/);
    });

    it('drops NOT NULL on starts_at (never drops rows — first_scraped_at anchors #1373)', () => {
      expect(sql112).toMatch(/ALTER COLUMN "starts_at" DROP NOT NULL/);
      expect(sql112).not.toMatch(/DELETE FROM/i);
    });
  });

  // Migration 0115 (BS#1609): event_url is the venue's own event-detail
  // page, additive + nullable so existing rows are untouched. Both scrapers
  // refill it on their nightly UPSERT; rows with no known page stay NULL.
  describe('concerts.event_url (migration 0115, BS#1609)', () => {
    const def = () => extractTableDef('concerts');
    const entry115 = journal.entries.find((e) => e.tag.startsWith('0115_'));
    const sqlPath115 = entry115 ? path.join(migrationsDir, `${entry115.tag}.sql`) : null;
    const sql115 = sqlPath115 && fs.existsSync(sqlPath115) ? fs.readFileSync(sqlPath115, 'utf-8') : '';

    it('declares event_url as a nullable text column', () => {
      const d = def();
      expect(d).toMatch(/event_url:\s*text\(['"]event_url['"]\)/);
      const column = d.match(/event_url:\s*\w+\([^)]*\)[^,\n]*/);
      expect(column?.[0]).toBeDefined();
      expect(column?.[0]).not.toMatch(/\.notNull\(\)/);
    });

    it('is added by migration 0115 (additive ADD COLUMN, no NOT NULL)', () => {
      expect(entry115).toBeDefined();
      expect(sql115).toMatch(/ALTER TABLE "wxyc_schema"\."concerts" ADD COLUMN "event_url" text/);
      expect(sql115).not.toMatch(/event_url"\s+text\s+NOT NULL/);
    });
  });

  describe('enums', () => {
    it('declares concert_source_enum with rhp_scrape and triangle_shows (0112)', () => {
      expect(schemaSource).toMatch(/concertSourceEnum\s*=\s*wxyc_schema\.enum\(['"]concert_source_enum['"]/);
      expect(schemaSource).toMatch(/['"]rhp_scrape['"]/);
      expect(schemaSource).toMatch(/['"]triangle_shows['"]/);
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
