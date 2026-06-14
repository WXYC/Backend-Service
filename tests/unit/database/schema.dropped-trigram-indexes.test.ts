import * as fs from 'fs';
import * as path from 'path';

/**
 * Drift-prevention guard for BS#1129.
 *
 * Migrations 0054 + 0065 dropped three GIN trigram indexes
 * (`auth_user_dj_name_trgm_idx`, `auth_user_name_trgm_idx`,
 * `shows_legacy_dj_name_trgm_idx`) because search no longer joins through
 * `auth_user` or `shows` for dj-name lookup — reads come from
 * `flowsheet.dj_name` + `flowsheet_dj_name_trgm_idx`.
 *
 * `schema.ts` continued to declare them, so drizzle-kit's snapshot kept the
 * entries forward and any fresh dev/test DB would recreate the dead-weight
 * indexes. 0094 catch-up drops them with `IF EXISTS`; this test pins the
 * schema-side fix so a future edit can't reintroduce the drift.
 */
describe('schema: dropped trigram indexes (BS#1129)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const droppedIndexes = ['auth_user_dj_name_trgm_idx', 'auth_user_name_trgm_idx', 'shows_legacy_dj_name_trgm_idx'];

  it.each(droppedIndexes)('schema.ts does not declare %s', (indexName) => {
    expect(schemaSource).not.toMatch(new RegExp(`index\\(['"]${indexName}['"]\\)`));
  });

  it('latest snapshot does not carry the dropped indexes forward', () => {
    const metaDir = path.resolve(__dirname, '../../../shared/database/src/migrations/meta');
    const snapshots = fs
      .readdirSync(metaDir)
      .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
      .sort();
    const latest = snapshots[snapshots.length - 1];
    expect(latest).toBeDefined();
    const snapshotSource = fs.readFileSync(path.join(metaDir, latest), 'utf-8');
    for (const indexName of droppedIndexes) {
      expect(snapshotSource).not.toContain(indexName);
    }
  });
});
