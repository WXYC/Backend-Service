/**
 * BS#2505 — `rotation_label` on `GET /flowsheet/range`, against a real database.
 *
 * The unit spec pins the projection, the join predicate and the two transforms
 * with the DB mocked. What only a live Postgres can prove is that the join
 * actually resolves: that `flowsheet.rotation_id -> rotation.label_id ->
 * labels.label_name` produces the canonical name on a linked row, a genuine
 * NULL on an unlinked one, and — the case a naive "active rotation only" read
 * would get wrong — the name on a KILLED release that still has plays in the
 * window.
 *
 * It also proves the thing the ticket is actually about: two plays of the SAME
 * release whose free-text `record_label` disagrees resolve to ONE canonical
 * `rotation_label`. That disagreement is not hypothetical — 2.5% of rotation
 * releases carry more than one spelling across their weekly plays, and the
 * airplay report names each ranked line from the first linked entry, so one
 * variant names the whole line.
 *
 * The window is placed in 1997 — outside anything the shared dev/CI schema
 * seeds and outside the sibling range spec's 1998 window — so assertions can be
 * exact. Everything written here is torn down in afterAll.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Midnight ET on 1997-05-06 (EDT, UTC-4) and the following midnight.
const WINDOW_START = Date.UTC(1997, 4, 6, 4, 0, 0);
const WINDOW_END = Date.UTC(1997, 4, 7, 4, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const MARKER = 'BS2505 Label Probe';

const at = (offsetMs) => new Date(WINDOW_START + offsetMs).toISOString();

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

describe('GET /flowsheet/range — rotation_label (BS#2505)', () => {
  let sql;
  let labelId;
  let showId;
  const rotationIds = {};
  const entryIds = {};
  const LABEL_NAME = `${MARKER} People's Potential Unlimited`;

  beforeAll(async () => {
    sql = makeSql();

    // Defensive pre-delete so a crashed prior run can't collide on the unique
    // label_name. Children first: rotation.label_id has no ON DELETE action.
    await sql`DELETE FROM ${sql(SCHEMA)}.rotation
              WHERE label_id IN (SELECT id FROM ${sql(SCHEMA)}.labels WHERE label_name = ${LABEL_NAME})`;
    await sql`DELETE FROM ${sql(SCHEMA)}.labels WHERE label_name = ${LABEL_NAME}`;

    const labelRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.labels (label_name) VALUES (${LABEL_NAME}) RETURNING id`;
    labelId = labelRows[0].id;

    const showRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (start_time, end_time, legacy_dj_name)
      VALUES (${at(0)}::timestamptz, ${at(4 * HOUR_MS)}::timestamptz, ${`${MARKER} DJ`})
      RETURNING id`;
    showId = showRows[0].id;

    const insertRotation = async (key, { labelIdValue, killDate = null, recordLabel = null }) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.rotation (rotation_bin, add_date, kill_date, artist_name, album_title, record_label, label_id)
        VALUES ('H', ${at(0)}::date, ${killDate}, ${`${MARKER} ${key}`}, ${`${MARKER} album ${key}`}, ${recordLabel}, ${labelIdValue})
        RETURNING id`;
      rotationIds[key] = rows[0].id;
      return rows[0].id;
    };

    // linked:   an active release with a labels row — the ordinary case.
    // unlinked: the pre-BS#2412 shape, and the permanent shape of a release
    //           whose label never resolved. Must yield null, not '' and not the
    //           free-text value.
    // killed:   a release taken out of rotation that still has plays in the
    //           window. `GET /library/rotation` serves active rows only; this
    //           read joins by id with no status filter, and a historical report
    //           that dropped killed releases would be wrong about the week they
    //           actually aired in.
    await insertRotation('linked', { labelIdValue: labelId, recordLabel: 'ppu' });
    await insertRotation('unlinked', { labelIdValue: null, recordLabel: 'MCA Nashville' });
    await insertRotation('killed', {
      labelIdValue: labelId,
      killDate: new Date(WINDOW_START - 48 * HOUR_MS).toISOString().slice(0, 10),
      recordLabel: 'ppu records',
    });

    const insertEntry = async (key, offsetMs, { rotationKey = null, recordLabel = null }) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet
          (show_id, add_time, entry_type, artist_name, album_title, track_title, record_label, rotation_id, play_order)
        VALUES (
          ${showId}, ${at(offsetMs)}::timestamptz, 'track',
          ${`${MARKER} artist`}, ${`${MARKER} album`}, ${`${MARKER} ${key}`},
          ${recordLabel},
          ${rotationKey === null ? null : rotationIds[rotationKey]},
          ${Object.keys(entryIds).length + 1}
        )
        RETURNING id`;
      entryIds[key] = rows[0].id;
    };

    // The two spellings of ONE release — the defect this ticket exists for.
    await insertEntry('firstPlay', HOUR_MS, { rotationKey: 'linked', recordLabel: "People's Potential Unlimited" });
    await insertEntry('secondPlay', 2 * HOUR_MS, { rotationKey: 'linked', recordLabel: 'MCA Nashville' });
    await insertEntry('unlinkedPlay', 3 * HOUR_MS, { rotationKey: 'unlinked', recordLabel: 'MCA Nashville' });
    await insertEntry('killedPlay', 3.5 * HOUR_MS, { rotationKey: 'killed', recordLabel: 'ppu records' });
    // No rotation link at all — a freeform play. Not a rotation row's fault;
    // the field must still be present and null rather than absent.
    await insertEntry('freeformPlay', 3.75 * HOUR_MS, { rotationKey: null, recordLabel: 'self-released' });
  });

  afterAll(async () => {
    if (!sql) return;
    if (showId) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ${showId}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}`;
    }
    const rotIds = Object.values(rotationIds);
    if (rotIds.length) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${sql.array(rotIds)}::int[])`;
    }
    if (labelId) {
      await sql`DELETE FROM ${sql(SCHEMA)}.labels WHERE id = ${labelId}`;
    }
    await sql.end({ timeout: 5 });
  });

  const fetchRange = async () => {
    const res = await request.get(`/flowsheet/range?start=${WINDOW_START}&end=${WINDOW_END}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const findEntry = (body, key) => body.entries.find((e) => e.id === entryIds[key]);

  it('resolves the canonical label from the linked rotation release', async () => {
    const entry = findEntry(await fetchRange(), 'firstPlay');

    expect(entry.rotation_label).toBe(LABEL_NAME);
  });

  /**
   * The whole point. The report names a chart line from the FIRST linked entry
   * of the week, so two plays of one release that disagree about the free text
   * used to make the line's label a coin flip. They no longer can.
   */
  it('gives every play of one release the same label, however the DJ typed it', async () => {
    const body = await fetchRange();
    const first = findEntry(body, 'firstPlay');
    const second = findEntry(body, 'secondPlay');

    expect(first.record_label).not.toBe(second.record_label);
    expect(first.rotation_label).toBe(second.rotation_label);
    expect(second.rotation_label).toBe(LABEL_NAME);
  });

  it('yields null for a rotation row with no label_id', async () => {
    const entry = findEntry(await fetchRange(), 'unlinkedPlay');

    expect(entry.rotation_label).toBeNull();
    // The free-text snapshot is untouched and remains the consumer's fallback.
    expect(entry.record_label).toBe('MCA Nashville');
  });

  it('yields null for a play with no rotation link at all', async () => {
    const entry = findEntry(await fetchRange(), 'freeformPlay');

    expect(entry).toHaveProperty('rotation_label');
    expect(entry.rotation_label).toBeNull();
  });

  /**
   * The join is by id with no status filter, deliberately — a killed release
   * still aired in the week the report covers.
   */
  it('still resolves the label of a killed release with plays in the window', async () => {
    const entry = findEntry(await fetchRange(), 'killedPlay');

    expect(entry.rotation_label).toBe(LABEL_NAME);
  });

  it('leaves record_label unchanged on every entry', async () => {
    const body = await fetchRange();

    expect(findEntry(body, 'firstPlay').record_label).toBe("People's Potential Unlimited");
    expect(findEntry(body, 'killedPlay').record_label).toBe('ppu records');
    expect(findEntry(body, 'freeformPlay').record_label).toBe('self-released');
  });
});
