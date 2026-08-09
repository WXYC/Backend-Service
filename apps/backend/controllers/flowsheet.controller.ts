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
import WxycError from '../utils/error.js';

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
  'search_doc' | 'legacy_link_attempted_at' | 'metadata_attempt_at' | 'updated_at' | 'composer' | 'composer_source'
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
// flowsheet.id is a Postgres int4 column; a value outside this range parses
// fine as a JS integer (passing Number.isInteger) but blows up downstream as
// an unhandled "value out of range for type integer" Postgres error (BS#1800).
const INT4_MAX = 2147483647;
// BS#1960 cost/DoS guard on `page * limit` (the OFFSET passed to
// getEntriesByPage). The BS#1960 deferred-join rewrite of getEntriesByPage
// made deep offsets cheap (a bare flowsheet.id PK index scan, no joins on
// the discarded rows), so this is not a correctness bound — it's a ceiling
// on how much index-scanning a single request can ask for. Set well above
// any realistic UI paging depth: the acceptance floor is page=50 at
// limit=100 (offset 5,000), and this allows offset up to page 500 at
// limit=100 — 10x that. A genuine deep-history pull (further back than a UI
// paginator would ever click) should use the start_id/end_id range path
// above, which is a true index range scan regardless of depth.
const MAX_OFFSET = 50_000;

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
  // limit=100 against a ~2.6M-row table, while offset is capped at 50k / page
  // 500). A client that lets a user jump past the cap gets an explicit 400
  // rather than the old timeout-500; genuine deep-history reads belong on the
  // start_id/end_id range path. Left unclamped deliberately — totalPages stays
  // an honest "how many pages of data exist" for the "Page X of N" display.
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
};

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
    // Override is only consumed on the new-show path. Co-host join uses the
    // auth_user.dj_name resolution unchanged.
    const show_dj_instance: ShowDJ = await flowsheet_service.addDJToShow(req.body.dj_id, current_show);
    res.status(200).json(show_dj_instance);
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
