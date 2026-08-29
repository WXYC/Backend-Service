import { Request, RequestHandler, Response } from 'express';
import { Mutex } from 'async-mutex';
import * as Sentry from '@sentry/node';
import { NewFSEntry as FullNewFSEntry, FSEntry, Show, ShowDJ } from '@wxyc/database';

// play_order is computed by the service layer, not provided by controllers
type NewFSEntry = Omit<FullNewFSEntry, 'play_order'>;
import * as flowsheet_service from '../services/flowsheet.service.js';
import type { ConcertDTO } from '../services/concerts.service.js';
import type { CriticReviewItem } from '@wxyc/shared/dtos';
import { projectFlowsheetEntry, toDiscogsUnavailableWireFields } from '../utils/flowsheet-projection.js';
import { getDiscogsUnavailableFlagsById } from '../services/library.service.js';
import { stashMirrorData } from '../middleware/legacy/mirror.middleware.js';
import { flowsheetMirror } from '../middleware/legacy/flowsheet.mirror.js';
import * as flowsheetTakeoverConfig from '../config/flowsheetTakeover.js';
import WxycError from '../utils/error.js';
import { INT4_MAX } from '../utils/constants.js';

export type QueryParams = {
  page?: string;
  limit?: string;
  start_id?: string;
  end_id?: string;
  shows_limit?: string;
};

export interface IFSEntryMetadata {
  artwork_url: string | null;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
  // album_metadata-only fields (BS#1441); no inline flowsheet column, so they
  // are not top-level IFSEntry fields — only here in the nested metadata view.
  genres: string[] | null;
  styles: string[] | null;
}

// search_doc is a STORED GENERATED tsvector used only by the search hot path
// (apps/backend/services/search.service.ts); the controller layer never reads
// or constructs it, so it is excluded from the application-facing entry type.
// `legacy_link_attempted_at` and `metadata_attempt_at` are job-internal
// markers consumed only by the broken-FK recovery and metadata backfill
// jobs respectively, so they're excluded from the controller-facing entry.
// `no_match_recheck_attempted_at` (migration 0151, BS#2176) joins them —
// it is consumed only by `jobs/flowsheet-no-match-recheck`'s own retry-TTL
// gate and carries no reader-facing meaning.
// `updated_at` (BS#902) is the row-level watermark consumed only by the
// conditional-GET middleware via `getLastModifiedAt`; it's never projected
// onto the wire format, so it stays out of IFSEntry alongside the other
// internal markers.
//
// `metadata_status` and `enriching_since` (BS#891) ARE surfaced to the
// controller layer because the V2 wire format projects metadata_status onto
// track rows for iOS branch logic (WXYC/wxyc-ios-64#270).
//
// `radio_hour` (migration 0103, BS#1448) IS surfaced (BS#1449): the read path
// projects it and transformToV2 emits it on breakpoint entries as the
// authoritative top-of-hour. It's a present-but-nullable property here.
//
// `composer` / `composer_source` (migration 0108, BS#1499) are write-only
// internal columns: the enrichment-worker writes them for the post-tubafrenzy
// BMI export-successor (#1500) to read directly off flowsheet rows. They are
// deliberately NOT projected onto the V2 wire format, so they're excluded here
// alongside the other internal markers.
//
// Sibling allow-list: the mutation/peek echoes project through
// CLIENT_FACING_FLOWSHEET_COLUMNS in ../utils/flowsheet-projection.ts (BS#1513).
// A new client-facing column must be added there too, or the POST/PATCH/DELETE
// echoes and the DJ peek won't carry it.
export interface IFSEntry extends Omit<
  FSEntry,
  | 'search_doc'
  | 'legacy_link_attempted_at'
  | 'metadata_attempt_at'
  | 'no_match_recheck_attempted_at'
  | 'updated_at'
  | 'composer'
  | 'composer_source'
> {
  label_id: number | null;
  rotation_bin: string | null;
  on_streaming: boolean | null;
  // BS#1908 (Not-on-Discogs epic #1280): MD-set discogs-unavailable flag +
  // note, sourced from the joined `library` row — NOT nested under `metadata`
  // (that object is the flowsheet/album_metadata COALESCE view; this pair is
  // library-only, same source as `on_streaming` above). `null` when the entry
  // has no library row (freeform/message/talkset/breakpoint, or an unlinked
  // track); `transformToV2` reads that nullability to distinguish "no library
  // row" (omit the wire field) from "library row, flag false" (emit `false`).
  discogs_unavailable: boolean | null;
  discogs_unavailable_note: string | null;
  metadata: IFSEntryMetadata;
  // Resolved catalog artist for the played release (flowsheet.album_id ->
  // library.artist_id). The batch key `attachUpcomingShows` uses to look up the
  // per-playcut `upcoming_show` (BS#1607), and since BS#1625 also projected
  // onto the V2 track wire shape as `artist_id`. NULL for free-form entries and
  // unresolved library rows.
  artist_id: number | null;
  // Per-playcut upcoming-show enrichment (BS#1607). Populated only on track
  // rows whose `artist_id` matched a curated, non-tombstoned, upcoming
  // concert; absent/undefined otherwise. `transformToV2` emits it as
  // `upcoming_show` on the V2 track wire shape (SSOT `FlowsheetV2TrackEntry`,
  // wxyc-shared api.yaml 1.16.0), reusing the `Concert` schema verbatim.
  upcoming_show?: ConcertDTO | null;
  // Batched critic-review snippets (album-critic-reviews slice, ADR 0012;
  // BS#1870), keyed strictly on this track's `album_id` — id-arm only, no
  // name-arm fuzzy match (unlike `upcoming_show`'s BS#1613 hybrid). Populated
  // only when `attachCriticReviews` found at least one seeded
  // `album_critic_reviews` row for the entry's `album_id`, and only when the
  // `CRITIC_REVIEWS_ENABLED` flag is on; absent/undefined otherwise.
  // `transformToV2` emits it as `critic_reviews` on the V2 track wire shape,
  // reusing the generated `CriticReviewItem` from `@wxyc/shared` verbatim.
  critic_reviews?: CriticReviewItem[];
}

const MAX_ITEMS = 200;
const DELETION_OFFSET = 10; //This offsets the ID's not representing the actual number of tracks due to deletions

/**
 * Widest window `GET /flowsheet/range` will serve (BS#2062).
 *
 * The route is public and unauthenticated over a 2.6M-row table, and the
 * response is UNPAGINATED, so this bounds the row count — and therefore the
 * response size — not merely the time span. Month- and year-scale analytical
 * reads are explicitly not this endpoint's job.
 *
 * 8 days rather than exactly 7 covers both real consumers (24h for the
 * `archive` daily playlist, 7d for the wxyc.org historical-archive page) with
 * a day of slack. The slack is load-bearing, not padding: a calendar week
 * spanning the autumn DST transition is 7d + 1h, and an exact-7d ceiling
 * would 400 it.
 */
export const MAX_RANGE_MS = 8 * 24 * 60 * 60 * 1000;

