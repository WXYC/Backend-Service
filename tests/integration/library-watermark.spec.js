/**
 * BS#1467 (Epic F pattern, applied to the catalog) — `library_watermark` +
 * `touch_library_watermark` AFTER STATEMENT trigger (migration 0104).
 *
 * Postgres-dependent integration test (the BS analogue of the org test-pattern
 * `pg` marker): it exercises the trigger directly against the running test DB,
 * the same way `cta-unique-null-track-partial.spec.js` validates its partial
 * unique index. Every mutation here is raw SQL — so each case also stands in
 * for the `jobs/library-etl/` writer, which writes straight to Postgres,
 * bypassing the BS app layer entirely (the #1106 bypass failure mode an
 * app-level watermark would miss).
 *
 * The schema-source parity guard lives in schema.ts (drizzle:generate produces
 * no diff — the BS#1029 trap). This spec is the runtime behavior assertion:
 *
 *   1. INSERT / UPDATE / DELETE on `library` each advance the watermark.
 *   2. A direct, multi-row, app-layer-bypassing UPDATE advances it.
 *   3. A bulk write of N separate statements inside ONE transaction leaves the
 *      watermark at ≈now() and NOT in the future — guarding the #1106
 *      drift-forward half. With now() frozen at transaction start, 0084's
 *      `+1s` floor would land the watermark at T_start + (N-1)s; the catalog
 *      trigger drops that floor (`GREATEST(now(), last_modified_at)`), so it
 *      can't drift. A single-statement test fires the trigger once and cannot
 *      catch this.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for valid FK values
// (artist_id / genre_id / format_id). The fixture lives in
// `tests/fixtures/shape.sql`; globalSetup loads it before any spec runs.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;

// Namespace our probe rows by album_title so cleanup is surgical and we never
// touch fixture rows other specs depend on.
const TITLE_PREFIX = 'BS#1467 WM Probe';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('library_watermark trigger (BS#1467)', () => {
  let sql;
  let fk; // { artist_id, genre_id, format_id } pulled from row 7000

  beforeAll(async () => {
    sql = makeSql();
    const rows = await sql.unsafe(`SELECT artist_id, genre_id, format_id FROM "${SCHEMA}".library WHERE id = $1`, [
      SHAPE_FIXTURE_LIBRARY_ID,
    ]);
    fk = rows[0];
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
  });

  // Age the watermark to a known past instant via a direct write to the
  // watermark table. That write does NOT fire the trigger (the trigger is on
  // `library`), so it gives each case a deterministic "stale" baseline that a
  // fired trigger must then advance back to ≈now().
  const ageWm = async (interval) =>
    sql.unsafe(
      `UPDATE "${SCHEMA}".library_watermark SET last_modified_at = now() - interval '${interval}' WHERE id = true`
    );

  // Was the watermark advanced to ≈now()? Evaluated entirely in SQL against the
  // DB clock — no JS-vs-DB clock skew. Allows a 1s future slop for round-trip.
  const advancedToNow = async () => {
    const rows = await sql.unsafe(
      `SELECT (last_modified_at >= now() - interval '1 minute'
              AND last_modified_at <= now() + interval '1 second') AS ok
       FROM "${SCHEMA}".library_watermark WHERE id = true`
    );
    return rows[0].ok;
  };

  // Insert a probe library row; returns its id.
  const insertProbeRow = async (suffix) => {
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fk.artist_id, fk.genre_id, fk.format_id, `${TITLE_PREFIX} ${suffix}`, 0]
    );
    return rows[0].id;
  };

  test('INSERT on library advances the watermark to ≈now()', async () => {
    await ageWm('1 hour');
    await insertProbeRow('insert');
    expect(await advancedToNow()).toBe(true);
  });

  test('UPDATE on library advances the watermark to ≈now()', async () => {
    const id = await insertProbeRow('update');
    await ageWm('1 hour');
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET album_artist = 'changed' WHERE id = $1`, [id]);
    expect(await advancedToNow()).toBe(true);
  });

  test('DELETE on library advances the watermark to ≈now() (a MAX read would miss this)', async () => {
    const id = await insertProbeRow('delete');
    await ageWm('1 hour');
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = $1`, [id]);
    expect(await advancedToNow()).toBe(true);
  });

  test('a direct, app-layer-bypassing multi-row UPDATE advances the watermark (#1106 bypass guard)', async () => {
    await insertProbeRow('bypass-a');
    await insertProbeRow('bypass-b');
    await ageWm('1 hour');
    // Mirrors the ETL writing straight to Postgres: a multi-row UPDATE that
    // never passes through library.service.
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET plays = plays WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
    expect(await advancedToNow()).toBe(true);
  });

  test('a bulk N-statement single-transaction write does NOT drift the watermark into the future (#1106 drift-forward guard)', async () => {
    const id = await insertProbeRow('bulk');
    await ageWm('1 hour');

    // N separate statements inside ONE transaction. now() is frozen at
    // transaction start for all of them; the +1s floor would compound to
    // T_start + (N-1)s in the future. GREATEST(now(), last_modified_at) pins
    // the watermark at T_start.
    const N = 10;
    await sql.begin(async (tx) => {
      for (let i = 0; i < N; i++) {
        await tx.unsafe(`UPDATE "${SCHEMA}".library SET album_artist = $1 WHERE id = $2`, [`bulk-${i}`, id]);
      }
    });

    const rows = await sql.unsafe(
      `SELECT EXTRACT(EPOCH FROM (last_modified_at - now())) AS drift_s
       FROM "${SCHEMA}".library_watermark WHERE id = true`
    );
    const driftSeconds = Number(rows[0].drift_s);

    // Correct formula: drift ≈ 0 (≤ 1s slop). The +1s floor would put this at
    // ≈ +(N-1)s.
    expect(driftSeconds).toBeLessThanOrEqual(1);
    // And it still advanced (the trigger fired) — not stuck at the aged value.
    expect(await advancedToNow()).toBe(true);
  });
});
