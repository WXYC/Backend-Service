import * as fs from 'fs';
import * as path from 'path';

/**
 * Pins `intake_items.digital` (BS#3100, migration 0192) as NOT NULL with a `false` default, in the schema and in the migration that ships it.
 * `IntakeItem.digital` is required and non-nullable in the contract, and every write path gives the column a value (the seeder leaves it to the default, `POST /intake` writes an explicit true or false),
 * so nothing else fails if the column turns nullable. `check:db-mock-sync` compares column names only, and `lint:migrations` passes NOT NULL with a DEFAULT without inspecting either.
 */
describe('schema: intake_items.digital (BS#3100)', () => {
  const schemaSource = fs.readFileSync(path.resolve(__dirname, '../../../shared/database/src/schema.ts'), 'utf-8');
  const migrationSql = fs.readFileSync(
    path.resolve(__dirname, '../../../shared/database/src/migrations/0192_intake-digital.sql'),
    'utf-8'
  );

  const intakeItemsDef = schemaSource.match(/export const intake_items\b[\s\S]*?^\);/m)?.[0];

  it('is declared NOT NULL with a false default', () => {
    expect(intakeItemsDef).toBeDefined();
    expect(intakeItemsDef).toMatch(/\bdigital: boolean\('digital'\)\.notNull\(\)\.default\(false\),/);
  });

  it('is added by migration 0192 as NOT NULL with a false default, so existing rows read as discs', () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE\s+"wxyc_schema"\."intake_items"\s+ADD COLUMN\s+"digital"\s+boolean\s+DEFAULT false NOT NULL\s*;/i
    );
  });
});