// The epoch-ms window whose `Date` renders as a four-digit-year ISO string.
//
// The bound that matters is NOT the JS Date range (±8.64e15): Drizzle maps a
// timestamp param to the driver with `value.toISOString()`, which switches to
// the expanded-year form outside years 0000–9999 — `new Date(8.64e15)` is
// `'+275760-09-13T00:00:00.000Z'`. Postgres cannot parse that literal, so the
// query throws and this public read answers 500. These two constants are the
// exact instants where `toISOString()` flips form (verified: MIN-1 renders
// `-000001-…`, MAX+1 renders `+010000-…`), which is ~34x tighter than the Date
// range and still far wider than any flowsheet window. Same class of guard as
// `INT4_MAX` (imported above), for a different overflow.
const MIN_EPOCH_MS = -62167219200000; // 0000-01-01T00:00:00.000Z
const MAX_EPOCH_MS = 253402300799999; // 9999-12-31T23:59:59.999Z
// BS#1960 cost/DoS guard on `page * limit` (the OFFSET passed to
// getEntriesByPage). This is not a correctness bound — it's a ceiling on how
// much index-scanning a single request can ask for. A genuine deep-history
// pull (further back than a UI paginator would ever click) should use the
// start_id/end_id range path above, which is a true index range scan
// regardless of depth.
//
// BS#2133 (parent #2118): lowered from 50,000 to 20,000. getEntriesByPage's
// ORDER BY changed from `id DESC` to `add_time DESC, id DESC` (see that
// function's comment) so a historical insert can't sort as the newest
// content — but the new ordering can no longer use an index-ONLY scan
// (there is no composite `(add_time DESC, id DESC)` index; see below), so it
// pays a heap fetch per scanned row instead of a bare PK scan. That shape
// falls off a measured CACHE CLIFF, not a curve, between offset 20,000 and
// 30,000 — prod EXPLAIN (ANALYZE, BUFFERS), warm, three passes:
//
//   offset 20,000:     17.8 ms
//   offset 30,000:  3,570.9 ms  (188x)
//   offset 50,000: 11,739.2 ms  (472x — past DB_STATEMENT_TIMEOUT_MS's 5s)
//
// 20,000 is the LAST GOOD SAMPLE, not a point measured to sit comfortably
// inside the good region — the next sample, 30,000, is already 188x. Nothing
// between the two was measured, so this bound is EMPIRICAL AND
// CACHE-STATE-DEPENDENT, not a derived constant: re-measure before ever
// moving it in either direction, do not interpolate or extrapolate from this
// comment. 20,000 does clear the page=50/limit=100 = 5,000 acceptance floor
// pinned by flowsheet-deep-pagination.spec.js with real headroom (4x) at
// negligible extra cost (17.8ms vs 7.7ms warm) — the previous "10x the
// acceptance floor" justification for 50,000 is superseded by this
// measurement and must not be used to raise the cap back. 5,000 (the floor
// itself) was considered and rejected as the cap: it would leave zero
// headroom and put that spec's own acceptance case exactly on the
// offset > MAX_OFFSET boundary.
//
// The number that actually bounds what ships is COLD, not warm — full
// three-pass cold->warm sequences (ms), prod, posted in full on #2133:
//
//   offset 20,000 (new cap): current 784, 8, 11   | proposed  852, 22, 18
//   offset 50,000 (old cap): current 4447, 31, 25 | proposed 10261, 14708, 11739
//
// Proposed-shape COLD at the NEW 20,000 cap is 852 ms against the 5s
// DB_STATEMENT_TIMEOUT_MS — worse than the current shape's 784 ms cold at
// that same offset, but this PR also lowers the cap: what actually SHIPS
// (proposed ordering, new 20,000 cap, 852 ms cold) beats what shipped before
// (current ordering, old 50,000 cap, 4,447 ms cold) by a wide margin. This
// change is a net improvement on the worst case being shipped, not merely a
// neutral one. At and below 20,000 the proposed shape also converges on
// repetition (852 -> 22 -> 18, a healthy cache warm-up); at 30,000+ it
// diverges instead (e.g. 40,000: 6446 -> 8604 -> 11120, getting WORSE with
// repetition) — the cliff shows up in the shape of the sequence, not only
// in the magnitude.
//
// A composite `(add_time DESC, id DESC)` index would restore an index-only
// scan at any depth (~78 MB measured on a 2.6M-row stand-in) and was
// considered and REJECTED in favor of lowering this cap: lowering the cap is
// one line and zero storage, against a table epic #1058 is actively trying
// to slim, and this cap is explicitly a cost ceiling rather than a
// correctness bound in the first place. Do not add that index on the
// strength of this comment alone — if the cap ever needs to go back up,
// that trade needs to be re-measured, not assumed.
const MAX_OFFSET = 20_000;

/**
 * Project a page of flowsheet entries to their V2 wire shape, tolerating — but
 * not hiding — a transient nullish array element (Sentry BACKEND-SERVICE-2T /
 * BS#1864). Every producer feeds this a dense `.map(transformToIFSEntry)`
 * array, so a nullish slot is an unexplained anomaly: we drop it rather than
 * 500 a public read path (`transformToV2` dereferences `.entry_type`
 * unguarded), but capture it to Sentry so the producer defect stays
 * diagnosable instead of silently vanishing from the feed. The 500 was the
 * only signal that surfaced this in the first place; swallowing it wholesale
 * would leave a recurrence invisible.
 *
 * This is the single choke point shared by every list read path
 * (`getEntries`'s three branches + `getShowInfo`); guarding here rather than
 * inside `transformToV2` keeps the single-entry callers' wire shape untouched.
 */
const projectEntriesV2 = (entries: IFSEntry[]): Record<string, unknown>[] => {
  const dense = entries.filter(Boolean);
  const dropped = entries.length - dense.length;
  if (dropped > 0) {
    Sentry.captureException(
      new Error(
        `Dropped ${dropped} nullish flowsheet ${dropped === 1 ? 'entry' : 'entries'} before V2 projection (BS#1864)`
      )
    );
  }
  return dense.map(flowsheet_service.transformToV2);
};

/**
 * A plain, optionally-negative run of decimal digits and nothing else.
 *
 * `Number()` alone is too permissive to implement "is this an epoch": it
 * accepts radix prefixes (`Number('0x1E240') === 123456`), surrounding
 * whitespace, a leading `+`, and exponent notation, every one of which would
 * be served as a plausible-looking window rather than rejected. Testing the
 * raw string first makes the accepted set exactly the documented one.
 */
const EPOCH_MS_PATTERN = /^-?\d+$/;

/**
 * Parse an epoch-milliseconds query param strictly.
 *
 * Returns `null` for anything that is not a plain decimal integer inside the
 * storable range — a float, a radix prefix, surrounding whitespace, trailing
 * garbage, an empty value, or (per Express's query parser, below) a repeated
 * key. `Number()` rather than `parseInt` for the final conversion: `parseInt`
 * silently truncates, yielding 1 from `'1.5e0'` and 2026 from `'2026-06-01'`,
 * which would coerce a malformed window into a plausible one instead of a 400.
 *
 * `raw` is typed `unknown` deliberately. Express 5's default ('simple') query
 * parser returns an ARRAY when a key is repeated — `?start=1&start=2` yields
 * `['1','2']` — so the handler's declared `string | undefined` is a lie the
 * type system cannot catch at the boundary. Calling a string method on that
 * array throws, and inside an async handler the rejection reaches
 * `errorHandler` as a 500 plus a Sentry capture, on a route that is both
 * unauthenticated and unratelimited. Narrowing here turns that into the 400
 * the contract already specifies.
 */
const parseEpochMillis = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !EPOCH_MS_PATTERN.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_EPOCH_MS || value > MAX_EPOCH_MS) return null;
  return value;
};

