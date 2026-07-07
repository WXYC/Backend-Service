/**
 * BMI Performance List export (BS#1500 — successor to tubafrenzy's `recentBMI`).
 *
 * The station librarian (a non-engineer) semiannually pulls the list of played
 * musical works and submits it to BMI for royalty reporting. tubafrenzy served
 * this from `RecentBMIServlet` as a stateless "recent 1000" `###`-delimited
 * dump; that path dies with the 2026-08-31 turndown (org Project #36). This
 * module is the Backend-Service replacement, read by an MD/SM-gated dj-site
 * admin tool (`/dashboard/admin/bmi`) so the pull becomes self-serve.
 *
 * SHELL SCOPE (this file): the date-range contract, the entry/composer
 * projection, the DB read, and the coverage summary the dj-site preview shows.
 * DEFERRED to #1507 (the BMI submission-format ticket): the exact wire format
 * BMI accepts (tubafrenzy emitted `artist###song###release###composer######`),
 * and whether `artist_proxy` composer rows are included or excluded. Neither
 * decision changes the contract below — the endpoint returns structured JSON;
 * the finalization pass renders the accepted text format from it. See the
 * proposal on WXYC/Backend-Service#1500.
 *
 * Composer provenance (`composer_source`) is carried through untouched so the
 * dj-site preview can warn the librarian how much of the window is backed by a
 * real Discogs writer credit vs an artist-name proxy vs nothing before they
 * submit. Values mirror `flowsheet.composer_source` (#1499): 'discogs_track' |
 * 'discogs_release' | 'artist_proxy' | null.
 */

import { and, asc, eq, gte, isNotNull, lt } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import WxycError from '../utils/error.js';

export type BmiComposerSource = 'discogs_track' | 'discogs_release' | 'artist_proxy' | null;

/**
 * One played work as reported to BMI. Flat projection over the `flowsheet`
 * track rows in the requested window. `played_at` is the row's logging instant
 * (`flowsheet.add_time`) as an ISO-8601 string.
 */
export type BmiPerformanceRow = {
  artist_name: string;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  composer: string | null;
  composer_source: BmiComposerSource;
  played_at: string;
};

/** Composer-provenance breakdown for the dj-site pre-submit coverage preview. */
export type BmiCoverage = {
  total: number;
  real_track: number;
  real_release: number;
  artist_proxy: number;
  none: number;
};

/** The full endpoint payload: the echoed range, the coverage summary, the rows. */
export type BmiPerformanceList = {
  range: { from: string; to: string };
  coverage: BmiCoverage;
  rows: BmiPerformanceRow[];
};

/** A validated, half-open `[fromDate, toExclusive)` window over `add_time`. */
export type BmiDateRange = {
  from: string;
  to: string;
  fromDate: Date;
  toExclusive: Date;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Validate a single `YYYY-MM-DD` bound and return its UTC midnight instant.
 * Rejects non-strings, wrong shapes (timestamps, slashes), and impossible
 * calendar dates (e.g. `2026-02-30`, which `Date` would silently roll into
 * March) by round-tripping the parse back to the same string.
 */
function parseIsoDay(raw: unknown, field: string): Date {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new WxycError(`bmi-performance-list: '${field}' is required (YYYY-MM-DD)`, 400);
  }
  if (!ISO_DATE.test(raw)) {
    throw new WxycError(`bmi-performance-list: '${field}' must be an ISO date (YYYY-MM-DD), got '${raw}'`, 400);
  }
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new WxycError(`bmi-performance-list: '${field}' is not a valid date: '${raw}'`, 400);
  }
  const d = new Date(ms);
  // Reject rolled-over dates: `2026-02-30` parses to March 2, whose ISO date
  // slice no longer equals the input.
  if (d.toISOString().slice(0, 10) !== raw) {
    throw new WxycError(`bmi-performance-list: '${field}' is not a valid calendar date: '${raw}'`, 400);
  }
  return d;
}

