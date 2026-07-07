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

import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import WxycError from '../utils/error.js';

/**
 * The composer-provenance values this shell knows how to bucket. `flowsheet.composer_source`
 * is deliberately open-ended `text` (schema.ts) — a new source (e.g. `musicbrainz_work`,
 * LML#699) can land without a migration — so a row can carry a value outside this set. Such a
 * value is preserved verbatim on the row (`BmiPerformanceRow.composer_source` is `string | null`)
 * and counted under `coverage.unknown` rather than silently mis-bucketed as `none`.
 */
export type BmiComposerSource = 'discogs_track' | 'discogs_release' | 'artist_proxy';

/**
 * One played work as reported to BMI. Flat projection over the `flowsheet`
 * track rows in the requested window. `played_at` is the row's logging instant
 * (`flowsheet.add_time`) as an ISO-8601 string. `composer_source` is the raw DB
 * text (an open-ended column), not narrowed to the known set — see `BmiComposerSource`.
 */
export type BmiPerformanceRow = {
  artist_name: string;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  composer: string | null;
  composer_source: string | null;
  played_at: string;
};

/**
 * Composer-provenance breakdown for the dj-site pre-submit coverage preview.
 * `none` counts rows with no composer credit at all (`composer_source IS NULL`);
 * `unknown` counts rows whose `composer_source` is non-null but outside the known
 * set — a real credit from a source this shell predates, kept distinct from `none`
 * so the preview never tells the librarian a credited play has no composer.
 * The five buckets partition `total`.
 */
export type BmiCoverage = {
  total: number;
  real_track: number;
  real_release: number;
  artist_proxy: number;
  none: number;
  unknown: number;
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

// Shape-only ISO-day guard. A byte-identical regex backs the weaker shape-only
// `isISODate` (library.service.ts); `parseIsoDay` below intentionally goes further,
// also rejecting impossible calendar dates via an ISO round-trip. Not consolidated
// here: reusing `isISODate` would drop the calendar-validity check, and promoting the
// stronger check into a shared util would change `killRotation`'s accepted inputs —
// out of scope for this shell.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Upper bound on the requested window width (inclusive day count). The librarian pulls
// semiannually (~184 days); a full leap year of headroom covers any legitimate pull while
// capping the result set. Without it a multi-year range would materialize the entire
// `flowsheet` track slice into memory and block the event loop on a synchronous
// `JSON.stringify` — a pod-wide stall / OOM risk (there is no LIMIT or streaming here,
// unlike the gzipped/watermarked `exportCatalog`). A hard 400 (vs silent truncation) keeps
// the royalty report from quietly dropping performances.
const MAX_RANGE_DAYS = 366;

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
  const widthDays = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY + 1;
  if (widthDays > MAX_RANGE_DAYS) {
    throw new WxycError(
      `bmi-performance-list: range ${from}..${to} spans ${widthDays} days; the maximum is ${MAX_RANGE_DAYS}. Narrow the window.`,
      400
    );
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
    // Raw passthrough — no cast to the known union. `composer_source` is open-ended
    // text; a value this shell predates is preserved verbatim, not asserted to be a
    // known member (which would be a TS lie) and not dropped.
    composer_source: raw.composer_source,
    played_at: raw.add_time.toISOString(),
  };
}

/**
 * Bucket rows by composer provenance for the dj-site pre-submit preview. A non-null
 * `composer_source` outside the known set (a source added after this shell, e.g.
 * `musicbrainz_work`) is counted under `unknown` — never folded into `none` (which would
 * tell the librarian a credited play has no composer) — and surfaced via a single warn so a
 * new provenance is noticed rather than silently miscounted.
 */
export function summarizeCoverage(rows: BmiPerformanceRow[]): BmiCoverage {
  const coverage: BmiCoverage = {
    total: rows.length,
    real_track: 0,
    real_release: 0,
    artist_proxy: 0,
    none: 0,
    unknown: 0,
  };
  const unknownSources = new Set<string>();
  for (const row of rows) {
    if (row.composer_source === null) coverage.none += 1;
    else if (row.composer_source === 'discogs_track') coverage.real_track += 1;
    else if (row.composer_source === 'discogs_release') coverage.real_release += 1;
    else if (row.composer_source === 'artist_proxy') coverage.artist_proxy += 1;
    else {
      coverage.unknown += 1;
      unknownSources.add(row.composer_source);
    }
  }
  if (unknownSources.size > 0) {
    console.warn(
      `bmi-performance-list: unrecognized composer_source value(s) counted as 'unknown': ${[...unknownSources].join(', ')}`
    );
  }
  return coverage;
}

/**
 * Read the played works in the window: `flowsheet` track rows with a usable
 * artist, `add_time` inside `[fromDate, toExclusive)`, ordered chronologically.
 * `entry_type = 'track'` excludes breakpoints/talksets/marker rows. The artist
 * guard drops malformed rows with no artist — both NULL and empty/whitespace-only,
 * since the live free-text insert path (flowsheet.controller.ts) only rejects an
 * absent `artist_name`, so a blank one is writable. Mirrors the stricter sibling
 * read `coalesce(artist_name,'') <> ''` (flowsheet.service.ts). Read-only — no
 * mutation, matching the `exportCatalog` read pattern.
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
        sql`coalesce(trim(${flowsheet.artist_name}), '') <> ''`,
        gte(flowsheet.add_time, range.fromDate),
        lt(flowsheet.add_time, range.toExclusive)
      )
    )
    .orderBy(asc(flowsheet.add_time));

  // `artist_name` is guaranteed non-null/non-blank by the WHERE; the cast narrows
  // the Drizzle column type (nullable varchar) to the projection's contract.
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