/**
 * GET /flowsheet/range?start=&end= — public, date-windowed flowsheet read.
 *
 * The successor to tubafrenzy's `GET /playlists/dailyEntries`, which the
 * `archive` app reads today and which dies at the 2026-08-31 cutover
 * (WXYC/wiki#91 Phase 4). Contract: `wxyc-shared/api.yaml` `/flowsheet/range`.
 *
 * `start` / `end` are epoch **milliseconds**, matching the `dayStart`
 * convention `archive` already computes, and the window is half-open
 * `[start, end)` on each entry's `add_time` so adjacent windows never
 * double-count a row.
 *
 * One consequence worth knowing rather than discovering: `add_time` is when a
 * row was *logged*, and a breakpoint row is logged ~a minute BEFORE the hour
 * it marks (its true hour is `radio_hour`). An hour-aligned window therefore
 * reports each hour's breakpoint in the previous window. That is the
 * off-by-one-hour class BS#1448 / BS#1449 fixed at the rendering layer;
 * consumers drawing hour markers key on `radio_hour`, not on arrival window.
 *
 * Validation returns 400 with `{ message }` directly rather than throwing
 * `WxycError` — matching `searchFlowsheetEndpoint`, the other public
 * unauthenticated read on this router, so the two public surfaces answer a bad
 * query the same way.
 *
 * No `attachUpcomingShows` / `attachCriticReviews`: those enrich the live
 * flowsheet UI, are absent from this endpoint's contract, and would add two
 * batched queries per request to a historical read that does not display them.
 */
