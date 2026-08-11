/**
 * Integration tests for the BS#2065 stale-open-show detector's SELECTION SQL
 * against a REAL Postgres.
 *
 * The detector reports shows still holding `end_time IS NULL` past a plausible
 * show duration — the residue a dropped tubafrenzy `show_end` webhook delivery
 * leaves now that WXYC/wiki#88 Phase 3 has unscheduled `flowsheet-etl` and
 * nothing re-derives the column. The orchestration around it (log shape,
 * bounded Sentry sample, report-never-repair, running ahead of the cooperative
 * pause, BS#2069's detector-failure isolation) is covered by
 * `tests/unit/jobs/legacy-mirror-reconcile/orchestrate.test.ts`; this spec's
 * value-add is the exclusion bounds against a live planner, above all the
 * acceptance criterion "the genuinely-active show never trips it".
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). `selectStaleOpenShows` / `countHistoricalOpenShows`
 * below are a HAND-WRITTEN TWIN of the drizzle SQL in
 * `jobs/legacy-mirror-reconcile/orchestrate.ts`. When that file changes, this
 * SQL must follow — same contract as the BS#1707 sibling spec.
 *
 * THIS CONTRACT IS PROSE, NOT MECHANICAL (BS#2098 review item 4 "also worth
 * closing" — and the reason that matters: a divergence between this twin and
 * the real predicate is exactly what let the BS#2068/#2069 precedence bug
 * ship through green tests — the twin was hand-written correctly parenthesized
 * from the start, so it never exercised the drizzle `and()`/`or()` composition
 * bug production actually had). `tests/unit/jobs/legacy-mirror-reconcile/stale-open-shows-sql.test.ts`
 * now renders `buildStaleOpenShowsQuery` — the REAL, unmodified production
 * function — through drizzle's own `PgDialect`, and asserts on the genuinely
 * rendered SQL text and bound params (not a hand-written twin, not a
 * call-shape mock). Mechanically asserting the two files' SQL against a
 * single shared string is impractical: this spec runs via babel-jest against
 * a live Docker Postgres, the unit test runs via ts-jest fully offline, and
 * ts-jest project's compiled output isn't reachable from this file's runner —
 * there's no single process or module system both can execute against
 * without introducing a generated-fixture build step, which is
 * disproportionate for what's currently a two-file, occasionally-touched
 * WHERE clause. So: when you change the WHERE clause in `buildStaleOpenShowsQuery`,
 * ALWAYS re-run `stale-open-shows-sql.test.ts` first, copy its newly-rendered
 * predicate text by hand into the twin below, and re-run BOTH suites before
 * committing. Skipping that is exactly how this bug shipped once already.
 *
 * Two describe blocks, run in this file's declaration order:
 *
 *   1. The original BS#2065 fixture set, pinning the three exclusion bounds
 *      including the acceptance criterion "the genuinely-active show never
 *      trips the detector" (the `current` fixture, held out solely by the
 *      id-based bound).
 *   2. A BS#2068 sibling: the `current`-shaped show CAN be reported once its
 *      newest flowsheet entry is a `show_end` marker — the id bound is
 *      conditional, not absolute, since #2065's own worst case is a show that
 *      never stops being `max(id)` while signed off. This needs a separate
 *      describe block, not another row in block 1's fixture set: block 1's
 *      `current` fixture must hold `max(id)` for the ENTIRE lifetime of its
 *      own tests, and this scenario needs a *different* row to hold that
 *      position — one show can't play both parts in the same moment. Jest
 *      runs this file's describe blocks in declaration order with each one's
 *      beforeAll/afterAll fully bracketing its own tests, so by the time
 *      block 2's beforeAll runs, block 1 has already cleaned up and block 2's
 *      own last-inserted row is once again the true table max — the same
 *      invariant block 1 relies on, re-established fresh.
 *
 * Scoping note: unlike the BS#1707 spec, the report query CANNOT be fully
 * scoped to the seeded ids, because the current-show exclusion is by
 * construction a whole-table `max(id)` (it must track
 * `flowsheet_service.getLatestShow`'s `ORDER BY id DESC LIMIT 1`). Block 1's
 * assertions filter the returned rows to its seeded set; block 2 seeds a
 * single row and checks it directly. Both rely on nothing else inserting into
 * `shows` concurrently (integration runs `--runInBand`).
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const WINDOW_HOURS = 48;
const STALE_AFTER_HOURS = 12;

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

// -- SQL twins of jobs/legacy-mirror-reconcile/orchestrate.ts ---------------
// Module-scope so both describe blocks below share one definition to keep in
// lockstep with `orchestrate.ts`, rather than drifting copies.

/**
 * Twin of `selectStaleOpenShows`. The final bound is the BS#2068 conditional
 * form: the current-show (`max(id)`) exclusion lifts when that show's newest
 * flowsheet entry is a `show_end` marker, since that marker is positive
 * evidence the show is over (BS#1861 option (b)) and is exactly the residue a
 * dropped tubafrenzy `show_end` webhook delivery leaves. Before BS#2068 this
 * was the unconditional `s.id IS DISTINCT FROM (SELECT max(s2.id) ...)`.
 *
 * KEEP THIS IN LOCKSTEP WITH `buildStaleOpenShowsQuery` IN
 * `jobs/legacy-mirror-reconcile/orchestrate.ts` BY HAND — see the file-level
 * docblock above for why that can't be automated, and
 * `tests/unit/jobs/legacy-mirror-reconcile/stale-open-shows-sql.test.ts` for
 * the genuinely-rendered production predicate to copy from whenever the WHERE
 * clause changes.
 */
