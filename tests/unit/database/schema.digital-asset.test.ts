/**
 * Schema-source assertions for the digital-asset manifest substrate (BS#2318,
 * epic WXYC/wxyc-dj-ios#135): `digital_asset_store`, `digital_asset`,
 * `digital_asset_file`, `catalog_export_flag_state` (migration 0158), and the
 * `digital_asset` watermark trigger + callable wrapper (migration 0159).
 *
 * Pure file-reading guard, mirroring `schema.library-watermark.test.ts` and
 * `schema.concerts.test.ts` — it cannot run plpgsql, so it locks the
 * source-level properties a green integration run alone wouldn't protect
 * against regression: the trigger's narrowed event list, and the wrapper's
 * exact reuse of 0104's monotonic watermark formula.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
  fs.readFileSync(journalPath, 'utf-8')
);

const tablesEntry = journal.entries.find((e) => e.tag.startsWith('0158_'));
if (!tablesEntry) {
  throw new Error('No journal entry matches /^0158_/. Did the digital-asset-manifest migration land?');
}
const tablesMigrationPath = path.join(migrationsDir, `${tablesEntry.tag}.sql`);
const tablesSql = fs.readFileSync(tablesMigrationPath, 'utf-8');

const watermarkEntry = journal.entries.find((e) => e.tag.startsWith('0159_'));
if (!watermarkEntry) {
  throw new Error('No journal entry matches /^0159_/. Did the digital-asset-watermark migration land?');
}
const watermarkMigrationPath = path.join(migrationsDir, `${watermarkEntry.tag}.sql`);
const watermarkSql = fs.readFileSync(watermarkMigrationPath, 'utf-8');

// Strip both full-line and inline `--` comments so header prose can't
// false-match the DDL assertions below. No DDL string literal in either
// migration contains `--`.
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');

const tablesDdl = stripComments(tablesSql);
const watermarkDdl = stripComments(watermarkSql);

const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

const extractTableDef = (tableName: string): string => {
  const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
  const match = schemaSource.match(regex);
  if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
  return match[0];
};

describe('schema: digital-asset manifest tables (migration 0158, BS#2318)', () => {
  it('migration 0158 exists at the journal-pointed path', () => {
    expect(fs.existsSync(tablesMigrationPath)).toBe(true);
  });

  it('creates digital_asset_store with a unique name', () => {
    expect(tablesDdl).toMatch(/CREATE\s+TABLE\s+"wxyc_schema"\."digital_asset_store"/i);
    expect(tablesDdl).toMatch(/"name"\s+text\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+"digital_asset_store_name_idx"[\s\S]*?\("name"\)/i);
  });

  it('creates digital_asset with the library_id FK, status/provenance defaults, and nullable rip-evidence columns', () => {
    expect(tablesDdl).toMatch(/CREATE\s+TABLE\s+"wxyc_schema"\."digital_asset"\s*\(/i);
    expect(tablesDdl).toMatch(/"library_id"\s+integer\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/"provenance"\s+text\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/"disc_number"\s+smallint\s+DEFAULT\s+1\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/"status"\s+text\s+DEFAULT\s+'needs_review'\s+NOT\s+NULL/i);
    // Rip-evidence columns are ALL nullable — no NOT NULL on any of them.
    for (const col of [
      'verification_method',
      'accuraterip_confidence',
      'c2_error_count',
      'has_htoa',
      'hdcd',
      'pre_emphasis',
      'has_data_session',
      'has_subchannel',
      'identity_qc_flag',
      'rip_log_key',
      'cue_sheet_key',
      'toc_key',
      'data_session_key',
      'album_gain_db',
      'ripped_at',
    ]) {
      const line = tablesDdl.match(new RegExp(`"${col}"[^\\n]*`, 'i'));
      expect(line?.[0]).toBeDefined();
      expect(line?.[0]).not.toMatch(/NOT\s+NULL/i);
    }
    expect(tablesDdl).toMatch(
      /ALTER TABLE "wxyc_schema"\."digital_asset" ADD CONSTRAINT "digital_asset_library_id_library_id_fk" FOREIGN KEY \("library_id"\) REFERENCES "wxyc_schema"\."library"\("id"\)/i
    );
    expect(tablesDdl).toMatch(
      /ALTER TABLE "wxyc_schema"\."digital_asset" ADD CONSTRAINT "digital_asset_ripped_by_auth_user_id_fk" FOREIGN KEY \("ripped_by"\) REFERENCES "public"\."auth_user"\("id"\)/i
    );
  });

  it('declares (library_id, provenance, disc_number) UNIQUE on digital_asset', () => {
    expect(tablesDdl).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+"digital_asset_library_provenance_disc_idx"[\s\S]*?\("library_id","provenance","disc_number"\)/i
    );
  });

  it('declares the (library_id, status) index on digital_asset', () => {
    expect(tablesDdl).toMatch(/CREATE\s+INDEX\s+"digital_asset_library_status_idx"[\s\S]*?\("library_id","status"\)/i);
    // Must not be a unique index — this one is a plain lookup index.
    expect(tablesDdl).not.toMatch(/CREATE\s+UNIQUE\s+INDEX\s+"digital_asset_library_status_idx"/i);
  });

  it('creates digital_asset_file with asset_id ON DELETE CASCADE and a unique (store_id, object_key)', () => {
    expect(tablesDdl).toMatch(/CREATE\s+TABLE\s+"wxyc_schema"\."digital_asset_file"\s*\(/i);
    expect(tablesDdl).toMatch(
      /ALTER TABLE "wxyc_schema"\."digital_asset_file" ADD CONSTRAINT "digital_asset_file_asset_id_digital_asset_id_fk" FOREIGN KEY \("asset_id"\) REFERENCES "wxyc_schema"\."digital_asset"\("id"\) ON DELETE cascade/i
    );
    expect(tablesDdl).toMatch(
      /ALTER TABLE "wxyc_schema"\."digital_asset_file" ADD CONSTRAINT "digital_asset_file_store_id_digital_asset_store_id_fk" FOREIGN KEY \("store_id"\) REFERENCES "wxyc_schema"\."digital_asset_store"\("id"\)/i
    );
    expect(tablesDdl).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+"digital_asset_file_store_object_key_idx"[\s\S]*?\("store_id","object_key"\)/i
    );
    expect(tablesDdl).toMatch(/"bytes"\s+bigint\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/"md5"\s+char\(32\)/i);
    expect(tablesDdl).toMatch(/"sha256"\s+char\(64\)/i);
    expect(tablesDdl).toMatch(/"flac_md5"\s+char\(32\)/i);
  });

  it('creates catalog_export_flag_state keyed on name', () => {
    expect(tablesDdl).toMatch(/CREATE\s+TABLE\s+"wxyc_schema"\."catalog_export_flag_state"\s*\(/i);
    expect(tablesDdl).toMatch(/"name"\s+text\s+PRIMARY\s+KEY\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/"value"\s+text\s+NOT\s+NULL/i);
    expect(tablesDdl).toMatch(/"changed_at"\s+timestamp with time zone\s+DEFAULT\s+now\(\)\s+NOT\s+NULL/i);
  });

  it('schema.ts declares all four tables under wxyc_schema', () => {
    for (const table of ['digital_asset_store', 'digital_asset', 'digital_asset_file', 'catalog_export_flag_state']) {
      expect(schemaSource).toMatch(new RegExp(`export const ${table}\\s*=\\s*wxyc_schema\\.table`));
    }
  });

  it('schema.ts digital_asset_file has no ON DELETE clause specified for store_id (default RESTRICT, not the asset_id CASCADE)', () => {
    const def = extractTableDef('digital_asset_file');
    const storeIdBlock = def.match(/store_id:[\s\S]*?references\(\(\)\s*=>\s*digital_asset_store\.id[^)]*\)/);
    expect(storeIdBlock?.[0]).toBeDefined();
    expect(storeIdBlock?.[0]).not.toMatch(/onDelete/);
  });
});

describe('schema: digital_asset watermark trigger + wrapper (migration 0159, BS#2318)', () => {
  it('migration 0159 exists at the journal-pointed path', () => {
    expect(fs.existsSync(watermarkMigrationPath)).toBe(true);
  });

  it('drops the trigger before recreating it (idempotent re-apply)', () => {
    expect(watermarkDdl).toMatch(
      /DROP\s+TRIGGER\s+IF\s+EXISTS\s+touch_library_watermark\s+ON\s+wxyc_schema\.digital_asset/i
    );
  });

  it('narrows the UPDATE event to status, library_id and keeps INSERT/DELETE/TRUNCATE unqualified', () => {
    expect(watermarkDdl).toMatch(
      /AFTER\s+INSERT\s+OR\s+UPDATE\s+OF\s+status,\s*library_id\s+OR\s+DELETE\s+OR\s+TRUNCATE\s+ON\s+wxyc_schema\.digital_asset/i
    );
  });

  it('is a statement-level trigger reusing the existing touch_library_watermark() function', () => {
    expect(watermarkDdl).toMatch(/FOR\s+EACH\s+STATEMENT/i);
    expect(watermarkDdl).not.toMatch(/FOR\s+EACH\s+ROW/i);
    expect(watermarkDdl).toMatch(/EXECUTE\s+FUNCTION\s+wxyc_schema\.touch_library_watermark\(\)/i);
    // Must NOT redefine the trigger function — only 0104 (and 0142's
    // narrowing) may CREATE OR REPLACE FUNCTION touch_library_watermark().
    expect(watermarkDdl).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+wxyc_schema\.touch_library_watermark\(\)/i);
  });

  it('declares touch_library_watermark_now() RETURNS void', () => {
    expect(watermarkDdl).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+wxyc_schema\.touch_library_watermark_now\(\)\s+RETURNS\s+void/i
    );
  });

  it('reproduces the 0104 monotonic formula exactly: GREATEST(now(), last_modified_at), not a bare now()', () => {
    expect(watermarkDdl).toMatch(/last_modified_at\s*=\s*GREATEST\(\s*now\(\)\s*,\s*last_modified_at\s*\)/i);
    // The single most important negative assertion in this file: a bare
    // `now()` (or an `updated_at` column name) would reintroduce the #1106
    // drift the GREATEST formula exists to prevent.
    expect(watermarkDdl).not.toMatch(/SET\s+last_modified_at\s*=\s*now\(\)/i);
    expect(watermarkDdl).not.toMatch(/updated_at\s*=/i);
  });

  it('writes against the singleton row via WHERE id = true', () => {
    expect(watermarkDdl).toMatch(/UPDATE\s+wxyc_schema\.library_watermark[\s\S]*?WHERE\s+id\s*=\s*true/i);
  });
});