export const getEntriesInRange: RequestHandler<object, unknown, unknown, { start?: string; end?: string }> = async (
  req,
  res,
  next
) => {
  const start = parseEpochMillis(req.query.start);
  if (start === null) {
    res.status(400).json({ message: 'start must be an integer number of epoch milliseconds' });
    return;
  }

  const end = parseEpochMillis(req.query.end);
  if (end === null) {
    res.status(400).json({ message: 'end must be an integer number of epoch milliseconds' });
    return;
  }

  // Strictly greater: the window is half-open, so end === start is empty by
  // construction and far more likely a caller bug than a real request.
  if (end <= start) {
    res.status(400).json({ message: 'end must be strictly greater than start' });
    return;
  }

  if (end - start > MAX_RANGE_MS) {
    res.status(400).json({
      message: `window must not exceed ${MAX_RANGE_MS / (24 * 60 * 60 * 1000)} days`,
    });
    return;
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  try {
    // Independent reads over the same window; no ordering dependency between
    // them, so pay one round trip instead of two.
    const [entries, shows] = await Promise.all([
      flowsheet_service.getEntriesInTimeWindow(startDate, endDate),
      flowsheet_service.getShowsInTimeWindow(startDate, endDate),
    ]);

    // An empty window is a normal result, never a 404 — the contract says so
    // explicitly, and the two consumers render "no shows that day" rather than
    // treating it as an error (contrast getEntries' legacy 404 branches).
    res.status(200).json({ shows, entries: projectEntriesV2(entries) });
  } catch (error) {
    next(error);
  }
};

export const getEntries: RequestHandler<object, unknown, object, QueryParams> = async (req, res) => {
  const { query } = req;

  const page = parseInt(query.page ?? '0');
  const limit = parseInt(query.limit ?? '30');

  if (query.shows_limit !== undefined) {
    const numberOfShows = parseInt(query.shows_limit);
    if (isNaN(numberOfShows) || numberOfShows < 1) {
      throw new WxycError('shows_limit must be a positive number', 400);
    }
    const recentShows = await flowsheet_service.getNShows(numberOfShows, page);
    const entries = await flowsheet_service.getEntriesByShow(...recentShows.map((show) => show.id));

    if (entries.length) {
      // The two attaches are independent (they set different, disjoint
      // fields on each entry), so run them concurrently rather than
      // serializing two DB round trips.
      await Promise.all([
        flowsheet_service.attachUpcomingShows(entries),
        flowsheet_service.attachCriticReviews(entries),
      ]);
      res.status(200).json(projectEntriesV2(entries));
    } else {
      res.status(404).json({
        message: 'No Tracks found',
      });
    }
    return;
  }

  if (query.start_id !== undefined && query.end_id !== undefined) {
    const startId = parseInt(query.start_id);
    const endId = parseInt(query.end_id);
    if (!Number.isInteger(startId)) {
      throw new WxycError('start_id must be a valid integer', 400);
    }
    if (!Number.isInteger(endId)) {
      throw new WxycError('end_id must be a valid integer', 400);
    }
    // BS#1800: a value that parses as a valid JS integer can still exceed the
    // flowsheet.id int4 column's range (e.g. start_id=2200000000), which
    // Number.isInteger alone doesn't catch. Reject before it reaches Postgres.
    if (startId < 0 || startId > INT4_MAX) {
      throw new WxycError('start_id must be within the valid integer range', 400);
    }
    if (endId < 0 || endId > INT4_MAX) {
      throw new WxycError('end_id must be within the valid integer range', 400);
    }
    // end_id < start_id would compute a negative-length range; reject rather
    // than silently returning an empty/inverted result from getEntriesByRange.
    if (endId < startId) {
      throw new WxycError('end_id must not be less than start_id', 400);
    }
    if (endId - startId - DELETION_OFFSET > MAX_ITEMS) {
      throw new WxycError('Requested too many entries', 400);
    }
    const entries = await flowsheet_service.getEntriesByRange(startId, endId);
    if (entries.length) {
      await Promise.all([
        flowsheet_service.attachUpcomingShows(entries),
        flowsheet_service.attachCriticReviews(entries),
      ]);
      res.status(200).json(projectEntriesV2(entries));
    } else {
      res.status(404).json({ message: 'No Tracks found' });
    }
    return;
  }

  // Default: paginated entries with discriminated union format
  if (isNaN(limit) || limit < 1) throw new WxycError('limit must be a positive number', 400);
  if (limit > MAX_ITEMS) throw new WxycError('Requested too many entries', 400);
  if (isNaN(page) || page < 0) throw new WxycError('page must be a non-negative number', 400);

  const offset = page * limit;
  // BS#1960: reject an out-of-envelope page depth before it reaches the
  // query, rather than letting a client walk arbitrarily deep pages. See
  // MAX_OFFSET above for the cap rationale.
  if (offset > MAX_OFFSET) {
    throw new WxycError('Requested page depth too large', 400);
  }
  const [entries, total, onAirDjName] = await Promise.all([
    flowsheet_service.getEntriesByPage(offset, limit),
    flowsheet_service.getEntryCount(),
    // Best-effort: the on-air banner is auxiliary, so a failure resolving it must
    // not fail the whole flowsheet read. On error we report to Sentry and return
    // `undefined`, which omits `on_air` below — clients decode an absent field as
    // "unknown" and hide the banner, rather than the endpoint 500ing the playlist.
    flowsheet_service.getOnAirDJName().catch((error: unknown) => {
      Sentry.captureException(error);
      return undefined;
    }),
  ]);

  // Attach the per-playcut upcoming-show enrichment (BS#1607) and the
  // batched critic-review snippets (BS#1870) before projecting to V2 — one
  // batched concerts query plus one batched (flag-gated) reviews query for
  // the whole page. Independent attaches, so run concurrently.
  await Promise.all([flowsheet_service.attachUpcomingShows(entries), flowsheet_service.attachCriticReviews(entries)]);

  // BS#1960 note: totalPages is derived from the full row estimate, so it can
  // advertise more pages than MAX_OFFSET actually permits (e.g. ~26k pages at
  // limit=100 against a ~2.6M-row table, while offset is capped at 20k / page
  // 200 — BS#2133). A client that lets a user jump past the cap gets an
  // explicit 400 rather than the old timeout-500; genuine deep-history reads
  // belong on the start_id/end_id range path. Left unclamped deliberately —
  // totalPages stays an honest "how many pages of data exist" for the
  // "Page X of N" display.
  const totalPages = Math.ceil(total / limit);

  // `on_air` lets clients render the on-air banner without scanning the fetched
  // entry window for a show_start marker (which can fall outside a 30-entry
  // page). Three states, matching wxyc-shared api.yaml FlowsheetV2PaginatedResponse:
  // an OnAirInfo object = a human is live (a resolved DJ handle, or the "WXYC"
  // station brand when the open show has no resolvable name — see
  // getOnAirDJName); `null` = confirmed automation; the field ABSENT = the banner
  // query failed (unknown). Only the default paginated branch carries it — the
  // iOS app polls this branch.
  //
  // Freshness note: this route is wrapped in conditionalGet(getLastModifiedAt),
  // which 304s on the flowsheet watermark. A rare `on_air` change that writes no
  // flowsheet row (e.g. a mid-show dj_name_override edit) can be masked behind a
  // stale 304 until the next flowsheet mutation.
  res.status(200).json({
    entries: projectEntriesV2(entries),
    total,
    page,
    limit,
    totalPages,
    ...(onAirDjName !== undefined && { on_air: onAirDjName ? { dj_name: onAirDjName } : null }),
  });
};

export const getLatest: RequestHandler = async (req, res) => {
  const entries = await flowsheet_service.getEntriesByPage(0, 1);
  // `entries[0]` truthy-checked rather than `entries.length`: a transient
  // nullish element (Sentry BACKEND-SERVICE-2T / BS#1864) must degrade to the
  // same 204 the empty-array case already returns, not throw on transformToV2.
  const entry = entries[0];
  if (entry) {
    await Promise.all([flowsheet_service.attachUpcomingShows(entries), flowsheet_service.attachCriticReviews(entries)]);
    res.status(200).json(flowsheet_service.transformToV2(entry));
  } else {
    // A non-empty page whose head is nullish is the same unexplained anomaly
    // projectEntriesV2 captures on the list paths — surface it here too rather
    // than letting it hide behind an ordinary empty-flowsheet 204.
    if (entries.length > 0) {
      Sentry.captureException(new Error('Dropped a nullish flowsheet head entry before V2 projection (BS#1864)'));
    }
    res.status(204).end();
  }
};

/**
 * Infer the entry_type from the message content, matching the
 * discriminated union in wxyc-shared's FlowsheetEntryType.
 */
function inferMessageEntryType(message: string | undefined): NewFSEntry['entry_type'] {
  if (message?.includes('Talkset')) return 'talkset';
  if (message?.includes('Breakpoint')) return 'breakpoint';
  return 'message';
}

export type FSEntryRequestBody = {
  artist_name: string;
  album_title: string;
  track_title: string;
  // Discogs `release_track.position` for the chosen track when the dj-site
  // flowsheet picker (E6-6) selected one off a release; NULL/undefined for
  // free-text entries and message rows. Schema in BS#835 / migration 0076.
  track_position?: string | null;
  album_id?: number;
  rotation_id?: number;
  record_label: string;
  label_id?: number;
  request_flag?: boolean;
  segue?: boolean;
  message?: string;
  entry_type?: NewFSEntry['entry_type'];
};

/**
 * Shared egress for the flowsheet mutation echoes (BS#1513 / PR #1532): stash
 * the UNPROJECTED row for the legacy mirror middleware — whose BS#908 loop
 * guards read `legacy_entry_id`, a column the client projection strips — then
 * send the client-facing projection. Keeping the pair in one call means a new
 * mutation site can't pick up the projection without the stash. The stash is
 * inert on routes with no mirror middleware attached (changeOrder today) and
 * becomes load-bearing automatically if one is wired up.
 *
 * BS#1962: when the entry has a non-null `album_id`, additionally merges
 * `discogsUnavailable` / `discogsUnavailableNote` onto the projected body —
 * parity with the paginated read path's `transformToV2` (#1908) and the SSE
 * feeder (`metadata-broadcast.ts`). The lookup is a single, uncached,
 * freshest-wins direct read: mutations are DJ-paced and single-row, so there's
 * no N+1 concern here (contrast the SSE hot path's LRU + coalescing, needed
 * because a backfill burst can replay many terminal broadcasts for the same
 * album_id in a short window). Additive-failure (mirrors the proxy path,
 * `proxy.controller.ts`'s `getDiscogsUnavailableFlagsById` call site): a DB
 * blip on this read degrades to omitting the fields, never 500s the mutation.
 */
const sendProjectedEntry = async (res: Response, statusCode: number, entry: FSEntry): Promise<void> => {
  stashMirrorData(res, entry);
  const projected = projectFlowsheetEntry(entry);
  if (entry.album_id != null) {
    try {
      const flags = await getDiscogsUnavailableFlagsById(entry.album_id);
      Object.assign(projected, toDiscogsUnavailableWireFields(flags));
    } catch (err) {
      console.warn(
        `[flowsheet.controller] discogs-unavailable lookup failed for album_id=${entry.album_id}; omitting field:`,
        err
      );
    }
  }
  res.status(statusCode).json(projected);
};

/**
 * Build a track row from the request's own snapshot fields, with
 * `album_id: null`. Shared by both routes that land here: an explicit
 * `album_id: null` (BS#933) and a positive `album_id` that misses in
 * `library` (BS#1680 — library linkage is an enrichment annotation, not a
 * precondition for recording the play; see the not-found branch above).
 */
function buildSnapshotFieldsEntry(body: FSEntryRequestBody, show_id: number, dj_name: string | null): NewFSEntry {
  if (body.album_title === undefined || body.artist_name === undefined || body.track_title === undefined) {
    throw new WxycError('Bad Request, Missing Flowsheet Parameters: album_title, artist_name, track_title', 400);
  }
  // Explicit allowlist instead of `...body` spread (BS#1099). Any other body
  // key — `metadata_status`, `legacy_entry_id`, `play_order`, etc. — would
  // otherwise propagate verbatim into the INSERT and let a flowsheet:write
  // caller mutate server-internal columns.
  return {
    artist_name: body.artist_name,
    album_title: body.album_title,
    track_title: body.track_title,
    track_position: body.track_position ?? null,
    record_label: body.record_label,
    label_id: body.label_id,
    album_id: null,
    rotation_id: body.rotation_id,
    request_flag: body.request_flag,
    segue: body.segue ?? false,
    message: body.message,
    entry_type: body.entry_type,
    show_id,
    dj_name,
  };
}

// either an id is provided (meaning it came from the user's bin or was fuzzy found)
// or it's not provided in which case whe just throw the data provided into the table w/ album_id = NULL
export const addEntry: RequestHandler = async (req: Request<object, object, FSEntryRequestBody>, res) => {
  const { body } = req;
  const latestShow = await flowsheet_service.getLatestShow();
  if (latestShow?.end_time !== null) {
    throw new WxycError('Bad Request, There are no active shows', 400);
  }

  // Resolved once per request and denormalized onto every new flowsheet row
  // (step 5b.2). Mirrors the search service's DJ_NAME_EXPR so the search hot
  // path can read flowsheet.dj_name directly without joining shows -> auth_user.
  const dj_name = await flowsheet_service.resolveDjNameForShow(latestShow);

  if (body.message !== undefined) {
    //we're just throwing the message in there (whatever it may be): dj join event, psa event, talk set event, break-point
    const fsEntry: NewFSEntry = {
      artist_name: '',
      album_title: '',
      track_title: '',
      entry_type: body.entry_type ?? inferMessageEntryType(body.message),
      message: body.message,
      show_id: latestShow.id,
      dj_name,
    };
    const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
    await sendProjectedEntry(res, 201, completedEntry);
    return;
  }

  // no message passed, so we assume we're adding a track to the flowsheet
  if (body.track_title === undefined) {
    throw new WxycError('Bad Request, Missing query parameter: track_title', 400);
  }

  // Use `!= null` rather than `!== undefined` so an explicit `album_id: null`
  // (sent by dj-site when the user picks a rotation row whose source has
  // `album_id IS NULL` — BS#689 surfaced 147 such rows) falls through to the
  // snapshot-fields branch below. The `!= null` predicate matches both `null`
  // and `undefined`; only an actual library id enters the lookup branch.
  // See BS#933.
  if (body.album_id != null) {
    //backfill album info from library before adding to flowsheet
    const albumInfo = await flowsheet_service.getAlbumFromDB(body.album_id);

    // `getAlbumFromDB` returns undefined when `body.album_id` points to a row
    // that doesn't exist in `library` — possible when the dj-site picker
    // payload references a library row that's been deleted, or when a
    // rotation→library FK has desynced. BS#933 covered the explicit-null
    // case; this guards the equally-reachable not-found case. BS#1271 turned
    // the bare TypeError (from the following `albumInfo.record_label = ...` /
    // `...albumInfo` spread) into a clean signal, but rejecting the whole
    // entry was the wrong disposition: library linkage is an enrichment
    // annotation, not a precondition for recording the play. BS#1680 falls
    // through to the same snapshot-fields path used for an explicit
    // `album_id: null`, keeping the DJ's play recorded with `album_id: null`,
    // and logs a Sentry warning so the desync stays visible for data-hygiene
    // follow-up — the same asymmetric-fallback philosophy as the LML-timeout
    // degrade (BS#873) and the nameless-DJ marker suppression (epic #1288).
    if (!albumInfo) {
      // Build first so a missing snapshot field's 400 throws before we ever
      // claim we degraded — buildSnapshotFieldsEntry validates album_title /
      // artist_name / track_title and throws on the reject path (BS#1680
      // review: the Sentry warning must not fire when the entry was rejected,
      // not recorded).
      const fsEntry = buildSnapshotFieldsEntry(body, latestShow.id, dj_name);
      Sentry.captureMessage('Flowsheet album_id not found in library — degrading to snapshot fields', {
        level: 'warning',
        tags: { tool: 'flowsheet' },
        extra: { album_id: body.album_id, show_id: latestShow.id },
      });
      const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
      await sendProjectedEntry(res, 201, completedEntry);
      return;
    }

    if (body.record_label !== undefined) {
      albumInfo.record_label = body.record_label;
    }

    const fsEntry: NewFSEntry = {
      album_id: body.album_id,
      ...albumInfo,
      track_title: body.track_title,
      track_position: body.track_position ?? null,
      rotation_id: body.rotation_id,
      request_flag: body.request_flag,
      segue: body.segue ?? false,
      show_id: latestShow.id,
      dj_name,
    };

    const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
    await sendProjectedEntry(res, 201, completedEntry);
  } else {
    // No album_id (explicit null from the dj-site rotation snapshot, BS#933,
    // or simply omitted): insert the request's own snapshot fields with
    // album_id: null. Shares `buildSnapshotFieldsEntry` with the lookup-miss
    // fallback above (BS#1680) so both routes into this shape stay identical.
    const fsEntry = buildSnapshotFieldsEntry(body, latestShow.id, dj_name);
    const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
    await sendProjectedEntry(res, 201, completedEntry);
  }
};

export const deleteEntry: RequestHandler<object, unknown, { entry_id: number }> = async (req, res) => {
  const { entry_id } = req.body;
  if (entry_id === undefined) {
    throw new WxycError('Bad Request, Missing entry identifier: entry_id', 400);
  }

  const removedEntry = await flowsheet_service.removeTrack(entry_id);
  // `.returning()` matched no row (double delete / already-gone id). Pre-#1532
  // this serialized as a misleading 200-with-empty-body; projecting undefined
  // would be a bare TypeError -> 500 (the BS#1271 class). 404 is the honest
  // answer, matching changeOrder's existing missing-row behavior.
  if (!removedEntry) {
    throw new WxycError(`Flowsheet entry ${entry_id} not found`, 404);
  }
  await sendProjectedEntry(res, 200, removedEntry);
};

export type UpdateRequestBody = {
  artist_name?: string;
  album_title?: string;
  track_title?: string;
  // Discogs `release_track.position` updates when the picker is used in edit
  // mode on an existing row. Service `updateEntry` does a passthrough
  // `db.update(flowsheet).set(data)` so widening this type is the entire
  // wiring. Schema in BS#835 / migration 0076.
  track_position?: string | null;
  record_label?: string;
  label_id?: number;
  // First-class FKs the dj-site rotation/library pickers legitimately write
  // (BS#1270). Not "internal columns"; the BS#1099 allowlist initially
  // omitted them which silently stripped picker writes.
  album_id?: number;
  rotation_id?: number;
  request_flag?: boolean;
  segue?: boolean;
  message?: string;
};

/**
 * Pick only the fields the client is allowed to write through the public
 * PATCH /flowsheet endpoint (BS#1099). The service-layer `updateEntry` does
 * a passthrough `.set(entry)`, so any extra keys (`metadata_status`,
 * `legacy_entry_id`, `show_id`, `play_order`, `linkage_*`, etc.) would land
 * on the row. We allowlist at the controller boundary; the service also
 * picks again for defense in depth.
 */
function pickUpdateEntryFields(data: UpdateRequestBody): UpdateRequestBody {
  const picked: UpdateRequestBody = {};
  if (data.artist_name !== undefined) picked.artist_name = data.artist_name;
  if (data.album_title !== undefined) picked.album_title = data.album_title;
  if (data.track_title !== undefined) picked.track_title = data.track_title;
  if (data.track_position !== undefined) picked.track_position = data.track_position;
  if (data.record_label !== undefined) picked.record_label = data.record_label;
  if (data.label_id !== undefined) picked.label_id = data.label_id;
  if (data.album_id !== undefined) picked.album_id = data.album_id;
  if (data.rotation_id !== undefined) picked.rotation_id = data.rotation_id;
  if (data.request_flag !== undefined) picked.request_flag = data.request_flag;
  if (data.segue !== undefined) picked.segue = data.segue;
  if (data.message !== undefined) picked.message = data.message;
  return picked;
}

export const updateEntry: RequestHandler<object, unknown, { entry_id: number; data: UpdateRequestBody }> = async (
  req,
  res
) => {
  const { entry_id, data } = req.body;
  if (entry_id === undefined) {
    throw new WxycError('Bad Request, Missing entry identifier: entry_id', 400);
  }

  const picked = pickUpdateEntryFields(data ?? {});
  // An empty (or fully-filtered) patch would reach drizzle's `.set({})`,
  // which throws `No values to set` — a 500 for what is a malformed request.
  if (Object.keys(picked).length === 0) {
    throw new WxycError('Bad Request, No updatable fields provided in: data', 400);
  }

  const updatedEntry = await flowsheet_service.updateEntry(entry_id, picked);
  // UPDATE matched no row (entry deleted out from under the edit). See the
  // 404 rationale on deleteEntry above.
  if (!updatedEntry) {
    throw new WxycError(`Flowsheet entry ${entry_id} not found`, 404);
  }
  await sendProjectedEntry(res, 200, updatedEntry);
};

export type JoinRequestBody = {
  dj_id: string;
  show_name?: string;
  specialty_id?: number;
  /**
   * Optional per-show display-name override (BS#1295, epic #1288). When
   * non-empty after trim, takes priority over `auth_user.dj_name` for the
   * show_start marker, `flowsheet.dj_name`, and `shows.dj_name_override`.
   * Capped at 255 chars to match the `auth_user.dj_name` column. Only
   * honored on the new-show path; ignored on the co-host /join path
   * (`addDJToShow`) because there's no per-co-host override surface today.
   */
  dj_name_override?: string;
  /**
   * What the caller means when a show they are not already an active member of
   * is still open (BS#2233). Consulted ONLY in that case — the guards above it
   * (an already-closed show, a terminal `show_end` marker, an existing active
   * membership) all resolve first and never reach this field.
   */
  intent?: JoinIntent;
  /**
   * The `shows.id` a `takeover` intends to close, echoed from the 409's
   * `details.show.id`. Compare-and-set: see `joinShow`.
   */
  expected_show_id?: number;
};

/**
 * The two things a caller can mean by "Go Live" while somebody else's show is
 * open. Absence is a THIRD state and deliberately not a member of this union:
 * it means the caller never chose, and the answer to that is the 409, not a
 * default. See `apps/backend/config/flowsheetTakeover.ts`.
 */
export type JoinIntent = 'join' | 'takeover';

const JOIN_INTENTS: readonly JoinIntent[] = ['join', 'takeover'];

/**
 * Narrow an UNVALIDATED request-body value to {@link JoinIntent}.
 *
 * Takes `unknown` on purpose. `JoinRequestBody.intent` is a declaration about
 * what clients are meant to send, not a fact about what arrived — nothing
 * validates this route's body — so reading it at its declared type makes
 * TypeScript narrow to `JoinIntent` and treat the membership check below as a
 * comparison that cannot fail. It very much can, and if it is ever deleted on
 * that reasoning `intent: "nonsense"` stops being a 400 and falls through to
 * the TAKEOVER branch, ending a live DJ's show on a typo. Routing the value
 * through `unknown` keeps the guard honest and the narrowing real.
 */
const isJoinIntent = (value: unknown): value is JoinIntent => (JOIN_INTENTS as readonly unknown[]).includes(value);

/**
 * The 409 a `POST /flowsheet/join` answers with when a show the caller does not
 * belong to is genuinely open and they said nothing about what to do.
 *
 * `dj_name` resolves through the SHARED chain (`dj_name_override` → the linked
 * account's handle → `legacy_dj_name`) rather than a hand-joined `auth_user`
 * read, so the prompt names the show the same way every other show-scoped
 * surface does and cannot drift from them as the chain evolves.
 *
 * It does NOT necessarily match the on-air banner, and must not be "fixed" to.
 * `getOnAirDJName` deliberately departs from this chain in one case (an open
 * show with no override and no `primary_dj_id` but an active `show_djs`
 * member), so on exactly the abandoned shows this 409 fires for, the banner
 * names whoever is at the controls while this names the show's owner. Both are
 * right, because they answer different questions — see below.
 *
 * Note what that name means: it is the show's OWNER, which for an abandoned
 * show is the DJ who left, not whoever is at the controls. That is the right
 * answer to "whose show am I being asked about", and the wrong answer to "who
 * is on air" — a client rendering the latter reads `GET /flowsheet/djs-on-air`.
 * The spec's 409 description says so explicitly.
 */
const showAlreadyOpenError = async (show: Show): Promise<WxycError> =>
  new WxycError('A show is already on air', 409, {
    code: 'show_already_open',
    details: {
      show: {
        id: show.id,
        dj_name: await flowsheet_service.resolveDjNameForShow(show),
        start_time: show.start_time,
      },
    },
  });

/**
 * Maximum length of `dj_name_override`. Absolute ceiling matching both the
 * `auth_user.dj_name` and `shows.dj_name_override` varchar(255) columns.
 */
const DJ_NAME_OVERRIDE_MAX_LENGTH = 255;

//POST
export const joinShow: RequestHandler = async (req: Request<object, object, JoinRequestBody>, res) => {
  const current_show = await flowsheet_service.getLatestShow();
  if (req.body.dj_id === undefined) {
    throw new WxycError('Bad Request, Must include a dj_id to join show', 400);
  }

  // Cross-check body.dj_id against the authenticated user (BS#1098). Pre-fix
  // any flowsheet:write caller could pass another DJ's id and start a show
  // attributed to the victim in shows.primary_dj_id, show_start flowsheet
  // messages, DJ stats, and every legacy mirror push.
  if (!req.auth?.id || req.body.dj_id !== req.auth.id) {
    throw new WxycError('Forbidden: dj_id must match the authenticated user', 403);
  }

  // Normalize dj_name_override (BS#1295): trim, treat empty / whitespace-only
  // as absent, reject > 255 chars at the controller boundary. Length is
  // measured against the trimmed value so trailing whitespace can't be used
  // to game the limit downward.
  const raw_override = req.body.dj_name_override;
  let dj_name_override: string | undefined;
  if (typeof raw_override === 'string') {
    const trimmed = raw_override.trim();
    if (trimmed.length === 0) {
      dj_name_override = undefined;
    } else if (trimmed.length > DJ_NAME_OVERRIDE_MAX_LENGTH) {
      throw new WxycError(
        `Bad Request: dj_name_override must be ${DJ_NAME_OVERRIDE_MAX_LENGTH} characters or fewer`,
        400
      );
    } else {
      dj_name_override = trimmed;
    }
  }

  // (b) Belt-and-braces (BS#1861): the tubafrenzy webhook's stub-show flow
  // can leave `shows.end_time` NULL for a window after a legacy sign-off —
  // option (a) now backfills it at write time, but this is a second,
  // independent signal that doesn't depend on that write having landed.
  // Treat the show as closed when its newest flowsheet entry is a
  // `show_end` marker, regardless of what `end_time` currently holds, so a
  // DJ going live in that window starts a NEW show instead of being
  // guest-joined into the one that just ended. Only checked when `end_time`
  // is still null — an already-closed show doesn't need the extra query.
  const latestEntryIsShowEnd =
    current_show !== undefined &&
    current_show.end_time === null &&
    (await flowsheet_service.isLatestEntryShowEnd(current_show.id));

  // BS#2065: the (b) guard above has just proven this show is closed (its
  // newest entry is a `show_end` marker) while `end_time` still reads NULL —
  // the signature of a dropped tubafrenzy `show_end` delivery, which since
  // WXYC/wiki#88 Phase 3 nothing repairs. Close the column opportunistically
  // from the marker's own timestamp so `addEntry` / `leaveShow` / every
  // show-scoped read stop seeing the departed DJ's show as live. Guarded
  // `WHERE end_time IS NULL` inside the service, same as the webhook
  // fast-path, so a later delivery or #1543's authoritative dump pass still
  // wins. Purely additive to the routing below — the start-vs-join decision is
  // unchanged, and a failed/no-op backfill cannot weaken it. Only a
  // complement to the `jobs/legacy-mirror-reconcile` detector: this fires
  // solely when someone next goes live.
  if (latestEntryIsShowEnd && current_show !== undefined) {
    await flowsheet_service.closeShowFromTerminalShowEndMarker(current_show.id);
  }

  if (current_show?.end_time !== null || latestEntryIsShowEnd) {
    const show_session: Show = await flowsheet_service.startShow(
      req.body.dj_id,
      req.body.show_name,
      req.body.specialty_id,
      dj_name_override
    );

    res.status(200).json(show_session);
  } else if (await flowsheet_service.isDjAlreadyActiveOnShow(current_show, req.body.dj_id)) {
    // (c) No-op duplicate dj_join (BS#1861): the requesting DJ is already
    // active on this show — either the primary DJ or an active co-host — so
    // this is a retried "Go Live" toggle, not a genuine join. Hand back
    // their existing (already-active) membership without writing another
    // dj_join marker (the issue's 16:37:59 duplicate-marker trace).
    res.status(200).json({ show_id: current_show.id, dj_id: req.body.dj_id, active: true } satisfies ShowDJ);
  } else {
    // Everything above has been ruled out: a show is genuinely open, it isn't
    // the caller's, and its terminal entry doesn't say it ended. This is the
    // handoff both BS#2232 incidents happened at, and the ONLY branch the
    // intent contract governs:
    //
    //   - 2026-08-20, show 1951164: a BS-native show (`primary_dj_id` set) ran
    //     nine hours and absorbed three later DJs as co-hosts while `on_air`
    //     named its original owner throughout.
    //   - 2026-08-28, show 1951224: a tubafrenzy-mirrored show (`primary_dj_id`
    //     NULL, `legacy_dj_name` "dj sue") absorbed a Backend account three
    //     hours in, and `on_air` named the departed legacy DJ.
    //
    // The two are the same routing bug with different banner mechanisms, which
    // is why this PR carries two fixes: the routing below, and
    // `getOnAirDJName`'s legacy short-circuit. Neither one subsumes the other.
    //
    // Flag OFF is byte-identical to the pre-BS#2233 behavior, `intent`
    // included: no 400 for an unrecognized value, no 409 for an absent one.
    // auto-dj-orchestrator ships `intent: "takeover"` before the flip and its
    // `join()` throws on a body with no show id, so a 400 here would crash
    // that daemon at activation. See config/flowsheetTakeover.ts.
    if (!flowsheetTakeoverConfig.getConfig().enabled) {
      const show_dj_instance: ShowDJ = await flowsheet_service.addDJToShow(req.body.dj_id, current_show);
      res.status(200).json(show_dj_instance);
      return;
    }

    // A JSON `null` says exactly what an absent field says — "I have not
    // chosen" — and it is what an unset optional serializes to from several of
    // this epic's clients. Fold it into absence BEFORE the union check, or a
    // caller who has not chosen is told their choice is invalid (400) instead
    // of being prompted (409), which is the one answer they cannot act on.
    const intent: unknown = req.body.intent ?? undefined;

    // No intent: the caller never chose. Refuse to choose for them, and say
    // which show is in the way so the client can prompt and echo the id back.
    if (intent === undefined) {
      throw await showAlreadyOpenError(current_show);
    }

    if (!isJoinIntent(intent)) {
      throw new WxycError(`Bad Request: intent must be one of ${JOIN_INTENTS.join(', ')}`, 400);
    }

    if (intent === 'join') {
      // Override is only consumed on the new-show path. Co-host join uses the
      // auth_user.dj_name resolution unchanged.
      const show_dj_instance: ShowDJ = await flowsheet_service.addDJToShow(req.body.dj_id, current_show);
      res.status(200).json(show_dj_instance);
      return;
    }

    // Takeover. Bound to the show the DJ was actually shown: clients poll, so
    // by the time someone reads the prompt and clicks, the open show may have
    // moved on. Ending "whatever is open now" would close a show whose name
    // they never saw, which voids the informed consent the prompt exists to
    // provide. (The other stale-snapshot case — the expected show having
    // CLOSED in that window — never reaches here: the first branch above
    // already routed it to `startShow`, silently, because starting their own
    // show is the outcome they asked for and re-prompting would put the dialog
    // on the common one-click path.)
    if (typeof req.body.expected_show_id !== 'number') {
      throw new WxycError('Bad Request: intent "takeover" requires expected_show_id', 400);
    }
    if (req.body.expected_show_id !== current_show.id) {
      throw await showAlreadyOpenError(current_show);
    }

    // `resolveShowEndInstant` (MAX(add_time) floored at start_time), never
    // `now()`. `now()` is right for a prompt handoff and a lie for an abandoned
    // one: it would credit a departed DJ with however many hours of dead air
    // elapsed before the next DJ arrived, and — per `endShow`'s own
    // EndShowOptions note — sort a `show_end` marker to the top of the public
    // flowsheet with an interval overlapping every archive day in between. The
    // derived instant is truthful in both cases, because a prompt handoff's
    // last logged track IS recent. One rule, correct twice.
    const endedAt = await flowsheet_service.resolveShowEndInstant(current_show);

    // `endShow` first, and unwrapped: its `WHERE end_time IS NULL`
    // compare-and-set is what serializes two racing takeovers, so the loser
    // gets that 400 rather than opening a second show.
    const closedShow: Show = await flowsheet_service.endShow(current_show, endedAt);

    // The route chains `flowsheetMirror.startShow`, whose response tap will
    // create the NEW show in tubafrenzy from the body below. The close has to
    // mirror too, or tubafrenzy keeps a show open that Backend has closed —
    // the split brain that made this incident ambiguous. It cannot ride a
    // second tap (both read the same `res.locals.mirrorData`, so an end-tap
    // would sign off the show that just started), so it is handed the closed
    // show explicitly and deferred to `res.once('finish')`.
    flowsheetMirror.scheduleTakeoverSignoff(req, res, closedShow);

    const show_session: Show = await flowsheet_service.startShow(
      req.body.dj_id,
      req.body.show_name,
      req.body.specialty_id,
      dj_name_override
    );
    res.status(200).json(show_session);
  }
};

export const leaveShow: RequestHandler<object, unknown, { dj_id: string }> = async (req, res) => {
  const currentShow = await flowsheet_service.getLatestShow();
  if (currentShow?.end_time !== null) {
    throw new WxycError('Bad Request: No active show session found.', 400);
  }

  // Cross-check body.dj_id against the authenticated user (BS#1102). Pre-fix
  // showMemberMiddleware only checked the caller was in the show — never
  // that body.dj_id matched. A guest DJ could end the entire show
  // (body.dj_id = primary_dj_id) or kick a co-host (body.dj_id = co-host id).
  if (!req.auth?.id || req.body.dj_id !== req.auth.id) {
    throw new WxycError('Forbidden: dj_id must match the authenticated user', 403);
  }

  // Show membership is verified by showMemberMiddleware on the route
  if (req.body.dj_id === currentShow.primary_dj_id) {
    const finalizedShow: Show = await flowsheet_service.endShow(currentShow);
    res.status(200).json(finalizedShow);
  } else {
    const showDJ: ShowDJ = await flowsheet_service.leaveShow(req.body.dj_id, currentShow);
    res.status(200).json(showDJ);
  }
};

/**
 * Parse a bounded positive-integer query parameter.
 *
 * Rejects anything that isn't a bare integer rather than letting `parseInt`'s
 * prefix parsing turn `"24h"` into `24` — an operator who mistypes the unit
 * should learn that, not silently get a different window than they asked for.
 * Out-of-range is a 400 too, never a silent clamp, for the same reason.
 */
const parseBoundedInt = (raw: string | undefined, name: string, fallback: number, max: number): number => {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new WxycError(`Bad Request: ${name} must be a positive integer`, 400);
  }
  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > max) {
    throw new WxycError(`Bad Request: ${name} must be between 1 and ${max}`, 400);
  }
  return value;
};