const selectStaleOpenShows = async (sql) =>
  (
    await sql.unsafe(
      `SELECT s.id AS show_id,
              (SELECT f.entry_type FROM "${SCHEMA}".flowsheet f
                WHERE f.show_id = s.id ORDER BY f.id DESC LIMIT 1) AS last_entry_type
       FROM "${SCHEMA}".shows s
       WHERE s.end_time IS NULL
         AND s.start_time < now() - (interval '1 hour' * $1::int)
         AND s.start_time > now() - (interval '1 hour' * $2::int)
         AND NOT EXISTS (SELECT 1 FROM "${SCHEMA}".flowsheet f
                          WHERE f.show_id = s.id
                            AND f.add_time >= now() - (interval '1 hour' * $1::int))
         AND (
           s.id IS DISTINCT FROM (SELECT max(s2.id) FROM "${SCHEMA}".shows s2)
           OR (SELECT f.entry_type FROM "${SCHEMA}".flowsheet f
                WHERE f.show_id = s.id ORDER BY f.id DESC LIMIT 1) = 'show_end'
         )
       ORDER BY s.start_time ASC`,
      [STALE_AFTER_HOURS, WINDOW_HOURS]
    )
  ).map((r) => ({ show_id: Number(r.show_id), last_entry_type: r.last_entry_type }));

