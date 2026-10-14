/**
 * BS#3139 (tracker BS#3137, decision 7) -- `album_metadata_reask_backup`, the one backup table the album_metadata
 * re-ask writes. The unit tier pins the declared shape; this spec pins the constraint behaviour against a real
 * Postgres:
 *
 *   - `album_metadata_reask_backup_target_table_ck` accepts exactly the three write targets and the `restore` marker,
 *   - `row_id` and `album_id` carry no foreign key, so a backup row can name a row that no longer exists.
 *
 * Every row is removed in `afterEach`, keyed by the probe `run_id`.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const RUN_ID = 'bs3139-schema-probe';
// Far above any id the integration fixture seeds, so no album, library or flowsheet row has it.
const MISSING_ID = 2_000_000_000;

describe('album_metadata_reask_backup (real PG)', () => {
  let sql;

  const insertBackup = (targetTable, rowId = MISSING_ID) => sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata_reask_backup
      (run_id, target_table, row_id, album_id, before_image, after_image, provenance, written_at)
    VALUES (
      ${RUN_ID}, ${targetTable}, ${rowId}, ${MISSING_ID},
      ${sql.json({ label: 'Sonamos' })}, ${sql.json({ label: null })},
      ${sql.json({ reason: 'pin_disagrees', verdict: 'clear' })}, now()
    )
    RETURNING id
  `;

  beforeAll(() => {
    sql = getTestDb();
  });

  afterEach(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata_reask_backup WHERE run_id = ${RUN_ID}`;
  });

  it.each(['album_metadata', 'library', 'flowsheet', 'restore'])(
    'accepts target_table = %s for a row_id and album_id that exist nowhere',
    async (targetTable) => {
      const [row] = await insertBackup(targetTable);
      expect(row.id).toBeDefined();
    }
  );

  it.each(['rotation', 'Album_Metadata', ''])(
    'rejects target_table = %j with a CHECK violation',
    async (targetTable) => {
      await expect(insertBackup(targetTable)).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'album_metadata_reask_backup_target_table_ck',
      });
    }
  );
});