/**
 * `GET /flowsheet/open-shows` — every open show an operator might need to
 * close, oldest first (BS#2235).
 *
 * Gated to `flowsheet: ['manage']` (musicDirector / stationManager) on the
 * route. That is deliberately NARROWER than the capability it replaces:
 * tubafrenzy's `EndShowServlet` takes the show as a request parameter and
 * checks nothing about who is asking, so any signed-on DJ can end anyone's
 * recent show through the signon page's "Resume a Show" list. tubafrenzy
 * retires 2026-08-31 and takes that path with it.
 *
 * `window_hours` bounds the lookback; see `getOpenShows` for why an unwindowed
 * list is unusable in production.
 */
export const getOpenShows: RequestHandler<object, unknown, unknown, { window_hours?: string; limit?: string }> = async (
  req,
  res
) => {
  const windowHours = parseBoundedInt(
    req.query.window_hours,
    'window_hours',
    flowsheet_service.OPEN_SHOWS_DEFAULT_WINDOW_HOURS,
    flowsheet_service.OPEN_SHOWS_MAX_WINDOW_HOURS
  );
  const limit = parseBoundedInt(
    req.query.limit,
    'limit',
    flowsheet_service.OPEN_SHOWS_DEFAULT_LIMIT,
    flowsheet_service.OPEN_SHOWS_MAX_LIMIT
  );

  res.status(200).json(await flowsheet_service.getOpenShows(windowHours, limit));
};