/** Twin of `countHistoricalOpenShows`. */
const countHistoricalOpenShows = async (sql) => {
  const [row] = await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${SCHEMA}".shows
      WHERE end_time IS NULL AND start_time < now() - (interval '1 hour' * $1::int)`,
    [WINDOW_HOURS]
  );
  return Number(row.n);
};

describe('stale-open-show detector selection SQL (BS#2065)', () => {
  let sql;
  let DJ_ID;
  const showIds = {};
  let allShowIds = [];
  let historicalBaseline = 0;

  const seedShow = async (key, { startExpr, endExpr = 'NULL' }) => {
    const [row] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".shows (primary_dj_id, show_name, start_time, end_time)
       VALUES ($1, $2, ${startExpr}, ${endExpr})
       RETURNING id`,
      [DJ_ID, `BS2065 ${key}`]
    );
    showIds[key] = Number(row.id);
    allShowIds.push(showIds[key]);
    return showIds[key];
  };

  const seedEntry = async (showId, { entryType = 'track', addTimeExpr }) =>
    sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (show_id, entry_type, play_order, artist_name, track_title, add_time)
       VALUES ($1, $2, 1, 'BS2065 Artist', 'BS2065 Track', ${addTimeExpr})`,
      [showId, entryType]
    );

  /** Reported rows, narrowed to this spec's fixtures. */
  const reportedSeededIds = async () => {
    const rows = await selectStaleOpenShows(sql);
    return rows.filter((r) => allShowIds.includes(r.show_id)).map((r) => r.show_id);
  };

  const cleanup = async () => {
    // flowsheet first: `flowsheet.show_id` is ON DELETE SET NULL, so deleting
    // the shows first orphans the entries instead of removing them.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'BS2065 Artist'`);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE show_name LIKE 'BS2065 %'`);
  };

  beforeAll(async () => {
    sql = makeSql();
    await cleanup();
    allShowIds = [];

    const djRows = await sql.unsafe(`SELECT id FROM auth_user LIMIT 1`);
    if (djRows.length === 0) throw new Error('BS2065 detector spec: no seeded auth_user to own the fixture shows');
    DJ_ID = djRows[0].id;

    historicalBaseline = await countHistoricalOpenShows(sql);

    // A — the target case: open, 20h old, sign-off marker present but
    // `end_time` never stamped (the dropped-delivery signature).
    await seedShow('dropped_show_end', { startExpr: `now() - interval '20 hours'` });
    await seedEntry(showIds.dropped_show_end, { entryType: 'track', addTimeExpr: `now() - interval '20 hours'` });
    await seedEntry(showIds.dropped_show_end, { entryType: 'show_end', addTimeExpr: `now() - interval '18 hours'` });

    // B — open but younger than the threshold: a normal in-progress show.
    await seedShow('recent_open', { startExpr: `now() - interval '2 hours'` });

    // C — properly closed at 20h old: `end_time` landed, nothing to report.
    await seedShow('closed', {
      startExpr: `now() - interval '20 hours'`,
      endExpr: `now() - interval '18 hours'`,
    });

    // D — a genuinely-live marathon: started 20h ago (past the threshold) but
    // still logging tracks, so the activity bound excludes it.
    await seedShow('marathon_still_logging', { startExpr: `now() - interval '20 hours'` });
    await seedEntry(showIds.marathon_still_logging, {
      entryType: 'track',
      addTimeExpr: `now() - interval '10 minutes'`,
    });

    // E — outside the recurring window: the #1543 final-dump repair cohort.
    await seedShow('historical_open', { startExpr: `now() - interval '10 days'` });

    // F — the genuinely-current show, per `getLatestShow`'s ORDER BY id DESC.
    // Deliberately given a stale-looking shape (20h old, no recent entries) so
    // ONLY the current-show exclusion can keep it out of the report. Inserted
    // LAST so it holds max(id).
    await seedShow('current', { startExpr: `now() - interval '20 hours'` });
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it('reports an open show whose sign-off marker landed without the end_time stamp', async () => {
    const reported = await reportedSeededIds();
    expect(reported).toContain(showIds.dropped_show_end);
  });

  it('carries the last marker type so the report can name what terminated the show', async () => {
    const rows = await selectStaleOpenShows(sql);
    const target = rows.find((r) => r.show_id === showIds.dropped_show_end);
    expect(target).toBeDefined();
    expect(target.last_entry_type).toBe('show_end');
  });

  it('NEVER reports the genuinely-current show, even when it looks stale (BS#2065 AC)', async () => {
    // The `current` fixture is 20h old with no recent entries and NO
    // flowsheet entries at all — it satisfies the threshold and the activity
    // bound, and has no `show_end` marker to lift the id exclusion (BS#2068)
    // — so it is excluded solely because it is the row `getLatestShow()`
    // returns. This is the guarantee that does not depend on the threshold
    // being tuned correctly, nor on the BS#2068 marker-conditioned carve-out
    // (see the BS#2068 sibling describe below for that case).
    const [maxRow] = await sql.unsafe(`SELECT max(id)::int AS id FROM "${SCHEMA}".shows`);
    expect(Number(maxRow.id)).toBe(showIds.current);

    const reported = await reportedSeededIds();
    expect(reported).not.toContain(showIds.current);
  });

  it('does not report a show younger than the threshold', async () => {
    const reported = await reportedSeededIds();
    expect(reported).not.toContain(showIds.recent_open);
  });

  it('does not report a show whose end_time is already set', async () => {
    const reported = await reportedSeededIds();
    expect(reported).not.toContain(showIds.closed);
  });

  it('does not report a long-running show that is still logging entries', async () => {
    const reported = await reportedSeededIds();
    expect(reported).not.toContain(showIds.marathon_still_logging);
  });

  it('holds the out-of-window historical cohort out of the report and counts it instead', async () => {
    const reported = await reportedSeededIds();
    expect(reported).not.toContain(showIds.historical_open);
    // Exactly one seeded show sits older than the window.
    await expect(countHistoricalOpenShows(sql)).resolves.toBe(historicalBaseline + 1);
  });
});

describe('stale-open-show detector: max(id) exclusion is conditional on show_end (BS#2068)', () => {
  let sql;
  let showId;

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = 'BS2068 Artist'`);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE show_name LIKE 'BS2068 %'`);
  };

  beforeAll(async () => {
    sql = makeSql();
    await cleanup();

    const djRows = await sql.unsafe(`SELECT id FROM auth_user LIMIT 1`);
    if (djRows.length === 0) throw new Error('BS2068 sibling spec: no seeded auth_user to own the fixture show');
    const djId = djRows[0].id;

    // The converse of the `current` fixture in the BS#2065 describe above:
    // same shape (20h old, no activity since the cutoff, deliberately made to
    // hold max(id) by being the last show inserted anywhere in this file) but
    // its NEWEST flowsheet entry is a `show_end` marker rather than nothing —
    // the exact residue a dropped tubafrenzy `show_end` webhook delivery
    // leaves (marker landed, `shows.end_time` never stamped). Before BS#2068
    // the unconditional id bound made this permanently unreportable for as
    // long as it held max(id) — the concrete gap #2068 was filed over. It
    // must now be reported.
    const [row] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".shows (primary_dj_id, show_name, start_time, end_time)
       VALUES ($1, $2, now() - interval '20 hours', NULL) RETURNING id`,
      [djId, 'BS2068 current_dropped_show_end']
    );
    showId = Number(row.id);
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (show_id, entry_type, play_order, artist_name, track_title, add_time)
       VALUES ($1, 'show_end', 1, 'BS2068 Artist', 'BS2068 Track', now() - interval '18 hours')`,
      [showId]
    );
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it('holds max(id), same as the BS#2065 describe relies on for its own `current` fixture', async () => {
    const [maxRow] = await sql.unsafe(`SELECT max(id)::int AS id FROM "${SCHEMA}".shows`);
    expect(Number(maxRow.id)).toBe(showId);
  });

  it('is reported even though it is max(id), because its newest entry is a show_end marker', async () => {
    const rows = await selectStaleOpenShows(sql);
    const target = rows.find((r) => r.show_id === showId);
    expect(target).toBeDefined();
    expect(target.last_entry_type).toBe('show_end');
  });
});
