/**
 * Integration tests for the BS#2065 stale-open-show detector's SELECTION SQL
 * against a REAL Postgres.
 *
 * The detector reports shows still holding `end_time IS NULL` past a plausible
 * show duration — the residue a dropped tubafrenzy `show_end` webhook delivery
 * leaves now that WXYC/wiki#88 Phase 3 has unscheduled `flowsheet-etl` and
 * nothing re-derives the column. The orchestration around it (log shape,
 * bounded Sentry sample, report-never-repair, running ahead of the cooperative
 * pause) is covered by
 * `tests/unit/jobs/legacy-mirror-reconcile/orchestrate.test.ts`; this spec's
 * value-add is the three exclusion bounds against a live planner, above all
 * the acceptance criterion "the genuinely-active show never trips it".
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). The queries below are a HAND-WRITTEN TWIN of the
 * drizzle SQL in `jobs/legacy-mirror-reconcile/orchestrate.ts`
 * (`selectStaleOpenShows` / `countHistoricalOpenShows`). When that file
 * changes, this SQL must follow — same contract as the BS#1707 sibling spec.
 *
 * Scoping note: unlike the BS#1707 spec, the report query CANNOT be fully
 * scoped to the seeded ids, because the current-show exclusion is by
 * construction a whole-table `max(id)` (it must track
 * `flowsheet_service.getLatestShow`'s `ORDER BY id DESC LIMIT 1`). The
 * assertions therefore filter the returned rows to the seeded set, and the
 * "current show" fixture is inserted LAST so it genuinely holds `max(id)`
 * (integration runs `--runInBand`, so nothing else is inserting concurrently).
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
let DJ_ID;
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

describe('stale-open-show detector selection SQL (BS#2065)', () => {
  let sql;
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

  // -- SQL twins of jobs/legacy-mirror-reconcile/orchestrate.ts ---------------

  /** Twin of `selectStaleOpenShows`. */
  const selectStaleOpenShows = async () =>
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
           AND s.id IS DISTINCT FROM (SELECT max(s2.id) FROM "${SCHEMA}".shows s2)
         ORDER BY s.start_time ASC`,
        [STALE_AFTER_HOURS, WINDOW_HOURS]
      )
    ).map((r) => ({ show_id: Number(r.show_id), last_entry_type: r.last_entry_type }));

  /** Twin of `countHistoricalOpenShows`. */
  const countHistoricalOpenShows = async () => {
    const [row] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".shows
        WHERE end_time IS NULL AND start_time < now() - (interval '1 hour' * $1::int)`,
      [WINDOW_HOURS]
    );
    return Number(row.n);
  };

  /** Reported rows, narrowed to this spec's fixtures. */
  const reportedSeededIds = async () => {
    const rows = await selectStaleOpenShows();
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

    historicalBaseline = await countHistoricalOpenShows();

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
    const rows = await selectStaleOpenShows();
    const target = rows.find((r) => r.show_id === showIds.dropped_show_end);
    expect(target).toBeDefined();
    expect(target.last_entry_type).toBe('show_end');
  });

  it('NEVER reports the genuinely-current show, even when it looks stale (BS#2065 AC)', async () => {
    // The `current` fixture is 20h old with no recent entries — it satisfies
    // both the threshold and the activity bound — and is excluded solely
    // because it is the row `getLatestShow()` returns. This is the guarantee
    // that does not depend on the threshold being tuned correctly.
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
    await expect(countHistoricalOpenShows()).resolves.toBe(historicalBaseline + 1);
  });
});