/**
 * `POST /flowsheet/shows/:id/force-end` — close a show the caller does not
 * own (BS#2235).
 *
 * Reuses `endShow` rather than reimplementing the close, so the `show_end`
 * marker, the `show_djs` deactivation, the co-host leave markers and the
 * tubafrenzy sign-off follow one implementation and cannot drift from
 * `POST /flowsheet/end`. It is the same call the 2026-08-20 manual
 * remediation script made (BS#2232).
 *
 * The already-closed case is left to `endShow`'s compare-and-set on
 * `end_time IS NULL`, which raises the same 400 — the explicit check below is
 * only a fast path that avoids a wasted UPDATE, not the guard. A second
 * force-end therefore cannot write a duplicate marker even if two operators
 * click at the same instant.
 */
/**
 * The instant `force-end` stamps: the operator's `ended_at` when they supplied
 * one, otherwise the show's own last logged entry.
 *
 * The derived instant is the right default and the wrong answer often enough to
 * need an override — a DJ who stopped logging at 9pm and stayed on the air
 * until 11pm leaves a show whose flowsheet cannot say so, and the operator can.
 *
 * Bounded on BOTH ends because each bound protects a public read. Below
 * `start_time` yields `end_time < start_time`, an interval that cannot overlap
 * anything, which hides the show from `GET /flowsheet/range` on the very day it
 * aired (the same hazard `resolveShowEndInstant`'s own floor exists for). Above
 * `now` yields a show claiming to have ended in the future, which sorts a
 * `show_end` marker above every real entry on the public flowsheet. Out of
 * range is a 400, never a silent clamp: an operator who mistypes a date should
 * learn that, not get a different answer than they asked for.
 */
