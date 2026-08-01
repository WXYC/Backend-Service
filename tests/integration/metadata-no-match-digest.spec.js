/**
 * Integration test for `jobs/metadata-no-match-digest`'s query against real
 * PostgreSQL. Runs the REAL compiled `queryNoMatchRows` (`dist/query.cjs`) so
 * the `@wxyc/database` postgres-js driver -- with Drizzle's date-family
 * parser/serializer passthrough -- is exercised end to end. That driver seam is
 * exactly what an earlier bare-`postgres()` mirror of the SQL could never
 * reach: it let two prod-only defects ship green --
 *   (1) OUTBOUND: binding a JS `Date` for the `updated_at > :since` bound threw
 *       `ERR_INVALID_ARG_TYPE` inside postgres-js's `Bind`, surfaced only as
 *       Drizzle's opaque "Failed query: ..." wrapper (the digest failed on its
 *       first real run);
 *   (2) INBOUND: timestamptz columns come back as raw strings, so `format.ts`'s
 *       `formatPacificDateTime(row.start_time)` would throw on any
 *       rotation-linked row carrying a show start time.
 * query.ts fixes both (pre-stringified `::timestamptz` bound + epoch-selected
 * timestamps rebuilt into Dates); this spec pins that the real function no
 * longer throws AND returns `Date`-typed timestamps, plus the SELECT semantics
 * (watermark boundary, entry_type / status filters, rotation-first ordering).
 *
 * `dist/query.cjs` is produced by the workspace `build` (tsup esm+cjs); CI's
 * Build step runs before the integration tier. Rebuild after editing query.ts
 * (`npm run build --workspace=@wxyc/metadata-no-match-digest`). Needs the Docker
 * integration DB (the `pg` marker tier). Every seeded artist carries an 'nmd-'
 * marker and every seeded id is tracked for teardown.
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (for the ts-jest
// unit tier) is auto-applied to every `drizzle-orm` require, including here.
// `dist/query.cjs` needs the REAL drizzle-orm (its `sql` template builds the
// query `@wxyc/database`'s driver runs), so unmock it -- same pattern as
// `artist-unicode-dedup-merge.spec.js` / `rotation-match.spec.js`. Hoisted
// above the requires by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

// The REAL compiled query core -- no reimplementation, so the driver behavior
// under test is the one that ships.
const { queryNoMatchRows, MAX_DIGEST_ROWS } = require(
  path.join(__dirname, '..', '..', 'jobs', 'metadata-no-match-digest', 'dist', 'query.cjs')
);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('metadata-no-match-digest queryNoMatchRows (REAL fn, real PG)', () => {
  let sql;
  const flowsheetIds = [];
  const showIds = [];
  const rotationIds = [];

  /** Insert a flowsheet row already stamped `enriched_no_match` (or an override), returning its id. */
  async function seedRow(
    artist,
    { entryType = 'track', rotationId = null, showId = null, metadataStatus = 'enriched_no_match' } = {}
  ) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, rotation_id, show_id, add_time, metadata_status)
      VALUES
        (91234, ${entryType}, ${artist}, 'NMD Album', 'NMD Track',
         false, false, ${rotationId}, ${showId}, now(), ${metadataStatus})
      RETURNING id
    `;
    const id = Number(rows[0].id);
    flowsheetIds.push(id);
    return id;
  }

  /** Insert a show (its `start_time` NOT NULL default now() exercises the inbound-date path via the LEFT JOIN). */
  async function seedShow() {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (show_name, start_time)
      VALUES ('nmd-show', now())
      RETURNING id
    `;
    const id = Number(rows[0].id);
    showIds.push(id);
    return id;
  }

  async function seedRotation() {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, artist_name, album_title)
      VALUES (NULL, 'H', 'nmd-rotation-artist', 'nmd-rotation-album')
      RETURNING id
    `;
    const id = Number(rows[0].id);
    rotationIds.push(id);
    return id;
  }

  beforeAll(() => {
    sql = getTestDb();
  });

  afterEach(async () => {
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
      flowsheetIds.length = 0;
    }
    if (rotationIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rotationIds})`;
      rotationIds.length = 0;
    }
    if (showIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ANY(${showIds})`;
      showIds.length = 0;
    }
  });

  it('runs without throwing and returns Date-typed timestamps for a rotation+show-linked row (the driver-seam regression)', async () => {
    const [{ since }] = await sql`SELECT now() - interval '1 minute' AS since`;
    const showId = await seedShow();
    const rotationId = await seedRotation();
    const id = await seedRow('nmd-driver-seam', { rotationId, showId });

    // Before the fix this rejected with Drizzle's "Failed query" wrapper.
    const rows = await queryNoMatchRows(since);

    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row.updated_at).toBeInstanceOf(Date); // NOT NULL -> always a Date
    expect(row.add_time).toBeInstanceOf(Date);
    expect(row.start_time).toBeInstanceOf(Date); // from the joined show -> exercises the inbound-date path
    expect(Number.isNaN(row.start_time.getTime())).toBe(false);
    expect(row.rotation_id).toBe(rotationId);
    expect(row.show_id).toBe(showId);
  });

  it('leaves start_time null for a freeform row with no show (LEFT JOIN miss)', async () => {
    const [{ since }] = await sql`SELECT now() - interval '1 minute' AS since`;
    const id = await seedRow('nmd-null-start');

    const row = (await queryNoMatchRows(since)).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row.start_time).toBeNull();
    expect(row.rotation_id).toBeNull();
  });

  it('returns only rows updated strictly after `since` (the exclusive watermark boundary)', async () => {
    const older = await seedRow('nmd-boundary-older');
    // Capture the boundary from the DB clock with a >1ms gap on each side so the
    // exclusive `>` verdict is unambiguous regardless of driver sub-ms rounding.
    await sql`SELECT pg_sleep(0.02)`;
    const [{ since }] = await sql`SELECT now() AS since`;
    await sql`SELECT pg_sleep(0.02)`;
    const newer = await seedRow('nmd-boundary-newer');

    const ids = (await queryNoMatchRows(since)).map((r) => r.id);
    expect(ids).toContain(newer);
    expect(ids).not.toContain(older);
  });

  it("excludes non-'track' entry types even when stamped enriched_no_match", async () => {
    const [{ since }] = await sql`SELECT now() - interval '1 minute' AS since`;
    const track = await seedRow('nmd-entrytype-track', { entryType: 'track' });
    const talkset = await seedRow('nmd-entrytype-talkset', { entryType: 'talkset' });

    const ids = (await queryNoMatchRows(since)).map((r) => r.id);
    expect(ids).toContain(track);
    expect(ids).not.toContain(talkset);
  });

  it('excludes rows that are not in the enriched_no_match state', async () => {
    const [{ since }] = await sql`SELECT now() - interval '1 minute' AS since`;
    const noMatch = await seedRow('nmd-status-nomatch', { metadataStatus: 'enriched_no_match' });
    const matched = await seedRow('nmd-status-match', { metadataStatus: 'enriched_match' });

    const ids = (await queryNoMatchRows(since)).map((r) => r.id);
    expect(ids).toContain(noMatch);
    expect(ids).not.toContain(matched);
  });

  it('orders rotation/catalog-linked rows ahead of freeform', async () => {
    const [{ since }] = await sql`SELECT now() - interval '1 minute' AS since`;
    const rotationId = await seedRotation();
    // Freeform seeded first (older), rotation-linked second (newer) -- so the
    // rotation-first ordering must override the newest-first tiebreak.
    const freeform = await seedRow('nmd-order-freeform', { rotationId: null });
    const linked = await seedRow('nmd-order-linked', { rotationId });

    const result = await queryNoMatchRows(since);
    const linkedPos = result.findIndex((r) => r.id === linked);
    const freeformPos = result.findIndex((r) => r.id === freeform);
    expect(linkedPos).toBeGreaterThanOrEqual(0);
    expect(freeformPos).toBeGreaterThanOrEqual(0);
    expect(linkedPos).toBeLessThan(freeformPos);
  });

  it('exports the MAX_DIGEST_ROWS cap the query LIMITs on', () => {
    expect(MAX_DIGEST_ROWS).toBe(5000);
  });
});
