/**
 * Data backfill migration 0165 (BS#2477) — files every active, uncarded
 * `rotation` row under card 1 of its bin, creating that card first if the
 * bin doesn't have one yet.
 *
 * These tests execute the REAL INSERT and UPDATE statements extracted from
 * `shared/database/src/migrations/0165_rotation-card-backfill.sql` against a
 * throwaway schema, so there is zero drift between the artifact this spec
 * pins and what actually runs at deploy time. The throwaway tables reuse the
 * real `public.freq_enum` type (its own schema is irrelevant to the
 * predicate under test) so the extracted SQL needs no rewriting beyond the
 * `wxyc_schema.` prefix swap — same technique as
 * `relabel-rotation-direct-backfill.spec.js`.
 *
 * By the time this spec runs, the real 0165 has already applied once against
 * an empty `rotation` table at db-init (the shape fixture loads afterward),
 * so it already created `wxyc_schema.rotation_cards`' four real card-1 rows
 * and touched zero real `rotation` rows. This suite is what actually
 * exercises the UPDATE's row-selection logic and both statements'
 * idempotency, per the issue's acceptance criteria.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

const TEST_SCHEMA = 'rotation_card_backfill_test';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'shared',
  'database',
  'src',
  'migrations',
  '0165_rotation-card-backfill.sql'
);

/**
 * Pull the INSERT (card-1-per-bin) and UPDATE (file-active-rows) statements
 * out of the migration file and retarget them at the throwaway schema.
 * Strips full-line and trailing `--` comments first (no `--` occurs inside a
 * string literal or the ANALYZE tail, so this is safe here — same caveat as
 * the relabel spec this pattern is borrowed from). Requires exactly one of
 * each so a future edit to the migration can't silently drift from what
 * this spec validates.
 */
function extractBackfillStatements(scriptText, targetSchema) {
  const sqlOnly = scriptText
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('--');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');

  const inserts = sqlOnly.match(/INSERT[\s\S]*?;/gi) ?? [];
  const updates = sqlOnly.match(/UPDATE[\s\S]*?;/gi) ?? [];
  if (inserts.length !== 1) {
    throw new Error(`expected exactly one INSERT in 0165_rotation-card-backfill.sql, found ${inserts.length}`);
  }
  if (updates.length !== 1) {
    throw new Error(`expected exactly one UPDATE in 0165_rotation-card-backfill.sql, found ${updates.length}`);
  }

  const retarget = (stmt) => stmt.replace(/"wxyc_schema"\./g, `"${targetSchema}".`);
  return { insertCard1: retarget(inserts[0]), updateActiveRows: retarget(updates[0]) };
}

