/**
 * Integration tests for the legacy-mirror-reconcile SELECTION SQL (BS#1707)
 * against a REAL Postgres.
 *
 * Validates the two sweeps' all-or-nothing partitioning + window/settle bounds
 * — the invariants hardened over five review rounds that are the hardest to
 * unit-test (the NOT EXISTS anti-joins). The mirror PAYLOAD mapping is already
 * covered by `tests/integration/mirror-http.spec.js` (the behavior-parity
 * guard) and the `@wxyc/legacy-mirror` unit suites; the orchestration SEQUENCE
 * (show-before-entries, signoff scope, flag gate, pause) is covered by
 * `tests/unit/jobs/legacy-mirror-reconcile/orchestrate.test.ts`. This spec's
 * value-add is the selection predicates against a live planner.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). The queries below are a HAND-WRITTEN TWIN of the
 * drizzle SQL in `jobs/legacy-mirror-reconcile/orchestrate.ts`
 * (selectShowsToCreate / selectEntrySweepShows / selectPartialShows /
 * selectOrphanEntries). When that file changes, this SQL must follow. Every
 * selection is additionally scoped to the seeded show ids so ambient
 * fixture/other-spec rows can't perturb the assertions.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// shows.primary_dj_id FKs auth_user.id — a plain public pgTable, NOT in
// WXYC_SCHEMA. Resolved to the seed's staging default user in beforeAll rather
// than fabricating an auth_user row (convention: internal-banned-fingerprints.spec.js).
let DJ_ID;
const WINDOW_HOURS = 48;
const SETTLE_MINUTES = 15;

// High, distinct surrogate keys to dodge the unique indexes on
// shows.legacy_show_id and flowsheet.legacy_entry_id.
let LEGACY_SHOW_SEQ = 99170001;
let LEGACY_ENTRY_SEQ = 99171001;

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

describe('legacy-mirror-reconcile selection SQL (BS#1707)', () => {
  let sql;
  const showIds = {};
  let allShowIds = [];

  /** Insert a show, return its serial id. `startExpr` is a SQL now()-offset. */
  const seedShow = async (key, { legacyShowId = null, primaryDjId = DJ_ID, startExpr, endExpr = 'NULL' }) => {
    const [row] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".shows (primary_dj_id, show_name, start_time, end_time, legacy_show_id)
       VALUES ($1, $2, ${startExpr}, ${endExpr}, $3)
       RETURNING id`,
      [primaryDjId, `BS1707 ${key}`, legacyShowId]
    );
    showIds[key] = Number(row.id);
    return showIds[key];
  };

  /** Insert a flowsheet entry; `legacyEntryId=null` ⇒ an orphan (un-mirrored). */
  const seedEntry = async (showId, playOrder, { legacyEntryId = null, entryType = 'track' } = {}) => {
    const [row] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (show_id, entry_type, play_order, legacy_entry_id, artist_name, track_title, add_time)
       VALUES ($1, $2, $3, $4, 'BS1707 Artist', 'BS1707 Track', now())
       RETURNING id`,
      [showId, entryType, playOrder, legacyEntryId]
    );
    return Number(row.id);
  };

  // -- SQL twins of jobs/legacy-mirror-reconcile/orchestrate.ts --------------

  // Twin of orchestrate.ts `mirrorableEntryType` (NON_MIRRORED_MARKER_TYPES):
  // dj_join/dj_leave markers are inserted as side effects of joinShow/endShow/
  // leaveShow on the /join and /end routes, whose mirror middleware mirrors only
  // the show + show_start/show_end announcement — never these markers. Their
  // legacy_entry_id therefore stays NULL forever, so every "un-mirrored entry"
  // predicate must exclude them (else every multi-DJ show is falsely flagged
  // partial on every run). Unqualified `entry_type` resolves to the flowsheet
  // row in each (sub)query — `shows` has no such column.
  const MIRRORABLE = `entry_type NOT IN ('dj_join', 'dj_leave')`;

  const selectShowsToCreate = async () =>
    (
      await sql.unsafe(
        `SELECT s.id FROM "${SCHEMA}".shows s
         WHERE s.legacy_show_id IS NULL
           AND s.primary_dj_id IS NOT NULL
           AND s.start_time < now() - (interval '1 minute' * $1::int)
           AND s.start_time > now() - (interval '1 hour' * $2::int)
           AND NOT EXISTS (SELECT 1 FROM "${SCHEMA}".flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NOT NULL AND ${MIRRORABLE})
           AND s.id = ANY($3)
         ORDER BY s.start_time ASC`,
        [SETTLE_MINUTES, WINDOW_HOURS, allShowIds]
      )
    ).map((r) => Number(r.id));

  const selectEntrySweepShows = async () =>
    (
      await sql.unsafe(
        `SELECT s.id FROM "${SCHEMA}".shows s
         WHERE s.legacy_show_id IS NOT NULL
           AND s.start_time < now() - (interval '1 minute' * $1::int)
           AND s.start_time > now() - (interval '1 hour' * $2::int)
           AND EXISTS     (SELECT 1 FROM "${SCHEMA}".flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NULL AND ${MIRRORABLE})
           AND NOT EXISTS (SELECT 1 FROM "${SCHEMA}".flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NOT NULL AND ${MIRRORABLE})
           AND s.id = ANY($3)
         ORDER BY s.start_time ASC`,
        [SETTLE_MINUTES, WINDOW_HOURS, allShowIds]
      )
    ).map((r) => Number(r.id));

  const selectPartialShows = async () =>
    (
      await sql.unsafe(
        `SELECT s.id AS show_id,
                (SELECT count(*)::int FROM "${SCHEMA}".flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NULL AND ${MIRRORABLE}) AS orphan_entry_count
         FROM "${SCHEMA}".shows s
         WHERE s.start_time < now() - (interval '1 minute' * $1::int)
           AND s.start_time > now() - (interval '1 hour' * $2::int)
           AND EXISTS (SELECT 1 FROM "${SCHEMA}".flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NULL AND ${MIRRORABLE})
           AND EXISTS (SELECT 1 FROM "${SCHEMA}".flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NOT NULL AND ${MIRRORABLE})
           AND s.id = ANY($3)`,
        [SETTLE_MINUTES, WINDOW_HOURS, allShowIds]
      )
    ).map((r) => ({ show_id: Number(r.show_id), orphan_entry_count: Number(r.orphan_entry_count) }));

  const selectOrphanEntries = async (showId) =>
    (
      await sql.unsafe(
        `SELECT id, play_order FROM "${SCHEMA}".flowsheet
         WHERE show_id = $1 AND legacy_entry_id IS NULL AND ${MIRRORABLE}
         ORDER BY play_order ASC`,
        [showId]
      )
    ).map((r) => Number(r.play_order));

  // Delete flowsheet BEFORE shows. `flowsheet.show_id` is ON DELETE SET NULL, so
  // deleting a show first orphans its entries (show_id→NULL) while they keep
  // their unique legacy_entry_id — which then collides with the next run's
  // LEGACY_ENTRY_SEQ. The `artist_name` literal catches rows a prior run already
  // orphaned (show_id NULL), which a show_id-scoped delete would miss.
  const cleanup = async () => {
    if (allShowIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE show_id = ANY($1)`, [allShowIds]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE id = ANY($1)`, [allShowIds]);
    }
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'BS1707 Artist'`);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE show_name LIKE 'BS1707 %'`);
  };

  beforeAll(async () => {
    sql = makeSql();
    // Pre-clean residue from a prior run that didn't reach afterAll — flowsheet
    // first (see cleanup) so an orphaned unique legacy_entry_id can't wedge the
    // seed inserts below.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'BS1707 Artist'`);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE show_name LIKE 'BS1707 %'`);

    // Own the fixture shows with the seed's staging default user (auth_user is a
    // public pgTable, not in WXYC_SCHEMA) rather than fabricating a row.
    const djRows = await sql.unsafe(`SELECT id FROM auth_user LIMIT 1`);
    if (djRows.length === 0) throw new Error('BS1707 reconcile spec: no seeded auth_user to own the fixture shows');
    DJ_ID = djRows[0].id;

    // A — orphan-create: no tubafrenzy show, DJ set, in window, past settle,
    //     zero mirrored entries → sweep-1 candidate; NOT a sweep-2 candidate.
    await seedShow('A', { startExpr: "now() - interval '2 hours'" });
    await seedEntry(showIds.A, 1);
    await seedEntry(showIds.A, 2);

    // B — too-recent: started inside the settle window → excluded from sweep 1.
    await seedShow('B', { startExpr: "now() - interval '5 minutes'" });
    await seedEntry(showIds.B, 1);

    // C — too-old: started before the 48h window → excluded everywhere.
    await seedShow('C', { startExpr: "now() - interval '60 hours'" });
    await seedEntry(showIds.C, 1);

    // D — DJ-less: primary_dj_id NULL → excluded from sweep 1 (unmirrorable).
    await seedShow('D', { primaryDjId: null, startExpr: "now() - interval '2 hours'" });
    await seedEntry(showIds.D, 1);

    // E — mid-flag-flip: legacy_show_id NULL but an addEntry already mirrored
    //     an entry (server-side auto-resolved show). Has both a mirrored and an
    //     orphan entry → excluded from sweep 1 by the all-or-nothing guard;
    //     surfaces in the partial report instead.
    await seedShow('E', { startExpr: "now() - interval '2 hours'" });
    await seedEntry(showIds.E, 1, { legacyEntryId: LEGACY_ENTRY_SEQ++ });
    await seedEntry(showIds.E, 2);

    // F — entry-sweep: has a tubafrenzy show, all-or-nothing (orphan entries,
    //     none mirrored) → sweep-2 candidate.
    await seedShow('F', { legacyShowId: LEGACY_SHOW_SEQ++, startExpr: "now() - interval '3 hours'" });
    await seedEntry(showIds.F, 1);
    await seedEntry(showIds.F, 2);
    await seedEntry(showIds.F, 3);

    // G — healed: has a tubafrenzy show and every entry mirrored → excluded
    //     from sweep 2 (idempotency) and not partial.
    await seedShow('G', { legacyShowId: LEGACY_SHOW_SEQ++, startExpr: "now() - interval '3 hours'" });
    await seedEntry(showIds.G, 1, { legacyEntryId: LEGACY_ENTRY_SEQ++ });
    await seedEntry(showIds.G, 2, { legacyEntryId: LEGACY_ENTRY_SEQ++ });

    // H — partial with a tubafrenzy show: both mirrored + orphan entries →
    //     partial report, excluded from both sweeps.
    await seedShow('H', { legacyShowId: LEGACY_SHOW_SEQ++, startExpr: "now() - interval '2 hours'" });
    await seedEntry(showIds.H, 1, { legacyEntryId: LEGACY_ENTRY_SEQ++ });
    await seedEntry(showIds.H, 2);

    // I — fully-mirrored multi-DJ show: show_start + every track + show_end
    //     mirrored, PLUS dj_join/dj_leave markers the live path never mirrors
    //     (legacy_entry_id stays NULL forever). Must NOT be flagged partial and
    //     must NOT enter either sweep — the markers are excluded from the
    //     "un-mirrored entry" predicates (BS#1707 review). Without that filter,
    //     every co-hosted show would be falsely reported partial on every run.
    await seedShow('I', { legacyShowId: LEGACY_SHOW_SEQ++, startExpr: "now() - interval '2 hours'" });
    await seedEntry(showIds.I, 1, { legacyEntryId: LEGACY_ENTRY_SEQ++, entryType: 'show_start' });
    await seedEntry(showIds.I, 2, { legacyEntryId: LEGACY_ENTRY_SEQ++, entryType: 'track' });
    await seedEntry(showIds.I, 3, { entryType: 'dj_join' }); // orphan marker, never mirrored
    await seedEntry(showIds.I, 4, { legacyEntryId: LEGACY_ENTRY_SEQ++, entryType: 'track' });
    await seedEntry(showIds.I, 5, { entryType: 'dj_leave' }); // orphan marker, never mirrored
    await seedEntry(showIds.I, 6, { legacyEntryId: LEGACY_ENTRY_SEQ++, entryType: 'show_end' });

    // J — entry-sweep shape but too-recent: has a tubafrenzy show and is
    //     all-or-nothing (orphan entries, none mirrored), but started inside the
    //     settle window. A just-added track may still be mid-live-mirror, so
    //     sweep 2 must NOT touch it yet (same settle bound as sweep 1).
    await seedShow('J', { legacyShowId: LEGACY_SHOW_SEQ++, startExpr: "now() - interval '5 minutes'" });
    await seedEntry(showIds.J, 1);
    await seedEntry(showIds.J, 2);

    // K — partial-shaped but too-recent: one mirrored entry + one orphan, but
    //     started inside the settle window. Looks partial, but the orphan is
    //     likely just mid-live-mirror, so the partial report must hold it back
    //     (no false "manual remediation" alert). Excluded from both sweeps too.
    await seedShow('K', { legacyShowId: LEGACY_SHOW_SEQ++, startExpr: "now() - interval '5 minutes'" });
    await seedEntry(showIds.K, 1, { legacyEntryId: LEGACY_ENTRY_SEQ++ });
    await seedEntry(showIds.K, 2);

    allShowIds = Object.values(showIds);
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it('sweep 1 selects only the all-or-nothing, in-window, past-settle, DJ-owned show', async () => {
    const ids = await selectShowsToCreate();
    expect(ids).toEqual([showIds.A]);
  });

  it('sweep 2 selects only the all-or-nothing show that already has a tubafrenzy show', async () => {
    // F (3h old) qualifies; J (same shape but 5 min old) is held back by the
    // settle bound, so the strict equality doubles as the settle-bound guard.
    const ids = await selectEntrySweepShows();
    expect(ids).toEqual([showIds.F]);
  });

  it('partial report surfaces every show with BOTH a mirrored and an orphan entry', async () => {
    // E and H (both 2h old) qualify; K (same partial shape but 5 min old) is
    // held back by the settle bound, so the strict set equality doubles as the
    // partial-report settle-bound guard (no false mid-live-mirror alert).
    const partials = await selectPartialShows();
    const byId = Object.fromEntries(partials.map((p) => [p.show_id, p.orphan_entry_count]));
    expect(new Set(Object.keys(byId).map(Number))).toEqual(new Set([showIds.E, showIds.H]));
    expect(byId[showIds.E]).toBe(1);
    expect(byId[showIds.H]).toBe(1);
  });

  it('orphan-entry read returns the NULL-legacy entries in play_order order', async () => {
    const orders = await selectOrphanEntries(showIds.F);
    expect(orders).toEqual([1, 2, 3]);
  });

  it('excludes a fully-mirrored multi-DJ show whose only orphans are join/leave markers', async () => {
    // Show I: show_start + tracks + show_end all mirrored, plus dj_join/dj_leave
    // markers the live path never mirrors (legacy_entry_id NULL forever). The
    // markers must not make it look partial, land it in a sweep, or get POSTed.
    const sweep2 = await selectEntrySweepShows();
    expect(sweep2).not.toContain(showIds.I);

    const partials = await selectPartialShows();
    expect(partials.map((p) => p.show_id)).not.toContain(showIds.I);

    // Sweep 2's orphan read over I returns no markers to POST (live-path parity).
    const orphans = await selectOrphanEntries(showIds.I);
    expect(orphans).toEqual([]);
  });

  it('is idempotent: once F is healed it drops out of the sweep-2 candidate set', async () => {
    // Simulate a completed heal by stamping legacy_entry_id on F's entries.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".flowsheet SET legacy_entry_id = id + $1 WHERE show_id = $2 AND legacy_entry_id IS NULL`,
      [90000000, showIds.F]
    );
    const ids = await selectEntrySweepShows();
    expect(ids).not.toContain(showIds.F);

    // And F is not a partial (no orphan entries remain); E/H still are.
    const partials = await selectPartialShows();
    expect(partials.map((p) => p.show_id)).not.toContain(showIds.F);
  });
});
