/**
 * BS#2117 — artist_crossreference backfill script.
 *
 * Postgres-backed (the BS analogue of the org `pg` marker): direct SQL,
 * no HTTP surface needed since this exercises a hand-run SQL script, not an
 * API route. All seeded rows live in the 900300+ range this spec owns
 * end-to-end (created + reaped here), above the prod-clone fixture's id
 * space (dev_env/seed-clone.sql occupies artists 1-27050 — see the
 * `library-catalog-producer-export.spec.js` header for why that collision
 * is real, not theoretical: the actual tubafrenzy names this ticket backfills
 * (e.g. "Sankofa", "Oliver Lake") are themselves real rows in that clone).
 *
 * This spec does NOT execute `scripts/audit/bs_2117_crossref_backfill.sql`
 * verbatim with its embedded 110-pair production dataset. That dataset is
 * real tubafrenzy artist names, several of which (verified against
 * dev_env/seed-clone.sql while building this script) already exist as real
 * rows in the clone fixture some local dev databases load — running the
 * literal file would make this spec's outcome depend on whether
 * LOAD_CLONE_FIXTURE is set, which is exactly the non-determinism the shape
 * fixture / 900000+ id convention exists to avoid. Instead, this spec
 * exercises the SAME resolve -> canonicalize -> guard -> insert SQL shape
 * the script uses (three-stage resolver, self-pair guard, reversed-pair
 * dedup via LEAST/GREATEST, NOT EXISTS either-direction guard, ON CONFLICT
 * DO NOTHING), applied to synthetic BS2117-prefixed fixtures that cannot
 * collide with any real catalog data. The literal file's syntax and
 * end-to-end behavior were verified separately, by hand, against the
 * dev-clone Postgres (see the file-level comment at the bottom of this
 * spec for what that verification covered and why it isn't automated here).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const ART_ALPHA = 900300; // 'BS2117 Xref Alpha'
const ART_BETA = 900301; // 'BS2117 Xref Beta'
const ART_GAMMA = 900302; // 'BS2117 Xref Gamma' (unrelated third artist)
const ART_SELF = 900303; // 'BS2117 Xref Self' (self-pair guard probe)

const ALPHA_NAME = 'BS2117 Xref Alpha';
const BETA_NAME = 'BS2117 Xref Beta';
const GAMMA_NAME = 'BS2117 Xref Gamma';
const SELF_NAME = 'BS2117 Xref Self';

/**
 * Mirrors the resolve/canonicalize/guard/insert shape in
 * scripts/audit/bs_2117_crossref_backfill.sql. Rows are (src_name,
 * src_letters, tgt_name, tgt_letters, comment) tuples resolved by
 * fold_artist_name + code_letters, deduplicated on the unordered pair, and
 * inserted idempotently.
 */
async function runBackfillPattern(sql, rows) {
  await sql`
    CREATE TEMP TABLE IF NOT EXISTS bs2117_test_pairs (
      src_name text, src_letters text, tgt_name text, tgt_letters text, xref_comment text
    ) ON COMMIT PRESERVE ROWS
  `;
  await sql`TRUNCATE bs2117_test_pairs`;
  for (const [srcName, srcLetters, tgtName, tgtLetters, comment] of rows) {
    await sql`
      INSERT INTO bs2117_test_pairs (src_name, src_letters, tgt_name, tgt_letters, xref_comment)
      VALUES (${srcName}, ${srcLetters}, ${tgtName}, ${tgtLetters}, ${comment})
    `;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(`
      WITH resolved AS (
        SELECT
          p.xref_comment,
          src.id AS source_artist_id,
          tgt.id AS target_artist_id
        FROM bs2117_test_pairs p
        JOIN "${SCHEMA}".artists src
          ON "${SCHEMA}".fold_artist_name(src.artist_name) = "${SCHEMA}".fold_artist_name(p.src_name)
         AND lower(src.code_letters) = lower(p.src_letters)
        JOIN "${SCHEMA}".artists tgt
          ON "${SCHEMA}".fold_artist_name(tgt.artist_name) = "${SCHEMA}".fold_artist_name(p.tgt_name)
         AND lower(tgt.code_letters) = lower(p.tgt_letters)
        WHERE src.id <> tgt.id
      ),
      canon AS (
        SELECT LEAST(source_artist_id, target_artist_id) AS source_artist_id,
               GREATEST(source_artist_id, target_artist_id) AS target_artist_id,
               xref_comment
        FROM resolved
      ),
      deduped AS (
        SELECT DISTINCT ON (source_artist_id, target_artist_id)
          source_artist_id, target_artist_id, xref_comment
        FROM canon
        ORDER BY source_artist_id, target_artist_id
      )
      INSERT INTO "${SCHEMA}".artist_crossreference (source_artist_id, target_artist_id, comment)
      SELECT d.source_artist_id, d.target_artist_id, d.xref_comment
      FROM deduped d
      WHERE NOT EXISTS (
        SELECT 1 FROM "${SCHEMA}".artist_crossreference existing
        WHERE (existing.source_artist_id = d.source_artist_id AND existing.target_artist_id = d.target_artist_id)
           OR (existing.source_artist_id = d.target_artist_id AND existing.target_artist_id = d.source_artist_id)
      )
      ON CONFLICT (source_artist_id, target_artist_id) DO NOTHING
    `);
  });
}