const resolveForceEndInstant = async (raw: unknown, show: Show): Promise<Date> => {
  if (raw === undefined || raw === null) {
    return flowsheet_service.resolveShowEndInstant(show);
  }
  // Only a string. `new Date(1755000000000)` parses an epoch happily, and a
  // caller who sent a number meant something the contract does not offer.
  if (typeof raw !== 'string') {
    throw new WxycError('Bad Request: ended_at must be an ISO-8601 date-time string', 400);
  }
  const endedAt = new Date(raw);
  if (Number.isNaN(endedAt.getTime())) {
    throw new WxycError('Bad Request: ended_at must be an ISO-8601 date-time string', 400);
  }
  const startedAt = new Date(show.start_time);
  if (endedAt.getTime() < startedAt.getTime()) {
    throw new WxycError("Bad Request: ended_at must be at or after the show's start_time", 400);
  }
  if (endedAt.getTime() > Date.now()) {
    throw new WxycError('Bad Request: ended_at must not be in the future', 400);
  }
  return endedAt;
};

export const forceEndShow: RequestHandler<
  { id: string },
  unknown,
  { ended_at?: unknown } | undefined,
  { force?: string }
> = async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    throw new WxycError('Bad Request: show id must be a positive integer', 400);
  }
  const showId = Number.parseInt(req.params.id, 10);

  const show = await flowsheet_service.getShowById(showId);
  if (!show) {
    throw new WxycError('Not Found: no show with that id', 404);
  }
  if (show.end_time !== null) {
    throw new WxycError('Bad Request: show is already ended', 400);
  }

  // Closing the show every on-air read resolves to needs `?force=true`.
  //
  // NOT a blanket refusal, and the 2026-08-20 incident is why: the show that
  // hung for nine hours WAS `max(shows.id)` the whole time — an abandoned show
  // is current until something closes it, so an unconditional guard would veto
  // the exact case this endpoint was built for. The confirmation is aimed at
  // the other failure: a mistyped id, or an operator acting on a list fetched
  // before a new show started, silently ending a live broadcast (after which
  // `POST /flowsheet` starts failing for the DJ on air). `is_current` on the
  // listing exists so a UI can warn; this is the server-side half of the same
  // signal, so a client that never implements the warning still can't do it by
  // accident.
  //
  // The terminal-marker carve-out matches `getOpenShows`'s `is_current`
  // exactly: a show whose `show_end` marker landed but whose `end_time` was
  // never stamped (the lost-webhook cohort BS#2065 detects) holds
  // `max(shows.id)` while being demonstrably over, and must not be gated.
  if (req.query.force !== 'true' && showId === (await flowsheet_service.getLatestShow())?.id) {
    if (!(await flowsheet_service.isLatestEntryShowEnd(showId))) {
      throw new WxycError('Conflict: this is the current on-air show. Re-send with ?force=true to end it anyway.', 409);
    }
  }

  // The instant the show actually stopped, not `now()` — see `endShow`. An
  // operator may override it within `[start_time, now]`.
  const endedAt = await resolveForceEndInstant(req.body?.ended_at, show);

  const finalizedShow: Show = await flowsheet_service.endShow(show, endedAt);
  res.status(200).json(finalizedShow);
};