/**
 * Parse and validate the `from`/`to` query params into an inclusive date
 * window, expressed as a half-open `[fromDate, toExclusive)` interval so the
 * whole `to` day is included. Both bounds are required; `from` must not be
 * after `to`. Boundaries are UTC-midnight — ET-vs-UTC alignment of the day
 * edges is a finalization detail deferred to #1507 alongside the wire format.
 */
export function parseBmiDateRange(fromRaw: unknown, toRaw: unknown): BmiDateRange {
  const fromDate = parseIsoDay(fromRaw, 'from');
  const toDate = parseIsoDay(toRaw, 'to');
  // parseIsoDay throws unless the input is a well-formed date string, so both
  // are strings here; narrow them for the return + message.
  const from = fromRaw as string;
  const to = toRaw as string;
  if (fromDate.getTime() > toDate.getTime()) {
    throw new WxycError(`bmi-performance-list: 'from' (${from}) must not be after 'to' (${to})`, 400);
  }
  return { from, to, fromDate, toExclusive: new Date(toDate.getTime() + MS_PER_DAY) };
}

/**
 * Explicit projection to exactly the BMI contract fields — not a passthrough —
 * so a server-only column on the source row (`search_doc`, `dj_name`,
 * `metadata_status`, …) can never leak into the librarian-facing export.
 */
export function projectBmiRow(raw: {
  artist_name: string;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  composer: string | null;
  composer_source: string | null;
  add_time: Date;
}): BmiPerformanceRow {
  return {
    artist_name: raw.artist_name,
    track_title: raw.track_title,
    album_title: raw.album_title,
    record_label: raw.record_label,
    composer: raw.composer,
    composer_source: raw.composer_source as BmiComposerSource,
    played_at: raw.add_time.toISOString(),
  };
}

/** Bucket rows by composer provenance for the dj-site pre-submit preview. */
export function summarizeCoverage(rows: BmiPerformanceRow[]): BmiCoverage {
  const coverage: BmiCoverage = { total: rows.length, real_track: 0, real_release: 0, artist_proxy: 0, none: 0 };
  for (const row of rows) {
    if (row.composer_source === 'discogs_track') coverage.real_track += 1;
    else if (row.composer_source === 'discogs_release') coverage.real_release += 1;
    else if (row.composer_source === 'artist_proxy') coverage.artist_proxy += 1;
    else coverage.none += 1;
  }
  return coverage;
}

/**
 * Read the played works in the window: `flowsheet` track rows with a non-null
 * artist, `add_time` inside `[fromDate, toExclusive)`, ordered chronologically.
 * `entry_type = 'track'` excludes breakpoints/talksets/marker rows; the
 * `artist_name IS NOT NULL` guard drops the handful of malformed track rows.
 * Read-only — no mutation, matching the `exportCatalog` read pattern.
 */
export async function getBmiPerformanceRows(range: BmiDateRange): Promise<BmiPerformanceRow[]> {
  const rows = await db
    .select({
      artist_name: flowsheet.artist_name,
      track_title: flowsheet.track_title,
      album_title: flowsheet.album_title,
      record_label: flowsheet.record_label,
      composer: flowsheet.composer,
      composer_source: flowsheet.composer_source,
      add_time: flowsheet.add_time,
    })
    .from(flowsheet)
    .where(
      and(
        eq(flowsheet.entry_type, 'track'),
        isNotNull(flowsheet.artist_name),
        gte(flowsheet.add_time, range.fromDate),
        lt(flowsheet.add_time, range.toExclusive)
      )
    )
    .orderBy(asc(flowsheet.add_time));

  // `artist_name` is guaranteed non-null by the WHERE; the cast narrows the
  // Drizzle column type (nullable varchar) to the projection's contract.
  return rows.map((r) => projectBmiRow({ ...r, artist_name: r.artist_name as string }));
}

/**
 * Compose the full endpoint payload for a validated range: query the rows and
 * attach the coverage summary. Kept thin so the controller stays a request
 * adapter.
 */
export async function getBmiPerformanceList(range: BmiDateRange): Promise<BmiPerformanceList> {
  const rows = await getBmiPerformanceRows(range);
  return {
    range: { from: range.from, to: range.to },
    coverage: summarizeCoverage(rows),
    rows,
  };
}