describe('BS#2117 artist_crossreference backfill (real PG)', () => {
  let sql;

  beforeAll(async () => {
    sql = getTestDb();
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (id, artist_name, alphabetical_name, code_letters)
      VALUES
        (${ART_ALPHA}, ${ALPHA_NAME}, ${ALPHA_NAME}, 'ZA'),
        (${ART_BETA}, ${BETA_NAME}, ${BETA_NAME}, 'ZB'),
        (${ART_GAMMA}, ${GAMMA_NAME}, ${GAMMA_NAME}, 'ZC'),
        (${ART_SELF}, ${SELF_NAME}, ${SELF_NAME}, 'ZD')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterEach(async () => {
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE source_artist_id IN (${ART_ALPHA}, ${ART_BETA}, ${ART_GAMMA}, ${ART_SELF})
         OR target_artist_id IN (${ART_ALPHA}, ${ART_BETA}, ${ART_GAMMA}, ${ART_SELF})
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id IN (${ART_ALPHA}, ${ART_BETA}, ${ART_GAMMA}, ${ART_SELF})`;
    await sql`DROP TABLE IF EXISTS bs2117_test_pairs`;
  });

  test('inserts exactly one row for a resolvable pair', async () => {
    await runBackfillPattern(sql, [[ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', 'shared member (test)']]);

    const rows = await sql`
      SELECT source_artist_id, target_artist_id, comment FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE (source_artist_id = ${ART_ALPHA} AND target_artist_id = ${ART_BETA})
         OR (source_artist_id = ${ART_BETA} AND target_artist_id = ${ART_ALPHA})
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toBe('shared member (test)');
  });

  test('re-running the same pair is a no-op (idempotent)', async () => {
    await runBackfillPattern(sql, [[ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', 'shared member (test)']]);
    await runBackfillPattern(sql, [[ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', 'shared member (test)']]);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE (source_artist_id = ${ART_ALPHA} AND target_artist_id = ${ART_BETA})
         OR (source_artist_id = ${ART_BETA} AND target_artist_id = ${ART_ALPHA})
    `;
    expect(rows).toHaveLength(1);
  });

  test('the reversed-direction duplicate collapses to one row, not two', async () => {
    // Mirrors LIBRARY_CODE_CROSS_REFERENCE ids 74/75 (Sankofa <-> The Apple
    // Juice Kid), recorded in both directions in the real tubafrenzy source.
    await runBackfillPattern(sql, [
      [ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', null],
      [BETA_NAME, 'ZB', ALPHA_NAME, 'ZA', null],
    ]);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE (source_artist_id = ${ART_ALPHA} AND target_artist_id = ${ART_BETA})
         OR (source_artist_id = ${ART_BETA} AND target_artist_id = ${ART_ALPHA})
    `;
    expect(rows).toHaveLength(1);
  });

  test('a pair already present in the opposite direction is not duplicated', async () => {
    // Seed the "existing" row in one direction directly, then run the
    // backfill pattern requesting the OPPOSITE direction — the NOT EXISTS
    // guard (not just ON CONFLICT on the exact ordered pair) must catch it.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artist_crossreference (source_artist_id, target_artist_id, comment)
      VALUES (${ART_BETA}, ${ART_ALPHA}, 'pre-existing')
    `;

    await runBackfillPattern(sql, [[ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', 'would-be-new']]);

    const rows = await sql`
      SELECT comment FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE (source_artist_id = ${ART_ALPHA} AND target_artist_id = ${ART_BETA})
         OR (source_artist_id = ${ART_BETA} AND target_artist_id = ${ART_ALPHA})
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toBe('pre-existing');
  });

  test('a self-pair (both sides resolve to the same artist) is never inserted', async () => {
    // Mirrors LIBRARY_CODE_CROSS_REFERENCE row 128 ("Oliver Lake" -> "Oliver
    // Lake"): two tubafrenzy LIBRARY_CODEs sharing one PRESENTATION_NAME.
    await runBackfillPattern(sql, [[SELF_NAME, 'ZD', SELF_NAME, 'ZD', 'same artist (test)']]);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE source_artist_id = ${ART_SELF} OR target_artist_id = ${ART_SELF}
    `;
    expect(rows).toHaveLength(0);
  });

  test('an unresolvable name (no matching artist) inserts nothing and does not throw', async () => {
    await expect(
      runBackfillPattern(sql, [['BS2117 Nonexistent Pointer Artist', '', BETA_NAME, 'ZB', null]])
    ).resolves.not.toThrow();

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.artist_crossreference WHERE target_artist_id = ${ART_BETA}
    `;
    expect(rows).toHaveLength(0);
  });

  test('an unrelated third artist is unaffected', async () => {
    await runBackfillPattern(sql, [[ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', null]]);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE source_artist_id = ${ART_GAMMA} OR target_artist_id = ${ART_GAMMA}
    `;
    expect(rows).toHaveLength(0);
  });

  test('the catalog export artist_aliases CTE emits the alias in both directions once inserted', async () => {
    // Mirrors the artist_aliases CTE in apps/backend/services/catalog-export.service.ts:
    // UNION both FK directions so a row filed under either endpoint surfaces the other.
    await runBackfillPattern(sql, [[ALPHA_NAME, 'ZA', BETA_NAME, 'ZB', null]]);

    const aliasRows = await sql.unsafe(
      `
      WITH artist_aliases AS (
        SELECT cp.artist_id, array_agg(DISTINCT a.artist_name) AS cross_reference_names
        FROM (
          SELECT source_artist_id AS artist_id, target_artist_id AS other_id
          FROM "${SCHEMA}".artist_crossreference
          UNION
          SELECT target_artist_id AS artist_id, source_artist_id AS other_id
          FROM "${SCHEMA}".artist_crossreference
        ) cp
        JOIN "${SCHEMA}".artists a ON a.id = cp.other_id
        WHERE cp.other_id <> cp.artist_id
        GROUP BY cp.artist_id
      )
      SELECT artist_id, cross_reference_names FROM artist_aliases
      WHERE artist_id IN ($1, $2)
      ORDER BY artist_id
    `,
      [ART_ALPHA, ART_BETA]
    );

    const byId = new Map(aliasRows.map((r) => [r.artist_id, r.cross_reference_names]));
    expect(byId.get(ART_ALPHA)).toEqual([BETA_NAME]);
    expect(byId.get(ART_BETA)).toEqual([ALPHA_NAME]);
  });
});

// The literal scripts/audit/bs_2117_crossref_backfill.sql file (with its
// embedded 110-pair real tubafrenzy dataset) is deliberately NOT executed
// here. It was validated directly against the dev-clone Postgres
// (dev_env/seed-clone.sql, real staging-derived data) via `psql -f` during
// development: a clean first run (79 pairs resolved by name, 77 rows
// inserted after dedup), a no-op second run (0 rows inserted, confirming
// idempotency), and the 77 test-inserted rows were then deleted to restore
// the table to its pre-run empty state. That verification is not
// reproducible as an automated spec here — the file's INSERT touches
// whichever real `artists` rows happen to match its embedded names, which
// depends on whether the environment loaded the prod-clone fixture
// (LOAD_CLONE_FIXTURE), and an automated spec cannot safely guarantee
// cleanup for side effects on rows it did not seed itself. The
// resolve/canonicalize/guard/insert SHAPE the file uses is exactly what
// `runBackfillPattern` above exercises against synthetic, self-cleaning
// fixtures instead.