describe('rotation card backfill (BS#2477)', () => {
  let sql;
  let insertCard1;
  let updateActiveRows;

  beforeAll(async () => {
    sql = getTestDb();
    const scriptText = fs.readFileSync(MIGRATION_PATH, 'utf8');
    ({ insertCard1, updateActiveRows } = extractBackfillStatements(scriptText, TEST_SCHEMA));

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".rotation_cards (
        id serial PRIMARY KEY,
        bin "public"."freq_enum" NOT NULL,
        number integer NOT NULL,
        name text,
        UNIQUE (bin, number)
      )
    `);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".rotation (
        id serial PRIMARY KEY,
        rotation_bin "public"."freq_enum" NOT NULL,
        kill_date date,
        card_id integer REFERENCES "${TEST_SCHEMA}".rotation_cards(id) ON DELETE SET NULL
      )
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE "${TEST_SCHEMA}".rotation, "${TEST_SCHEMA}".rotation_cards RESTART IDENTITY CASCADE`);
  });

  async function cardsByBin() {
    const rows = await sql.unsafe(`SELECT bin, number, name FROM "${TEST_SCHEMA}".rotation_cards ORDER BY bin, number`);
    return rows;
  }

  test('creates card 1 for every bin when none exist', async () => {
    const result = await sql.unsafe(insertCard1);

    expect(result.count).toBe(4); // freq_enum: S, L, M, H
    const cards = await cardsByBin();
    expect(cards.map((c) => c.bin).sort()).toEqual(['H', 'L', 'M', 'S']);
    expect(cards.every((c) => c.number === 1 && c.name === null)).toBe(true);
  });

  test('leaves a pre-existing card 1 alone rather than duplicating or overwriting it', async () => {
    await sql.unsafe(
      `INSERT INTO "${TEST_SCHEMA}".rotation_cards (bin, number, name) VALUES ('S', 1, 'Existing Card One')`
    );

    const result = await sql.unsafe(insertCard1);

    expect(result.count).toBe(3); // the other three bins, not S
    const cards = await cardsByBin();
    const sCards = cards.filter((c) => c.bin === 'S');
    expect(sCards).toHaveLength(1);
    expect(sCards[0].name).toBe('Existing Card One'); // ON CONFLICT DO NOTHING, never overwritten
  });

  test('re-running the card-1 INSERT after it has already run is a genuine no-op', async () => {
    await sql.unsafe(insertCard1);
    const rerun = await sql.unsafe(insertCard1);

    expect(rerun.count).toBe(0);
    expect(await cardsByBin()).toHaveLength(4);
  });

  describe('filing active rows onto card 1', () => {
    let cardIdByBin;

    beforeEach(async () => {
      await sql.unsafe(insertCard1);
      const cards = await sql.unsafe(`SELECT id, bin FROM "${TEST_SCHEMA}".rotation_cards WHERE number = 1`);
      cardIdByBin = Object.fromEntries(cards.map((c) => [c.bin, c.id]));
    });

    async function insertRotationRow({ bin, killDate = null, cardId = null }) {
      const rows = await sql`
        INSERT INTO ${sql(TEST_SCHEMA)}.rotation (rotation_bin, kill_date, card_id)
        VALUES (${bin}, ${killDate}, ${cardId})
        RETURNING id
      `;
      return rows[0].id;
    }

    async function cardIdOf(rotationId) {
      const rows = await sql`
        SELECT card_id FROM ${sql(TEST_SCHEMA)}.rotation WHERE id = ${rotationId}
      `;
      return rows[0].card_id;
    }

    test("an active row with no kill_date is filed onto its bin's card 1", async () => {
      const id = await insertRotationRow({ bin: 'M' });

      await sql.unsafe(updateActiveRows);

      expect(await cardIdOf(id)).toBe(cardIdByBin.M);
    });

    test('a scheduled-kill row (kill_date in the future) is treated as active', async () => {
      const id = await insertRotationRow({ bin: 'H', killDate: '2999-01-01' });

      await sql.unsafe(updateActiveRows);

      expect(await cardIdOf(id)).toBe(cardIdByBin.H);
    });

    test('a killed row (kill_date in the past) is left uncarded', async () => {
      const id = await insertRotationRow({ bin: 'M', killDate: '2000-01-01' });

      const result = await sql.unsafe(updateActiveRows);

      expect(result.count).toBe(0);
      expect(await cardIdOf(id)).toBeNull();
    });

    test('an already-carded active row is left untouched, even if pointed at a different card', async () => {
      await sql.unsafe(`INSERT INTO "${TEST_SCHEMA}".rotation_cards (bin, number, name) VALUES ('L', 2, 'Card Two')`);
      const otherCard = await sql.unsafe(
        `SELECT id FROM "${TEST_SCHEMA}".rotation_cards WHERE bin = 'L' AND number = 2`
      );
      const id = await insertRotationRow({ bin: 'L', cardId: otherCard[0].id });

      const result = await sql.unsafe(updateActiveRows);

      expect(result.count).toBe(0);
      expect(await cardIdOf(id)).toBe(otherCard[0].id);
    });

    test('re-running the full backfill after it has already run changes zero rows', async () => {
      await insertRotationRow({ bin: 'S' }); // active, uncarded
      await insertRotationRow({ bin: 'H', killDate: '2000-01-01' }); // killed, uncarded

      await sql.unsafe(insertCard1);
      await sql.unsafe(updateActiveRows);

      const rerunInsert = await sql.unsafe(insertCard1);
      const rerunUpdate = await sql.unsafe(updateActiveRows);

      expect(rerunInsert.count).toBe(0);
      expect(rerunUpdate.count).toBe(0);
    });
  });
});