export const getDJList: RequestHandler = async (req, res) => {
  // getOnAirDJs preserves the account-DJ shape ({ id, dj_name }) and additionally
  // surfaces legacy/tubafrenzy-mirrored shows (null id, legacy_dj_name) that the
  // show_djs-only derivation used to miss — BS#1547.
  res.status(200).json(await flowsheet_service.getOnAirDJs());
};

export const getOnAir: RequestHandler = async (req, res) => {
  const { dj_id } = req.query;

  const isActive = await flowsheet_service.getOnAirStatusForDJ(dj_id as string);
  res.status(200).json({ id: dj_id, is_live: isActive });
};

// Accepts a request body with entry_id and new_position, where
//    entry_id is the id of the entry to be moved
//    new_position is the new position of the entry
// Positions are serialized starting at 1 and define the play order of the tracks per show
const orderMutex = new Mutex();

export const changeOrder: RequestHandler<object, unknown, { entry_id: number; new_position: number }> = async (
  req,
  res
) => {
  const { entry_id, new_position } = req.body;

  if (entry_id === undefined || new_position === undefined) {
    throw new WxycError('Bad Request: entry_id and new_position are required', 400);
  }

  const release = await orderMutex.acquire();
  let updatedEntry;
  try {
    updatedEntry = await flowsheet_service.changeOrder(entry_id, new_position);
  } finally {
    release();
  }
  // The projection's discogs-unavailable read (BS#1962) and the response write
  // don't need the reorder lock — only the play_order mutation does — so they
  // run after `release()` to keep the extra DB round-trip out of the critical
  // section other reorders serialize behind.
  //
  // The service 404s when the entry is missing at transaction start, but its
  // confirmation read runs post-commit — a concurrent delete landing in that
  // window returns undefined. See the 404 rationale on deleteEntry above.
  if (!updatedEntry) {
    throw new WxycError(`Flowsheet entry ${entry_id} not found`, 404);
  }
  await sendProjectedEntry(res, 200, updatedEntry);
};

export interface ShowMetadata extends Show {
  specialty_show_name: string;
  show_djs: { id: string | null; dj_name: string | null }[];
}

export const getShowInfo: RequestHandler<object, unknown, object, { show_id: string }> = async (req, res) => {
  const showId = parseInt(req.query.show_id);

  if (isNaN(showId)) throw new WxycError('Missing or invalid show_id parameter', 400);

  const [showMetadata, entries] = await Promise.all([
    flowsheet_service.getShowMetadata(showId),
    flowsheet_service.getEntriesByShow(showId),
  ]);

  // `getShowMetadata` returns undefined when show_id doesn't exist in `shows`
  // (deleted show, typo, scraping the URL space) — without this guard the
  // spread below throws a bare TypeError that the centralized errorHandler
  // maps to 500 instead of the correct 404 (BS#1113).
  if (!showMetadata) {
    throw new WxycError(`Show ${showId} not found`, 404);
  }

  await Promise.all([flowsheet_service.attachUpcomingShows(entries), flowsheet_service.attachCriticReviews(entries)]);

  res.status(200).json({
    ...showMetadata,
    entries: projectEntriesV2(entries),
  });
};
