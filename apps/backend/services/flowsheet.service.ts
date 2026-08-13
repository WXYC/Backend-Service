import { sql, asc, desc, eq, and, or, isNull, isNotNull, gt, lt, lte, gte, inArray } from 'drizzle-orm';
import * as Sentry from '@sentry/node';
import WxycError from '../utils/error.js';
import {
  db,
  FSEntry,
  NewFSEntry,
  Show,
  ShowDJ,
  User,
  shows,
  artists,
  user,
  flowsheet,
  flowsheet_watermark,
  library,
  rotation,
  show_djs,
  library_artist_view,
  specialty_shows,
  album_metadata,
  normalizeFreetextArtist,
  nyCalendarDate,
  nyStartOfDay,
  resolveDjDisplayName,
  resolveShowDjName,
  showDjNameOverride,
  lastLoggedShowEntryOrderBy,
  lastLoggedShowEntryOrderBySql,
} from '@wxyc/database';
import { ALBUM_METADATA_PROJECTION, suppressMislabeledStreamingUrls } from '../utils/album-metadata-projection.js';
import { getUpcomingShowsMapsCached } from './concerts.service.js';
import { lookupCriticReviewsByAlbumIds } from './album-metadata-lookup.service.js';
import { getConfig as getCriticReviewsConfig } from '../config/criticReviews.js';
import { IFSEntry, ShowMetadata, UpdateRequestBody } from '../controllers/flowsheet.controller.js';
import { PgSelectQueryBuilder, QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * The PII-safe DJ-name chain now lives in `@wxyc/database` (`dj-name.ts`), so
 * `jobs/` writers can apply the identical decision instead of re-deriving it
 * in SQL — the drift BS#2119's review caught in `flowsheet-april-gap-import`.
 * Re-exported here so every existing import site (and its tests) keeps
 * resolving against this module. See the shared module for the full rules.
 */
export { resolveDjDisplayName, resolveShowDjName };

/**
 * Compute the next play_order value for a new flowsheet entry within a given
 * show. play_order is manually managed (not a serial/sequence) and is scoped
 * per show — tubafrenzy's webhook writes per-show play_orders (1, 2, 3, ...)
 * and Backend-Service inserts must continue that sequence rather than picking
 * up the global table max. Without the `WHERE show_id = ?` predicate a brand
 * new track in show B would inherit `max + 1` from a prior show A's late
 * additions, producing the discontinuous play_order sequence that breaks
 * dj-site's optimistic update + cache reconciliation (#693).
 */
const nextPlayOrder = async (showId: number): Promise<number> => {
  const result = await db
    .select({ max: sql<number>`coalesce(max(${flowsheet.play_order}), 0)` })
    .from(flowsheet)
    .where(eq(flowsheet.show_id, showId));
  return result[0].max + 1;
};

/**
 * Get the timestamp of the last flowsheet modification, sourced from the
 * single-row `flowsheet_watermark` sibling table. Replaces the prior
 * process-local `lastModifiedAt: Date` (BS#902 / Epic F F1) which broke
 * under multi-instance BS — each pod kept its own watermark, so an iOS
 * poll fanned across pods would either 304 against a stranger's value or
 * 200-with-redundant-data on pod swap.
 *
 * Why the sibling table rather than `MAX(flowsheet.updated_at)`:
 * `MAX(...)` retreats when the row currently holding the MAX is DELETEd —
 * a polling client's prior If-Modified-Since would 304 against the older
 * surviving MAX and miss the deletion until the next INSERT/UPDATE pushed
 * the watermark back above the prior peak. The sibling row is touched by
 * an AFTER INSERT/UPDATE/DELETE STATEMENT trigger on `flowsheet` (see
 * migration 0084), so the watermark advances on every mutation including
 * deletes and never moves backward. Enrichment-worker UPDATEs fire the
 * same trigger, closing BS#628 by transitivity.
 *
 * Returns the epoch (`new Date(0)`) only as a defensive fallback — the
 * migration seeds the singleton row at apply time, so in production the
 * SELECT always returns exactly one row.
 *
 * ET-midnight fold (BS#1607): the effective watermark is
 * `max(flowsheet_watermark, nyStartOfDay(now))`. The V2 feed's per-playcut
 * `upcoming_show` enrichment (`attachUpcomingShows`) filters
 * `concerts.starts_on >= nyCalendarDate(now)`, so the cached-GET response
 * depends on the wall-clock ET date, not only on flowsheet writes. Without
 * this fold, after ET midnight with no overnight flowsheet write a
 * now-past show's CTA would keep rendering (a client's pre-midnight
 * If-Modified-Since would 304 against a stale watermark). Maxing in the
 * start-of-today ET instant jumps the watermark forward at midnight, so the
 * first request past midnight gets a fresh 200 and the feed is recomputed —
 * dropping the past show. `concerts`-table INSERT/UPDATE/DELETE advances the
 * watermark directly (migration 0114's trigger), covering the stale-add case;
 * this fold covers the stale-drop case, which no write signals.
 *
 * The fold applies to every route wired to `flowsheetConditionalGet`
 * (`GET /flowsheet` and `GET /flowsheet/latest`); the accepted cost is one
 * extra unconditional refetch per client per ET day. `now` is injectable
 * (defaults to `new Date()`) so the midnight rollover is unit-testable
 * deterministically.
 */
export const getLastModifiedAt = async (now: Date = new Date()): Promise<Date> => {
  const result = await db.select({ at: flowsheet_watermark.last_modified_at }).from(flowsheet_watermark).limit(1);
  const watermark = result[0]?.at ?? new Date(0);
  const startOfEtDay = nyStartOfDay(now);
  return watermark.getTime() >= startOfEtDay.getTime() ? watermark : startOfEtDay;
};

// SQL query fields (flat structure from database)
//
// Adding a client-facing column here (or emitting it in transformToV2)? Also
// add it to CLIENT_FACING_FLOWSHEET_COLUMNS in ../utils/flowsheet-projection.ts
// (BS#1513), or the mutation/peek echoes won't carry it.
const FSEntryFieldsRaw = {
  id: flowsheet.id,
  show_id: flowsheet.show_id,
  album_id: flowsheet.album_id,
  entry_type: flowsheet.entry_type,
  artist_name: flowsheet.artist_name,
  album_title: flowsheet.album_title,
  track_title: flowsheet.track_title,
  track_position: flowsheet.track_position,
  record_label: flowsheet.record_label,
  label_id: flowsheet.label_id,
  rotation_id: flowsheet.rotation_id,
  // Primary source is the FK join (`leftJoin(rotation, rotation.id = flowsheet.rotation_id)`).
  // Fallback fires only when that join misses (rotation.rotation_bin IS NULL) and the entry
  // looks like a real track with non-empty artist+album. Three match cohorts:
  //   (a) flowsheet.album_id matches an active rotation.album_id (library-linked rotation rows);
  //   (b) (artist, album) snapshot matches active rotation row's denormalized fields
  //       (library-unlinked rotation rows hold the snapshot directly);
  //   (c) (artist, album) matches the library+artists join on an active rotation row's
  //       album_id (library-linked rows whose denorm fields are NULL).
  // The rotation window is bounded on BOTH sides against the flowsheet entry's add_time so
  // historical rotation status is preserved: add_date <= add_time (inclusive lower bound —
  // a play that aired before the release entered rotation is not badged; BS#1526) and
  // kill_date IS NULL OR kill_date > add_time (exclusive upper bound). Mirrors how tubafrenzy
  // classifies at mirror time (WXYC/dj-site#750).
  // Subquery only fires per-row on a missed FK join; on rows with a populated rotation_id
  // COALESCE short-circuits and the subquery is not evaluated.
  //
  // Tie-break (`ORDER BY t.id` over the union): the schema source comment at `rotation` explicitly
  // permits multiple active rows per (album_id, rotation_bin) over an album's lifecycle
  // (re-bins, re-adds, label-driven re-promotes). Picking the lowest `id` (oldest active
  // row) is a deliberate, stable choice for the badge UX — when an album has been re-binned
  // L → M, the badge reports its original cohort rather than flipping retroactively. This
  // matches the historical-correctness story above (add_date/kill_date window filtered against add_time).
  // The primary FK join via flowsheet.rotation_id remains canonical when present.
  //
  // SHAPE (BS#2080): the three match cohorts are a UNION ALL of three
  // separately-indexable probes, NOT an OR over one joined set. They were an
  // OR until the range read (BS#2062) made the per-row cost visible. Because
  // the OR spanned three tables, no index on any one of them could serve it —
  // the planner had to materialize the whole rotation-library-artists join and
  // filter afterwards, at 239 buffers and ~11.7ms cold per row. Prod response
  // time on `GET /flowsheet/range` fit `1.125s + 19.0ms * n_fallback`
  // (R^2=0.957) and the 7-day window (1,030 fallbacks, ~20.7s predicted) blew
  // the 5s statement timeout outright. Over those same 1,030 rows:
  // 224,554 buffers / 1,317.8ms -> 12,509 buffers / 4.6ms. Every arm is now an
  // index scan. Verified equivalent, not assumed: both forms run over all
  // 1,030 rows produced zero disagreements.
  //
  // Do not fold these arms back into an OR for readability. The three indexes
  // (migration 0145) only apply per-arm, and the OR form cannot use them.
  // Likewise, keep each arm's expression character-for-character identical to
  // its index — `lower(trim(coalesce(col, '')))` — or the planner silently
  // reverts to the seq scan this shape exists to avoid.
  //
  // ORDER BY over the union is `t.id`, preserving the original's `ORDER BY
  // r2.id LIMIT 1`: lowest matching rotation id wins, same tie-break, same
  // result. A row matching two arms appears twice in the union, which the
  // LIMIT 1 makes harmless.
  //
  // GUARD: unchanged — still `coalesce(col, '') <> ''`, NOT a trimmed variant.
  //
  // An earlier revision of BS#2080 tightened it to `trim(coalesce(col, ''))
  // <> ''` to make arm 3's inner JOIN provably equivalent to the LEFT JOIN it
  // replaced. That was wrong, and the way it was wrong is worth recording: the
  // guard gates ALL THREE arms, but the whitespace argument only ever applied
  // to arm 3. An entry with a real artist, a blank-but-non-empty album title
  // ('   ') and a populated `album_id` matches arm 1 on `album_id` alone —
  // arm 1 never looks at the text — so tightening a TEXT guard silently
  // dropped a legitimate badge. Verified against the clone: album_id 36962
  // returned 'M' under the original guard and nothing under the tightened one.
  //
  // Two further reasons to leave it alone. `shared/legacy-mirror`'s
  // `isActiveRotationMatch` — the write-path twin, kept in sync at the
  // cohort/predicate level — guards on the raw value specifically so neither
  // side normalizes more aggressively than the other; trimming here forks that
  // key. And PG's `trim()` strips only ASCII space, so it would not have
  // caught the NBSP/tab cases the word "whitespace" implies anyway.
  //
  // What remains is one narrow difference, and it is very hard to observe. For
  // an entry whose artist AND album both trim to '', arm 3's original LEFT JOIN
  // matched the NULL side of every active rotation row lacking a library link;
  // the inner JOIN below does not. But arm 2 usually reaches the same rows
  // first: a library-LINKED rotation row carries NULL denormalized names, which
  // `coalesce(..., '')` turns into '', so arm 2 already matches any blank entry
  // whenever such a row is active — the common case. The divergence therefore
  // needs a window containing a library-LESS active row with non-blank names
  // and NO blank-named row at all. Zero such cases in a 7-day prod diff over
  // 1,030 rows; the integration spec pins the shadowing rather than the
  // divergence, because its fixtures cannot produce the latter either.
  rotation_bin: sql<string | null>`
    COALESCE(
      ${rotation.rotation_bin},
      CASE WHEN ${flowsheet.rotation_id} IS NULL
        AND coalesce(${flowsheet.artist_name}, '') <> ''
        AND coalesce(${flowsheet.album_title}, '') <> ''
      THEN (
        SELECT t.rotation_bin FROM (
          -- (a) library-linked rotation rows, matched on album_id (album_id_idx).
          --     There is deliberately no "album_id IS NOT NULL" guard here:
          --     SQL equality against NULL is NULL, never true, so a free-form
          --     entry already matches nothing. That guard was inherited from
          --     the OR form, where it was equally redundant. Removing it was
          --     verified equivalent over 1,030 real rows plus a synthetic
          --     NULL-album_id row: 0 disagreements, identical buffers.
          --     (No backticks in this template -- they close the sql tag.)
          SELECT r2.id, r2.rotation_bin
          FROM ${rotation} r2
          WHERE r2.album_id = ${flowsheet.album_id}
            AND r2.add_date <= ${flowsheet.add_time}::date
            AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
          UNION ALL
          -- (b) library-unlinked rotation rows holding the (artist, album)
          --     snapshot directly (rotation_norm_artist_album_idx)
          SELECT r2.id, r2.rotation_bin
          FROM ${rotation} r2
          WHERE lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
            AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
            AND r2.add_date <= ${flowsheet.add_time}::date
            AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
          UNION ALL
          -- (c) library-linked rotation rows whose denorm fields are NULL, so
          --     the names come from the library+artists join
          --     (library_norm_album_title_idx -> album_id_idx -> artists_norm_name_idx)
          SELECT r2.id, r2.rotation_bin
          FROM ${rotation} r2
          JOIN ${library} l2 ON l2.id = r2.album_id
          JOIN ${artists} a2 ON a2.id = l2.artist_id
          WHERE lower(trim(coalesce(a2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
            AND lower(trim(coalesce(l2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
            AND r2.add_date <= ${flowsheet.add_time}::date
            AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
        ) t
        ORDER BY t.id
        LIMIT 1
      )
      END
    )
  `,
  // Resolved catalog artist for the played release, via the flowsheet ->
  // library FK join already present on every read path below
  // (`leftJoin(library, library.id = flowsheet.album_id)`). NULL for
  // free-form entries (no album_id) and for library rows with no artist link.
  // Two roles: (1) the batch key the V2 feed uses to attach the per-playcut
  // `upcoming_show` enrichment (BS#1607), matched against
  // `concerts.headlining_artist_id` (same `artists.id` space); and (2) since
  // BS#1625, a client-facing wire field — `transformToV2` projects it onto
  // the V2 track shape as `artist_id` for the iOS On Tour likes match.
  artist_id: library.artist_id,
  request_flag: flowsheet.request_flag,
  segue: flowsheet.segue,
  message: flowsheet.message,
  play_order: flowsheet.play_order,
  legacy_entry_id: flowsheet.legacy_entry_id,
  legacy_release_id: flowsheet.legacy_release_id,
  add_time: flowsheet.add_time,
  dj_name: flowsheet.dj_name,
  linkage_source: flowsheet.linkage_source,
  linkage_confidence: flowsheet.linkage_confidence,
  linked_at: flowsheet.linked_at,
  // Metadata: COALESCE album_metadata.col over flowsheet.col so the read
  // path projects the per-album row when present (Epic D / BS#897). The
  // inline columns on flowsheet stay populated through D3; once D4 drops
  // them, the COALESCE collapses to the album_metadata side. Free-form
  // entries (album_id IS NULL) miss the join and fall through to the
  // inline flowsheet values.
  //
  // Lifted verbatim into `../utils/album-metadata-projection.ts` (BS#2103) so
  // the legacy `GET /playlists/recentEntries?v=2` payload derives the same
  // values from the same SQL instead of re-deriving them. Field order is
  // unchanged (artwork_url first). Edit it there, not here.
  ...ALBUM_METADATA_PROJECTION,
  on_streaming: library.on_streaming,
  // BS#1908 (Not-on-Discogs epic #1280): the MD-set discogs-unavailable flag,
  // mirroring BS#1895's other read surfaces onto the V2 flowsheet album embed.
  // Sourced directly off the already-joined `library` row below (see
  // leftJoin(library, ...) in getEntriesByPage/getEntriesByRange/getEntriesByShow)
  // rather than a per-row call to `getDiscogsUnavailableFlagsById` — that
  // single-id helper is BS#1895's proxy-path lookup and would reintroduce the
  // N+1 the flowsheet read path forbids. A library-linked row picks the flag up
  // as part of this SAME query; a non-library row (freeform track with no
  // album_id, message/talkset/breakpoint/marker rows) gets SQL NULL from the
  // LEFT JOIN miss, which transformToV2 reads as "omit the field" per the
  // published contract (boolean-when-present, not required).
  discogs_unavailable: library.discogs_unavailable,
  discogs_unavailable_note: library.discogs_unavailable_note,
  metadata_status: flowsheet.metadata_status,
  enriching_since: flowsheet.enriching_since,
  // tubafrenzy's authoritative top-of-hour for breakpoint rows (BS#1449); NULL
  // on every other type. transformToV2 emits it only on the breakpoint case.
  radio_hour: flowsheet.radio_hour,
};

// Raw result type from SQL query
export type FSEntryRaw = {
  id: number;
  show_id: number | null;
  album_id: number | null;
  entry_type: string;
  artist_name: string | null;
  album_title: string | null;
  track_title: string | null;
  track_position: string | null;
  record_label: string | null;
  label_id: number | null;
  rotation_id: number | null;
  rotation_bin: string | null;
  artist_id: number | null;
  request_flag: boolean | null;
  segue: boolean | null;
  message: string | null;
  play_order: number | null;
  legacy_entry_id: number | null;
  legacy_release_id: number | null;
  add_time: Date | null;
  dj_name: string | null;
  linkage_source: string | null;
  linkage_confidence: number | null;
  linked_at: Date | null;
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
  genres: string[] | null;
  styles: string[] | null;
  on_streaming: boolean | null;
  // BS#1908: null when the LEFT JOIN to `library` misses (no album_id, or an
  // album_id with no matching library row); a joined row always yields a
  // real boolean (the column is NOT NULL on `library`).
  discogs_unavailable: boolean | null;
  discogs_unavailable_note: string | null;
  metadata_status: FSEntry['metadata_status'];
  enriching_since: Date | null;
  radio_hour: Date | null;
};

/**
 * Transform flat SQL result to nested IFSEntry structure.
 *
 * Exported so the BS#1714 serve-seam host guard can be unit-tested directly:
 * this is the single producer of every IFSEntry that reaches the `/flowsheet`
 * (top-level fields) and `/v2/flowsheet` (`transformToV2`, nested `metadata`)
 * read paths, so guarding the two hardwired streaming URLs here covers both.
 */
export const transformToIFSEntry = (raw: FSEntryRaw): IFSEntry => {
  // BS#1714 host guard, shared with the legacy recentEntries serializer
  // (BS#2103) — see `suppressMislabeledStreamingUrls`. Applied once and
  // reused for both the top-level field and the nested `metadata` object
  // below.
  const { spotify_url, apple_music_url } = suppressMislabeledStreamingUrls(raw);
  return {
    id: raw.id,
    show_id: raw.show_id,
    album_id: raw.album_id,
    legacy_entry_id: raw.legacy_entry_id ?? null,
    legacy_release_id: raw.legacy_release_id ?? null,
    entry_type: raw.entry_type as FSEntry['entry_type'],
    artist_name: raw.artist_name,
    album_title: raw.album_title,
    track_title: raw.track_title,
    track_position: raw.track_position,
    record_label: raw.record_label,
    label_id: raw.label_id,
    rotation_id: raw.rotation_id,
    rotation_bin: raw.rotation_bin,
    artist_id: raw.artist_id ?? null,
    request_flag: raw.request_flag ?? false,
    segue: raw.segue ?? false,
    message: raw.message,
    play_order: raw.play_order ?? 0,
    add_time: raw.add_time ?? new Date(),
    dj_name: raw.dj_name,
    linkage_source: raw.linkage_source,
    linkage_confidence: raw.linkage_confidence,
    linked_at: raw.linked_at,
    // Metadata columns (on FSEntry since they're on the flowsheet table)
    artwork_url: raw.artwork_url,
    discogs_url: raw.discogs_url,
    release_year: raw.release_year,
    spotify_url,
    apple_music_url,
    youtube_music_url: raw.youtube_music_url,
    bandcamp_url: raw.bandcamp_url,
    soundcloud_url: raw.soundcloud_url,
    artist_bio: raw.artist_bio,
    artist_wikipedia_url: raw.artist_wikipedia_url,
    on_streaming: raw.on_streaming ?? null,
    // BS#1908: pass through as-is (no `?? null` collapse needed beyond the
    // type already being nullable) — see FSEntryRaw's docstring for the
    // "null means no library row" contract transformToV2 relies on.
    discogs_unavailable: raw.discogs_unavailable ?? null,
    discogs_unavailable_note: raw.discogs_unavailable_note ?? null,
    metadata_status: raw.metadata_status,
    enriching_since: raw.enriching_since,
    radio_hour: raw.radio_hour ?? null,
    // Nested metadata view (used by transformToV2). genres/styles are
    // album_metadata-only fields (BS#1441) and so live here, NOT as top-level
    // IFSEntry/FSEntry fields (that type mirrors the flowsheet table).
    metadata: {
      artwork_url: raw.artwork_url,
      discogs_url: raw.discogs_url,
      release_year: raw.release_year,
      spotify_url,
      apple_music_url,
      youtube_music_url: raw.youtube_music_url,
      bandcamp_url: raw.bandcamp_url,
      soundcloud_url: raw.soundcloud_url,
      artist_bio: raw.artist_bio,
      artist_wikipedia_url: raw.artist_wikipedia_url,
      genres: raw.genres,
      styles: raw.styles,
    },
  };
};

/**
 * Resolve the DJ name for a show using the priority:
 *   1. `shows.dj_name_override` (per-show operator-intent override, BS#1321)
 *   2. `auth_user.dj_name` (filtered for the literal "Anonymous", see
 *      `resolveDjDisplayName`)
 *   3. `shows.legacy_dj_name` (tubafrenzy-owned; "DJ name at time of the
 *      show for shows whose primary_dj_id couldn't be resolved")
 *
 * Used by the live insert path (step 5b.2) to denormalize the resolved value
 * onto each new flowsheet row so search no longer needs to join shows -> auth_user.
 *
 * The override is at the top of the chain because operators set it on the
 * join body when they want a per-show display name (guest hosts, alumni
 * one-offs, on-air name corrections) — they expect it to take effect for
 * the whole show, not just the show_start marker. Pre-BS#1321 the override
 * only landed on the marker row + `shows.legacy_dj_name`, and any subsequent
 * track row for a DJ with a non-Anonymous `auth_user.dj_name` reverted to
 * `auth_user.dj_name` (priority 1 won), producing within-show inconsistency.
 *
 * Filters the literal "Anonymous" out of `auth_user.dj_name` via
 * `resolveDjDisplayName`. See #1286/#1288 for the Anonymous filtering
 * rationale; #1321 for the override-precedence promotion.
 *
 * The override itself is not "Anonymous"-filtered: an operator who types
 * the literal "Anonymous" into the override surface has chosen that string
 * on purpose. The pre-existing `auth_user.dj_name` filter was a workaround
 * for an upstream onboarding bug that wrote "Anonymous" automatically;
 * the override is operator-supplied, so we trust it verbatim.
 *
 * `auth_user.name` is intentionally NOT in the chain — it typically stores
 * the user's real name (set from realName at provision time), which is PII
 * and must not leak onto the public on-air playlist. See
 * `resolveDjDisplayName`'s docstring.
 */
export const resolveDjNameForShow = async (show: Show): Promise<string | null> => {
  const primaryDjId = (show.primary_dj_id as string | null | undefined) ?? null;
  const base = {
    dj_name_override: (show.dj_name_override as string | null | undefined) ?? null,
    legacy_dj_name: (show.legacy_dj_name as string | null | undefined) ?? null,
    primary_dj_id: primaryDjId,
  };

  // Skip the lookup entirely when the chain can't reach it — an override wins
  // outright, and a show with no linked DJ has no row to fetch. Both tests
  // defer to the shared definitions rather than restating them: a copy of the
  // override rule here is exactly the drift the extraction exists to prevent.
  if (showDjNameOverride(base.dj_name_override) !== null || primaryDjId == null) {
    return resolveShowDjName({ ...base, user: null });
  }

  const rows = await db.select({ djName: user.djName }).from(user).where(eq(user.id, primaryDjId)).limit(1);
  return resolveShowDjName({ ...base, user: rows[0] ?? null });
};

/**
 * Estimate total flowsheet entries for pagination.
 *
 * Reads `pg_class.reltuples`, the planner's row-count estimate maintained by
 * autovacuum/ANALYZE. Constant-time vs. an exact `count(*)` which would
 * sequentially scan ~2.6M rows and routinely exceed the 5s per-statement
 * timeout on this RDS instance — that's the immediate cause of
 * `/flowsheet?page=0&limit=20` 500ing under live load. The estimate is
 * typically within a few hundred of the true count, which is fine for a
 * paginated UI's "Page X of N" display; pages near the upper bound may shift
 * by one as autovacuum lags.
 *
 * `reltuples = -1` is the "never analyzed" sentinel; treat it as 0. The same
 * goes for a missing row (no permissions on `pg_class` would surface as an
 * error from the surrounding query, not as a missing row).
 *
 * Re-evaluation trigger: revisit when `flowsheet` exceeds ~5M rows (currently
 * ~2.6M). At that scale the ±1% planner estimate drifts ±50k per page bucket
 * and the UI's "Page X of N" starts skipping numbers visibly. Alternatives at
 * that point, cheapest to costliest: (1) drop `totalPages` from the response
 * and let clients infer "more pages?" from `results.length === limit`,
 * (2) refresh a materialized count on a cron, (3) bump the RDS instance class
 * so an exact `COUNT(*)` fits the 5s statement timeout. (Storage size bumps
 * are not on the table — gp3 conversions are reversible, sizing up is not.)
 */
export const getEntryCount = async (): Promise<number> => {
  const schema = process.env.WXYC_SCHEMA_NAME ?? 'wxyc_schema';
  const result = await db.execute(
    sql`SELECT GREATEST(reltuples::bigint, 0)::int AS count
        FROM pg_class
        WHERE relname = 'flowsheet'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${schema})`
  );
  const row = (result as unknown as Array<{ count: number }>)[0];
  return Number(row?.count ?? 0);
};

/**
 * Gets flowsheet entries by page with metadata joins.
 *
 * BS#1960: deferred-join / late-row-lookup rewrite. The naive form —
 * OFFSET/LIMIT applied to the fully-joined query — makes Postgres compute
 * the joined row (3 LEFT JOINs against rotation/library/album_metadata) for
 * every one of the `offset` discarded rows before it can discard them.
 * Latency grew ~11ms per discarded row and the endpoint 500'd once `offset`
 * passed ~450-500, hitting this RDS instance's 5s statement_timeout — plain
 * OFFSET-with-joins pagination pathology.
 *
 * The fix: resolve the page of `flowsheet.id`s FIRST, against a bare-table
 * subquery (no joins touched), then join only that already-bounded `limit`-
 * row set. `page` is a subquery-in-FROM (`.as('page')`).
 *
 * BS#2133 (parent #2118 site 1): ordered by `add_time DESC, id DESC`, not
 * `id DESC` alone. `flowsheet.id` is a serial PK — insertion order, not
 * airtime order — so a historical insert (backfill, gap import, repair)
 * receives the highest ids in the table and previously sorted as the newest
 * content on this, the default page of the public unauthenticated
 * `GET /flowsheet` — and on `getLatest` (`flowsheet.controller.ts`,
 * `GET /flowsheet/latest`), the OTHER caller of this function
 * (`getEntriesByPage(0, 1)`). This function now serves two different
 * contracts under one query: "page N of the flowsheet" and "the single
 * latest entry." Both move from "most recently inserted" to "most recently
 * aired" with this change — an improvement for `getLatest` specifically,
 * since "latest" reads naturally as airtime, not insertion order.
 *
 * `id` stays as an explicit tie-break because `add_time` is not unique: it
 * defaults to `now()`, which is `transaction_timestamp()` — every row
 * written by the same statement (e.g. a bulk `INSERT ... SELECT`) shares one
 * `add_time`, so without the tie-break those rows would have no defined
 * relative order.
 *
 * TWO DIFFERENT CLOCKS FEED `add_time`, AND THIS SORT KEY NOW MIXES THEM.
 * The tubafrenzy webhook (`markerTimestamp` in
 * `apps/backend/routes/internal.route.ts` — see that assignment's own doc
 * comment) sets `add_time` from `entry.startTime` when that field parses to
 * a usable timestamp no more than `FUTURE_TIMESTAMP_TOLERANCE_MS` ahead of
 * the delivery clock (BS#2143), and from the delivery clock itself
 * otherwise, for EVERY entry type it inserts — but per the BS#351
 * gap-import findings, only `show_start`/`show_end` marker rows carry a
 * non-zero `startTime` in tubafrenzy; ordinary track rows have
 * `startTime = 0` (tubafrenzy's "not set" sentinel) and fall through to the
 * delivery clock. So MARKER rows get tubafrenzy's EVENT clock and
 * TRACK rows get Backend's DELIVERY clock — two different clocks landing in
 * the same column, and now the same sort key. Consequence: on a webhook
 * delivery lag, a show's `show_end` marker can carry an `add_time` EARLIER
 * than the delivery timestamp of that same show's own final track, so the
 * marker now sorts BELOW the track on page 0 (and `getLatest` /
 * `GET /flowsheet/latest` would return the track instead of the sign-off).
 * Under plain `id DESC` this was structurally impossible — insertion order
 * always put the marker last. This is a known, accepted consequence of the
 * new key, not something this change fixes; the divergence between the two
 * clocks is unbounded (tubafrenzy delivery lag), not sub-second.
 *
 * Measured 2026-08-13 (see BS#2133): below the `MAX_OFFSET` cache cliff
 * (`flowsheet.controller.ts`) this ordering costs the same order of
 * magnitude as the old `id DESC` shape (single-digit-to-teens ms warm); no
 * composite index was added — see `MAX_OFFSET`'s comment for why.
 *
 * The inner `ORDER BY ... OFFSET ... LIMIT` picks the page; the outer
 * `ORDER BY` re-establishes the SAME order after the join (a join doesn't
 * guarantee it preserves the subquery's row order). The inner and outer
 * clauses must always change together — changing only one silently breaks
 * pagination.
 */
export const getEntriesByPage = async (offset: number, limit: number): Promise<IFSEntry[]> => {
  const page = db
    .select({ id: flowsheet.id })
    .from(flowsheet)
    .orderBy(desc(flowsheet.add_time), desc(flowsheet.id))
    .offset(offset)
    .limit(limit)
    .as('page');

  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(page)
    .innerJoin(flowsheet, eq(flowsheet.id, page.id))
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .orderBy(desc(flowsheet.add_time), desc(flowsheet.id));

  return raw.map(transformToIFSEntry);
};

/**
 * Entries whose `flowsheet.id` falls in `[startId, endId]`, newest id first.
 *
 * AN ID WINDOW IS NOT A TIME WINDOW, AND STOPPED APPROXIMATING ONE (BS#2118,
 * explicitly accepted). The `start_id`/`end_id` contract is literally an id
 * range — that is the wire shape, not an implementation detail — so unlike
 * `getEntriesByPage` above this function is NOT re-scoped to `add_time`;
 * doing so would answer a different question than the one it was asked.
 *
 * What changed is the informal reading a caller could previously get away
 * with. While every insert was a live one, ids advanced with wall-clock time,
 * so an id window was a usable stand-in for a time window and the controller
 * markets this as the "genuine deep-history pull" path. A historical insert
 * (backfill, gap import, repair) breaks that correspondence permanently and
 * in both directions: the imported rows take head-era ids, so they are
 * unreachable through any id window covering the era they actually aired in,
 * and they interleave into head-era windows where they did not air. #2119's
 * April cohort is exactly this — those 403 rows answer to head-era ids, not
 * April ones.
 *
 * For a genuine time window, use `GET /flowsheet/range` /
 * `getEntriesInTimeWindow` below, which windows on `add_time` and was built
 * (BS#2062) for that question. This function stays id-shaped for the callers
 * that genuinely want ids.
 */
export const getEntriesByRange = async (startId: number, endId: number): Promise<IFSEntry[]> => {
  // play_order is per-show after #693; id is globally monotonic across shows
  // in INSERTION order (see the header — not airtime order).
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .where(and(gte(flowsheet.id, startId), lte(flowsheet.id, endId)))
    .orderBy(desc(flowsheet.id));

  return raw.map(transformToIFSEntry);
};

/** One show overlapping a `GET /flowsheet/range` window — the public-safe projection. */
export type FlowsheetRangeShow = {
  id: number;
  show_name: string | null;
  dj_name: string | null;
  specialty_id: number | null;
  start_time: Date;
  end_time: Date | null;
};

/**
 * Every flowsheet entry logged in the half-open window `[start, end)` (BS#2062).
 *
 * Distinct from `getEntriesByRange` above, which windows on `flowsheet.id`.
 * This one windows on `add_time` and returns EVERY entry type — the
 * show_start / show_end markers and breakpoints are exactly what let a
 * consumer segment a day into shows, so the `entry_type = 'track'` partial
 * index cannot serve it. Migration 0144 adds the unpartitioned
 * `flowsheet_add_time_idx` this relies on; without it the planner falls back
 * to a full scan of the ~1.7 GB heap.
 *
 * Ordered by `add_time` ASC, tie-broken on `id` ASC — NOT `play_order`, which
 * is assigned per-show by two independent writers and therefore repeats
 * across the many shows a window spans (ordering by it interleaves them).
 * `id` is globally monotonic, the same reason `getEntriesByShow` ties on it
 * after the 2026-05-01 reordering incident.
 */
export const getEntriesInTimeWindow = async (start: Date, end: Date): Promise<IFSEntry[]> => {
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .where(and(gte(flowsheet.add_time, start), lt(flowsheet.add_time, end)))
    .orderBy(asc(flowsheet.add_time), asc(flowsheet.id));

  return raw.map(transformToIFSEntry);
};

/**
 * Every show overlapping the window `[start, end)` (BS#2062), ordered by
 * `start_time` ASC.
 *
 * Overlap, not containment: a show that spans midnight belongs to both days.
 * A closed show `[start_time, end_time)` intersects when it starts before the
 * window ends and ends after the window starts.
 *
 * **A NULL `end_time` is not "still on the air."** It has two causes that this
 * column cannot distinguish: the show is genuinely live, or its `show_end`
 * delivery was dropped and the column stayed NULL permanently (nothing
 * re-closes it on a schedule — BS#2065). Reading NULL as open-ended would make
 * every one of those orphaned historical shows intersect every window forever,
 * so an open-ended show is included on its timestamps only when `start_time`
 * falls inside the window.
 *
 * That timestamp rule alone is not sufficient, which is what the third arm is
 * for. An overnight show that signed on at 22:00 and is still live at 01:00
 * fails both timestamp arms for today's window — `end_time` is NULL and
 * `start_time` is in yesterday — yet `getEntriesInTimeWindow` still returns
 * its post-midnight entries, each carrying that `show_id`. api.yaml promises
 * the opposite ("Matches `FlowsheetRangeEntry.show_id` for every entry
 * belonging to this show"; "Segment on `show_id`"), so dropping the show hands
 * `archive` an unresolvable id. The same gap swallows every dropped-`show_end`
 * show that still has entries in the asked-for window. Including any show an
 * in-window entry references closes it, and does so without re-admitting the
 * orphaned shows the NULL rule exists to exclude: an orphan with no entries
 * here is still absent. The subquery windows on `add_time`, so it is served by
 * the same `flowsheet_add_time_idx` (migration 0144) the entries read uses.
 *
 * The DJ handle is resolved through the shared `resolveShowDjName` chain with
 * the user row LEFT JOINed in — one query for the whole window, not one per
 * show. `user.id` is selected alongside `djName` specifically to tell "no user
 * row" from "user row with an unusable djName"; the chain treats them
 * differently.
 */
export const getShowsInTimeWindow = async (start: Date, end: Date): Promise<FlowsheetRangeShow[]> => {
  const rows = await db
    .select({
      id: shows.id,
      show_name: shows.show_name,
      specialty_id: shows.specialty_id,
      start_time: shows.start_time,
      end_time: shows.end_time,
      dj_name_override: shows.dj_name_override,
      legacy_dj_name: shows.legacy_dj_name,
      primary_dj_id: shows.primary_dj_id,
      user_id: user.id,
      user_dj_name: user.djName,
    })
    .from(shows)
    .leftJoin(user, eq(user.id, shows.primary_dj_id))
    .where(
      or(
        // Strict `>`: two half-open intervals [a,b) and [c,d) intersect iff
        // a < d AND c < b, so a show that ended exactly at the window's
        // first instant does not overlap it.
        and(isNotNull(shows.end_time), lt(shows.start_time, end), gt(shows.end_time, start)),
        and(isNull(shows.end_time), gte(shows.start_time, start), lt(shows.start_time, end)),
        // Referenced by an entry in this window (see the docstring): the arm
        // that keeps `entries[].show_id` resolvable when the timestamps alone
        // would drop the show. Built with the typed query builder rather than
        // a raw `sql` template on purpose — the postgres-js driver's
        // timestamptz serializer override mangles a JS Date passed through
        // `${...}`, and the column-aware encoder is what sidesteps it.
        inArray(
          shows.id,
          db
            .selectDistinct({ id: flowsheet.show_id })
            .from(flowsheet)
            .where(and(isNotNull(flowsheet.show_id), gte(flowsheet.add_time, start), lt(flowsheet.add_time, end)))
        )
      )
    )
    // `id` is a deterministic tie-break for shows sharing a start_time; the
    // contract only specifies start_time ordering, and an unstable secondary
    // order would reshuffle between identical requests.
    .orderBy(asc(shows.start_time), asc(shows.id));

  return rows.map((row) => ({
    id: row.id,
    show_name: row.show_name ?? null,
    dj_name: resolveShowDjName({
      dj_name_override: row.dj_name_override ?? null,
      legacy_dj_name: row.legacy_dj_name ?? null,
      primary_dj_id: row.primary_dj_id ?? null,
      user: row.user_id == null ? null : { djName: row.user_dj_name ?? null },
    }),
    specialty_id: row.specialty_id ?? null,
    start_time: row.start_time,
    end_time: row.end_time ?? null,
  }));
};

export const getEntriesByShow = async (...show_ids: number[]): Promise<IFSEntry[]> => {
  if (show_ids.length === 0) return [];

  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .where(inArray(flowsheet.show_id, show_ids))
    // play_order can collide within a show: the tubafrenzy webhook and the
    // dj-site live-insert path assign it independently and the schema
    // intentionally allows overlap (no per-show UNIQUE — see schema.ts). Tied
    // rows must therefore break on a stable secondary key, or the live
    // flowsheet reshuffles between polls (the "randomly rearranging" report).
    // flowsheet.id is globally monotonic, so it orders the two writers'
    // entries deterministically at every shared play_order.
    .orderBy(desc(flowsheet.play_order), desc(flowsheet.id));

  return raw.map(transformToIFSEntry);
};

export const addTrack = async (entry: Omit<NewFSEntry, 'play_order'>): Promise<FSEntry> => {
  /*
    TODO: logic for updating album playcount
  */
  // if (entry.artist_name || entry.album_title || entry.record_label) {
  //   const qb = new QueryBuilder();
  //   let query = qb.select().from(library_artist_view).$dynamic();
  //   query = withAlbumTitle(withArtistName(query, entry.artist_name), entry.album_title);
  //   console.log(query.toSQL());
  //   // query = withAlbumTitle(query, entry.album_title);
  //   // console.log(query.toSQL());
  //   query = withLabel(query, entry.record_label);
  //   console.log(query.toSQL());

  //   const matching_albums: LibraryArtistViewEntry[] = await db.execute(query);

  //   if (matching_albums.length > 0) {
  //     const matching_album_ids = matching_albums.map((album: LibraryArtistViewEntry) => {
  //       return album.id;
  //     });

  //     await db
  //       .update(library)
  //       .set({ last_modified: sql`current_timestamp()`, plays: sql`${library.plays} + 1` })
  //       .where(inArray(library.id, matching_album_ids));
  //   }
  // }

  if (entry.show_id == null) {
    throw new WxycError('Cannot add flowsheet entry without show_id', 400);
  }
  const play_order = await nextPlayOrder(entry.show_id);
  const response = await db
    .insert(flowsheet)
    .values({ ...entry, play_order })
    .returning();
  return response[0];
};

// Returns undefined when no row matches entry_id (double delete / stale id);
// the controller maps that to a 404 (PR #1532 review).
export const removeTrack = async (entry_id: number): Promise<FSEntry | undefined> => {
  /*
    TODO: logic for updating album playcount
   */
  // const entry = await db.select().from(flowsheet).where(eq(flowsheet.id, entry_id)).limit(1);

  // if (entry.length === 0) {
  //   throw new Error('Entry not found');
  // }

  // const qb = new QueryBuilder();
  // const query = withArtistName(
  //   withAlbumTitle(
  //     withLabel(qb.select().from(library_artist_view).$dynamic(), entry[0].record_label),
  //     entry[0].album_title
  //   ),
  //   entry[0].artist_name
  // );

  // const matching_albums: LibraryArtistViewEntry[] = await db.execute(query);

  // if (matching_albums.length > 0) {
  //   const matching_album_ids = matching_albums.map((album: LibraryArtistViewEntry) => {
  //     return album.id;
  //   });

  //   await db
  //     .update(library)
  //     .set({ last_modified: sql`current_timestamp()`, plays: sql`${library.plays} - 1` })
  //     .where(inArray(library.id, matching_album_ids));
  // }

  const response = await db.delete(flowsheet).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};

function withArtistName<T extends PgSelectQueryBuilder>(qb: T, artist_name: string | null | undefined) {
  if (artist_name) {
    return qb.where(eq(library_artist_view.artist_name, artist_name));
  }
  return qb;
}

function withAlbumTitle<T extends PgSelectQueryBuilder>(qb: T, album_title: string | null | undefined) {
  if (album_title) {
    return qb.where(eq(library_artist_view.album_title, album_title));
  }
  return qb;
}

function withLabel<T extends PgSelectQueryBuilder>(qb: T, label: string | null | undefined) {
  if (label) {
    return qb.where(eq(library_artist_view.label, label));
  }
  return qb;
}

// Returns undefined when the UPDATE matches no row (entry deleted out from
// under the edit); the controller maps that to a 404 (PR #1532 review).
export const updateEntry = async (entry_id: number, entry: UpdateRequestBody): Promise<FSEntry | undefined> => {
  // Defense in depth (BS#1099): construct the update object from named
  // fields so even if a future controller starts passing the raw body,
  // mass-assignment of internal columns (metadata_status, legacy_entry_id,
  // show_id, play_order, linkage_*, etc.) is blocked at this boundary too.
  const updateSet: UpdateRequestBody = {};
  if (entry.artist_name !== undefined) updateSet.artist_name = entry.artist_name;
  if (entry.album_title !== undefined) updateSet.album_title = entry.album_title;
  if (entry.track_title !== undefined) updateSet.track_title = entry.track_title;
  if (entry.track_position !== undefined) updateSet.track_position = entry.track_position;
  if (entry.record_label !== undefined) updateSet.record_label = entry.record_label;
  if (entry.label_id !== undefined) updateSet.label_id = entry.label_id;
  if (entry.album_id !== undefined) updateSet.album_id = entry.album_id;
  if (entry.rotation_id !== undefined) updateSet.rotation_id = entry.rotation_id;
  if (entry.request_flag !== undefined) updateSet.request_flag = entry.request_flag;
  if (entry.segue !== undefined) updateSet.segue = entry.segue;
  if (entry.message !== undefined) updateSet.message = entry.message;

  const response = await db.update(flowsheet).set(updateSet).where(eq(flowsheet.id, entry_id)).returning();
  return response[0];
};

export const startShow = async (
  dj_id: string,
  show_name?: string,
  specialty_id?: number,
  dj_name_override?: string
): Promise<Show> => {
  const dj_info = (await db.select().from(user).where(eq(user.id, dj_id)).limit(1))[0];

  if (!dj_info) {
    throw new WxycError(`DJ with id '${dj_id}' not found`, 404);
  }

  // BS#1295/BS#1321: per-show display-name override. The controller already
  // trimmed and length-checked; re-trim here as a defense-in-depth (the
  // service is also called directly from tests / future call sites that may
  // bypass the controller). Empty / whitespace-only override falls through
  // to the resolveDjDisplayName path — preserving today's behavior.
  //
  // BS#1321 redirects the persistence target from `shows.legacy_dj_name` to
  // a dedicated `shows.dj_name_override` column. `legacy_dj_name` is owned
  // by jobs/flowsheet-etl (it gets overwritten on every tubafrenzy upsert
  // tick — see job.ts line 346), so an override that lived there only
  // survived until the next sync window. The new column is
  // Backend-Service-only and is checked at the top of
  // `resolveDjNameForShow`'s precedence chain so every subsequent track
  // row reflects it for the rest of the show. See migration 0090 for the
  // full rationale.
  const trimmed_override = dj_name_override?.trim() ?? '';
  const effective_override = trimmed_override.length > 0 ? trimmed_override : null;

  const new_show = await db
    .insert(shows)
    .values({
      primary_dj_id: dj_id,
      specialty_id: specialty_id,
      show_name: show_name,
      dj_name_override: effective_override ?? undefined,
    })
    .returning();

  await db
    .insert(show_djs)
    .values({
      show_id: new_show[0].id,
      dj_id: dj_id,
    })
    .returning();

  // Override (when present) wins outright over the helper-resolved name.
  // When the override is absent, fall back to the centralized resolution
  // helper that handles `auth_user.dj_name`, the "Anonymous" literal, and
  // the `auth_user.name` fallback (WXYC/Backend-Service#1286, epic #1288).
  const display_dj_name = effective_override ?? resolveDjDisplayName(dj_info.djName ?? null);
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  // Asymmetric fallback (epic #1288): when the DJ name is unresolvable we
  // still want a marker row so consumers know the show began. The wording
  // degrades from "Start of Show: <name> joined the set at ${time}" to a
  // bare "Start of show: ${time}".
  const message = display_dj_name
    ? `Start of Show: ${display_dj_name} joined the set at ${now}`
    : `Start of show: ${now}`;

  await db.insert(flowsheet).values({
    show_id: new_show[0].id,
    entry_type: 'show_start',
    dj_name: display_dj_name,
    play_order: await nextPlayOrder(new_show[0].id),
    message,
  });

  return new_show[0];
};

export const addDJToShow = async (dj_id: string, current_show: Show): Promise<ShowDJ> => {
  let show_dj_instance = await db
    .select()
    .from(show_djs)
    .where(and(eq(show_djs.show_id, current_show.id), eq(show_djs.dj_id, dj_id)))
    .limit(1);

  if (!show_dj_instance || show_dj_instance.length === 0) {
    const new_instance = await db
      .insert(show_djs)
      .values({
        show_id: current_show.id,
        dj_id: dj_id,
      })
      .returning();

    show_dj_instance = new_instance;

    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(dj_id, current_show.id);
    // --------------------------------
  } else if (show_dj_instance[0].active == false) {
    const new_instance = await db
      .update(show_djs)
      .set({ active: true })
      .where(and(eq(show_djs.show_id, current_show.id), eq(show_djs.dj_id, dj_id)))
      .returning();

    show_dj_instance = new_instance;

    // -- Add DJ Joined to Flowsheet --
    await createJoinNotification(dj_id, current_show.id);
    // --------------------------------
  }

  return show_dj_instance[0];
};

const createJoinNotification = async (id: string, show_id: number): Promise<FSEntry | null> => {
  const dj = (await db.select().from(user).where(eq(user.id, id)).limit(1))[0];

  const display_dj_name = resolveDjDisplayName(dj?.djName ?? null);

  // Asymmetric fallback (epic #1288): a nameless mid-show join is a degraded
  // state. The marker is suppressed rather than written — better logged than
  // rendered to the public on-air playlist — and a Sentry warning carries
  // dj_id + show_id so the cause is debuggable.
  if (!display_dj_name) {
    Sentry.captureMessage('Suppressed dj_join marker: DJ display name unresolvable', {
      level: 'warning',
      tags: { tool: 'flowsheet', entry_type: 'dj_join' },
      extra: { dj_id: id, show_id },
    });
    return null;
  }

  const notification = await db
    .insert(flowsheet)
    .values({
      show_id: show_id,
      entry_type: 'dj_join',
      dj_name: display_dj_name,
      play_order: await nextPlayOrder(show_id),
      message: `${display_dj_name} joined the set!`,
    })
    .returning();

  return notification[0];
};

export const endShow = async (currentShow: Show): Promise<Show> => {
  //Add leave notification for all remaining guest djs;
  //Update their active state and set show end time.

  const primary_dj_id = currentShow.primary_dj_id;
  if (!primary_dj_id) throw new Error('Primary DJ not found');

  // Claim the show FIRST, before any other write.
  //
  // Two things follow from the ordering, both of which were broken when the
  // end_time UPDATE ran last (BS#1119 follow-up review):
  //
  //   1. `end_time IS NULL` makes this a compare-and-set. The controller's own
  //      `currentShow.end_time !== null` guard only rejects a second end after
  //      the first COMMITS; a double-click has both requests reading a live
  //      show, and without the CAS both wrote a `show_end` marker and both
  //      returned 200, so the mirror signed off tubafrenzy twice. The loser
  //      now gets an empty `.returning()` and the same 400 the controller
  //      raises — a non-2xx response, which the mirror middleware skips.
  //   2. Committing end_time before the marker closes the co-host write
  //      window. Writing the marker first left the show ACTIVE while the
  //      marker existed, so a racing `POST /flowsheet` passed the active-show
  //      check and landed after it — appearing in tubafrenzy after
  //      END_OF_SHOW, since tubafrenzy assigns SEQUENCE server-side. Ending
  //      the show first makes that add fail its own guard.
  const finalized = await db
    .update(shows)
    .set({ end_time: new Date() })
    .where(and(eq(shows.id, currentShow.id), isNull(shows.end_time)))
    .returning();

  const finalizedShow = finalized[0];
  if (!finalizedShow) {
    // Someone else ended this show between the controller's read and here.
    throw new WxycError('Bad Request: No active show session found.', 400);
  }

  const remaining_djs = await db
    .select()
    .from(show_djs)
    .where(and(eq(show_djs.show_id, currentShow.id), eq(show_djs.active, true)));

  await Promise.all(
    remaining_djs.map(async (dj: ShowDJ) => {
      await db
        .update(show_djs)
        .set({ active: false })
        .where(and(eq(show_djs.show_id, currentShow.id), eq(show_djs.dj_id, dj.dj_id)));
      if (dj.dj_id === primary_dj_id) return;
      await createLeaveNotification(dj.dj_id, currentShow.id);
    })
  );

  const dj_information = (await db.select().from(user).where(eq(user.id, primary_dj_id)).limit(1))[0];
  const display_dj_name = resolveDjDisplayName(dj_information?.djName ?? null);
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  // Symmetric to startShow: keep the row, degrade the wording to bare
  // "End of show: ${time}" when the name is unresolvable (epic #1288).
  const message = display_dj_name ? `End of Show: ${display_dj_name} left the set at ${now}` : `End of show: ${now}`;

  await db.insert(flowsheet).values({
    show_id: currentShow.id,
    entry_type: 'show_end',
    dj_name: display_dj_name,
    play_order: await nextPlayOrder(currentShow.id),
    message,
  });

  // Return the row the UPDATE above finalized — never a re-read. The previous
  // `return (await getLatestShow())!` raced a concurrent POST /flowsheet/join:
  // a show N+1 created between the UPDATE and the re-read is what got
  // returned, and the mirror middleware then signed off the WRONG, still-live
  // show in tubafrenzy while show N's signoff was silently dropped (BS#1119
  // follow-up review).
  return finalizedShow;
};

export const leaveShow = async (dj_id: string, currentShow: Show): Promise<ShowDJ> => {
  const update_result = (
    await db
      .update(show_djs)
      .set({ active: false })
      .where(and(eq(show_djs.show_id, currentShow.id), eq(show_djs.dj_id, dj_id)))
      .returning()
  )[0];

  // In case gaurds further up the line of logic fail
  if (update_result === undefined) {
    throw new WxycError('Bad Request: DJ not a member of show', 400);
  }

  // -- Add DJ Left to Flowsheet --
  await createLeaveNotification(dj_id, currentShow.id);
  // -------------------------------

  return update_result;
};

const createLeaveNotification = async (dj_id: string, show_id: number): Promise<FSEntry | null> => {
  const dj = (await db.select().from(user).where(eq(user.id, dj_id)).limit(1))[0];

  const display_dj_name = resolveDjDisplayName(dj?.djName ?? null);

  // Symmetric to createJoinNotification: suppress the row and log a Sentry
  // warning when the DJ name is unresolvable (epic #1288).
  if (!display_dj_name) {
    Sentry.captureMessage('Suppressed dj_leave marker: DJ display name unresolvable', {
      level: 'warning',
      tags: { tool: 'flowsheet', entry_type: 'dj_leave' },
      extra: { dj_id, show_id },
    });
    return null;
  }

  const notification = await db
    .insert(flowsheet)
    .values({
      show_id: show_id,
      entry_type: 'dj_leave',
      dj_name: display_dj_name,
      play_order: await nextPlayOrder(show_id),
      message: `${display_dj_name} left the set!`,
    })
    .returning();

  return notification[0];
};

export const getNShows = async (numberOfShows: number = 1, page: number = 0): Promise<Show[]> => {
  return await db
    .select()
    .from(shows)
    .orderBy(desc(shows.id))
    .offset(page * numberOfShows)
    .limit(numberOfShows);
};

export const getLatestShow = async (): Promise<Show | undefined> => {
  return (await getNShows(1))[0];
};

/**
 * True when the most-recently-INSERTED flowsheet entry belonging to `showId`
 * is a `show_end` marker.
 *
 * Belt-and-braces guard for `joinShow` (BS#1861 option (b)). The tubafrenzy
 * webhook's stub-show flow can leave `shows.end_time` NULL for a window
 * after a legacy sign-off (`resolveShow`'s "Create a stub show" comment in
 * apps/backend/routes/internal.route.ts) — the webhook now also sets
 * `end_time` at write time as a fast-path (BS#1861 option (a)), but this is
 * a second, independent signal: a show whose last entry is `show_end` is
 * closed regardless of what `end_time` currently holds, so `joinShow` can
 * still route a go-live in that window to a new show even if the fast-path
 * write above raced or was somehow missed.
 *
 * Ordered by `id DESC` (insertion order), not `play_order DESC` —
 * `changeOrder` can renumber `play_order` for track reordering within a
 * show, but marker rows are never reordered.
 *
 * ITS OWN PREMISE IS FALSE FOR A HISTORICALLY-INSERTED SHOW — `id DESC` is
 * insertion order, NOT airtime order, so this is not a general "newest entry
 * in this show" query (BS#2118 site 5). A historical insert (backfill, gap
 * import, repair) into an ALREADY-CLOSED show receives an id higher than
 * that show's real terminal `show_end` marker, so this then answers `false`
 * for a show that is, in fact, closed. #2119's April gap-import cohort is
 * exactly this case: 403 rows land in 18 shows that already hold `show_end`
 * markers, and post-import this function would return `false` for all 18 if
 * it were ever called on them.
 *
 * It never is, and that — not caller intent — is what makes the cohort
 * inert. `joinShow` (`flowsheet.controller.ts`) only calls this function
 * inside its own `current_show.end_time === null &&` short-circuit, gating
 * on the SAME `end_time` fast-path this function's header comment describes
 * as independent of it; `current_show` itself comes from `getLatestShow` ->
 * `ORDER BY shows.id DESC LIMIT 1`, so `joinShow` always evaluates the
 * newest-by-insertion show, not a caller-chosen one. Measured 2026-08-12
 * (`plans/bs351-april-flowsheet-gap-import.md`): all 18 of #2119's affected
 * shows already carry a non-null `shows.end_time`, so `joinShow` never
 * reaches this function for any of them — the short-circuit short-circuits
 * before the stale answer would matter. Safety today lives entirely in that
 * caller-side `end_time` check, not in this function. A future caller of
 * `isLatestEntryShowEnd` without an equivalent `end_time` guard would be
 * exposed to the false-premise failure mode above; do not assume this
 * function is self-safe. For a general recency check on a row a historical
 * import could touch, order by `add_time` instead (see `getEntriesByPage`'s
 * comment for why `add_time` needs an explicit `id` tie-break too).
 */
export const isLatestEntryShowEnd = async (showId: number): Promise<boolean> => {
  const [latest] = await db
    .select({ entry_type: flowsheet.entry_type })
    .from(flowsheet)
    .where(eq(flowsheet.show_id, showId))
    // `id DESC` — see `lastLoggedShowEntryOrderBy` (@wxyc/database) for the
    // shared rationale this and its two siblings (site 7 below, site 8 in
    // jobs/legacy-mirror-reconcile) now hold in one place.
    .orderBy(...lastLoggedShowEntryOrderBy())
    .limit(1);
  return latest?.entry_type === 'show_end';
};

/**
 * Opportunistic `shows.end_time` backfill for a show whose terminal flowsheet
 * entry is a `show_end` marker but whose `end_time` never got stamped
 * (BS#2065). Returns the number of rows closed (0 or 1).
 *
 * Why this exists: the tubafrenzy webhook's `show_end` fast-path
 * (`internal.route.ts`, BS#1861 option (a)) writes the marker row and
 * `shows.end_time` from one clock reading per delivery. Since WXYC/wiki#88
 * Phase 3 unscheduled `flowsheet-etl`, that write is the ONLY thing that ever
 * closes a webhook-originated show — a delivery lost to a tubafrenzy restart,
 * a 500, or a network blip leaves the marker present and the column NULL, and
 * nothing repairs it. `addEntry` and `leaveShow` gate on the column, so the
 * departed DJ's show reads as live until the next show starts.
 *
 * The `WHERE end_time IS NULL` guard is carried over verbatim from that
 * fast-path and is load-bearing for the same reason: a later delivery of the
 * same `show_end`, or the deliberate authoritative pass in the Phase 6a window
 * (#1543 item 3, which repairs `end_time` alongside `start_time` from the
 * final tubafrenzy dump), must never be overwritten by a worse value.
 *
 * The written value is the marker row's own `add_time`, re-read inside the
 * statement rather than passed in — so the column stays consistent with the
 * marker's timestamp exactly as the fast-path leaves it, and the marker-type
 * check is re-evaluated atomically with the write (no TOCTOU against the
 * caller's separate `isLatestEntryShowEnd` read).
 *
 * Complement, never a substitute, for the BS#2065 detector in
 * `jobs/legacy-mirror-reconcile`: this only fires when someone next goes live.
 * A show nobody joins after stays open until that job reports it.
 *
 * BEST-EFFORT BY CONSTRUCTION. A DB error is reported to Sentry and swallowed,
 * returning 0. Its caller is `joinShow`, sitting between the BS#1861 option
 * (b) guard's read and the start-vs-join decision that guard drives: letting a
 * failed cosmetic backfill throw would 500 a go-live that (b) was about to
 * route correctly, turning the acute hazard (b) exists to prevent back on. The
 * detector still reports the show, so nothing is lost by failing quietly here.
 */
export const closeShowFromTerminalShowEndMarker = async (showId: number): Promise<number> => {
  // Last row LOGGED for this show — `id DESC`, in lockstep with
  // `isLatestEntryShowEnd` above (BS#2118 sites 5 and 7). The shared
  // rationale for the key, and what accepting it exposes, lives once in
  // `lastLoggedShowEntryOrderBy` (@wxyc/database) rather than in four
  // near-identical copies.
  //
  // THE LOCKSTEP IS LOAD-BEARING HERE SPECIFICALLY. This statement re-reads
  // the marker-type check atomically with its own write precisely so there is
  // no TOCTOU against the caller's separate `isLatestEntryShowEnd` read (see
  // the header above), and that guarantee holds only while both sides sort by
  // the same key. Change one and you must change the other in the same
  // commit — which is what the shared helper now makes hard to get wrong.
  const newestAddTime = sql`(SELECT ${flowsheet.add_time} FROM ${flowsheet}
      WHERE ${flowsheet.show_id} = ${showId} ORDER BY ${lastLoggedShowEntryOrderBySql()} LIMIT 1)`;
  const newestEntryType = sql`(SELECT ${flowsheet.entry_type} FROM ${flowsheet}
      WHERE ${flowsheet.show_id} = ${showId} ORDER BY ${lastLoggedShowEntryOrderBySql()} LIMIT 1)`;

  try {
    const closed = await db
      .update(shows)
      .set({ end_time: newestAddTime })
      .where(and(eq(shows.id, showId), isNull(shows.end_time), sql`${newestEntryType} = 'show_end'`))
      .returning({ id: shows.id });

    return closed.length;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: 'close-show-from-show-end-marker' },
      extra: { show_id: showId },
    });
    return 0;
  }
};

/**
 * True when `dj_id` is already an active participant in `show` — either the
 * primary DJ or a co-host whose `show_djs.active` is true.
 *
 * Belt-and-braces guard for `joinShow` (BS#1861 option (c)): a retried
 * "Go Live" toggle that lands on an already-open show for a DJ already live
 * on it is not a genuine join, and should not write another `dj_join`
 * marker (the issue's 16:37:59 duplicate-marker trace). `addDJToShow`
 * itself already no-ops the marker write when a co-host's `show_djs` row is
 * found active (it only inserts/notifies on first join or reactivates from
 * inactive) — this check makes that guarantee explicit at the call site and
 * additionally covers the primary DJ, whose `show_djs` row this check does
 * not assume is present.
 */
export const isDjAlreadyActiveOnShow = async (show: Show, dj_id: string): Promise<boolean> => {
  if (show.primary_dj_id === dj_id) return true;

  const [row] = await db
    .select({ active: show_djs.active })
    .from(show_djs)
    .where(and(eq(show_djs.show_id, show.id), eq(show_djs.dj_id, dj_id)))
    .limit(1);
  return row?.active === true;
};

/**
 * Display name shown on air for a live show whose DJ we cannot name — an
 * anonymous human at the controls. The most common cause is a tubafrenzy
 * sign-on with a blank `djHandle`, which leaves `shows.legacy_dj_name` null:
 * a human is genuinely live, we just don't have their handle. We surface the
 * station brand rather than lie about automation. See `getOnAirDJName`.
 */
export const ANONYMOUS_ON_AIR_NAME = 'WXYC';

/**
 * Resolve the display name of whoever is currently on air, or `null` when the
 * station is on automation.
 *
 * Backs the `on_air` field on the default paginated GET /flowsheet response.
 * A show is "on air" when the latest show (`MAX(shows.id)`) has no `end_time`;
 * its display name comes from `resolveDjNameForShow`, the same precedence chain
 * (`dj_name_override` → primary DJ's `user.djName` → `legacy_dj_name`) used to
 * denormalize DJ names onto flowsheet rows.
 *
 * The invariant callers rely on: **an open show is a human on air, so it always
 * returns a non-null name; `null` is reserved exclusively for automation (no
 * open show).** When the open show has no resolvable name — an anonymous human,
 * e.g. a tubafrenzy sign-on with a blank `djHandle` — this returns
 * `ANONYMOUS_ON_AIR_NAME` ("WXYC") rather than `null`. Downstream, a name
 * renders the banner and `null` renders "AUTO DJ"; collapsing the anonymous
 * case to `null` was the "AUTO DJ while a human DJ is live" bug for handleless
 * sign-ons.
 *
 * Deliberately does NOT consult the `show_djs` join table the way
 * `getDJsInCurrentShow`/`getOnAirStatusForDJ` do: tubafrenzy-mirrored shows have
 * no `show_djs` rows (the DJ has no Backend-Service account), so a join-table
 * read reports automation for essentially every legacy live show — the same
 * class of bug. `legacy_dj_name` is the authoritative identity for those shows,
 * and `resolveDjNameForShow` already reads it.
 *
 * Known limitation (inherited from the `getLatestShow`-based on-air endpoints):
 * legacy/tubafrenzy shows are created open (`end_time: null`) and closed later by
 * the ETL. Between a legacy show actually ending and the ETL stamping `end_time`,
 * this reports that show as live — i.e. `on_air` can name a just-departed DJ (or
 * "WXYC") during real automation. That is the lesser evil versus the
 * false-"Auto DJ" bug, and it is the practical limit of the "`null` means
 * automation" guarantee.
 *
 * @returns the on-air display name — a resolved DJ handle, or
 *   `ANONYMOUS_ON_AIR_NAME` when the open show has no resolvable name — or
 *   `null` only when no show is open (automation).
 */
export const getOnAirDJName = async (): Promise<string | null> => {
  const latest_show = await getLatestShow();
  if (!latest_show || latest_show.end_time !== null) {
    return null;
  }
  const resolved = (await resolveDjNameForShow(latest_show))?.trim();
  return resolved && resolved.length > 0 ? resolved : ANONYMOUS_ON_AIR_NAME;
};

/**
 * Whether the given user account is on air right now. Backs GET /flowsheet/on-air.
 *
 * This is a per-*user* liveness check: it asks whether `dj_id` is an active
 * member of the open show's `show_djs` join. It therefore cannot answer for
 * legacy/tubafrenzy-mirrored shows, whose on-air DJ has no `auth_user` row and
 * no `show_djs` membership (their identity is `shows.legacy_dj_name`) — there is
 * simply no `dj_id` to pass. The endpoint that surfaces legacy on-air identity
 * is GET /flowsheet/djs-on-air via `getOnAirDJs`; this one is intentionally left
 * account-scoped (BS#1547).
 */
export const getOnAirStatusForDJ = async (dj_id: string): Promise<boolean> => {
  const latest_show = await getLatestShow();
  if (!latest_show || latest_show.end_time !== null) {
    return false;
  }

  const show_djs = await getDJsInShow(latest_show.id, true);
  return show_djs.some((dj) => dj.id == dj_id);
};

export const getDJsInCurrentShow = async (): Promise<User[]> => {
  const current_show = await getLatestShow();
  if (!current_show || current_show.end_time !== null) {
    return [];
  }

  return getDJsInShow(current_show.id, true);
};

/**
 * The on-air DJ list backing GET /flowsheet/djs-on-air.
 *
 * When the open show has active `show_djs` rows (DJs with Backend-Service
 * accounts, including co-hosts), returns each with their `auth_user.id` string
 * and Anonymous-filtered `dj_name` — the pre-existing behavior, preserved
 * byte-for-byte (a filtered-away name yields `dj_name: null`, as it always has).
 *
 * When the open show has NO account rows, it is a legacy/tubafrenzy-mirrored
 * show whose DJ identity lives in `shows.legacy_dj_name`. Those shows previously
 * reported an empty list (the "Off Air while a human DJ is live" bug); here they
 * surface a single entry resolved via `resolveDjNameForShow` — the same
 * precedence chain (`dj_name_override` → primary DJ's `user.djName` →
 * `legacy_dj_name`) that `getOnAirDJName` uses for the banner — with a `null`
 * `id` because there is no user account. Returns `[]` when off air (no open
 * show) or when the open legacy show has no resolvable name.
 *
 * `id` is nullable because a legacy DJ has no `auth_user.id`; see wxyc-shared
 * `OnAirDJ` (BS#1547).
 */
export const getOnAirDJs = async (): Promise<Array<{ id: string | null; dj_name: string | null }>> => {
  const current_show = await getLatestShow();
  if (!current_show || current_show.end_time !== null) {
    return [];
  }

  const accountDJs = await getDJsInShow(current_show.id, true);
  if (accountDJs.length > 0) {
    return accountDJs.map((dj) => ({
      id: dj.id as string,
      dj_name: resolveDjDisplayName((dj.djName as string | null | undefined) ?? null),
    }));
  }

  // Legacy/tubafrenzy-mirrored show: no account rows; identity is legacy_dj_name.
  const legacyName = await resolveDjNameForShow(current_show);
  return legacyName ? [{ id: null, dj_name: legacyName }] : [];
};

export const getDJsInShow = async (show_id: number, activeOnly: boolean): Promise<User[]> => {
  let showDJsInstance: ShowDJ[];
  if (activeOnly) {
    showDJsInstance = await db
      .select()
      .from(show_djs)
      .where(and(eq(show_djs.show_id, show_id), eq(show_djs.active, true)));
  } else {
    showDJsInstance = await db.select().from(show_djs).where(eq(show_djs.show_id, show_id));
  }

  const dj_ids = showDJsInstance.map((dj) => {
    return dj.dj_id;
  });

  return await db.select().from(user).where(inArray(user.id, dj_ids));
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      artist_id: library.artist_id,
      artist_name: artists.artist_name,
      album_title: library.album_title,
      record_label: library.label,
      label_id: library.label_id,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .where(eq(library.id, album_id))
    .limit(1);

  return album[0];
};

// We use entry_id in order to avoid a race condition here.
// Using the id ensures we are pointing to a specific entry.
// Returns undefined when the post-commit confirmation read finds the row gone
// (a concurrent delete landed after the reorder transaction committed); the
// controller maps that to a 404 (PR #1532 review). A missing row at
// transaction START still throws the 404 WxycError inside the transaction.
export const changeOrder = async (entry_id: number, position_new: number): Promise<FSEntry | undefined> => {
  await db.transaction(
    async (trx) => {
      const result = await trx
        .select({
          play_order: flowsheet.play_order,
          show_id: flowsheet.show_id,
        })
        .from(flowsheet)
        .where(eq(flowsheet.id, entry_id))
        .limit(1);

      if (result.length === 0) {
        throw new WxycError(`Flowsheet entry ${entry_id} not found`, 404);
      }

      const position_old = result[0].play_order;
      const show_id = result[0].show_id;

      // Defensive: every flowsheet row has show_id post-#693. Be loud, not
      // silent, if the invariant ever breaks — an unscoped bump UPDATE
      // (#712) corrupts cross-show play_order ranges in ways that don't
      // surface until much later.
      if (show_id == null) {
        throw new WxycError(`Flowsheet entry ${entry_id} has no show_id`, 500);
      }

      if (position_new < position_old) {
        await trx
          .update(flowsheet)
          .set({ play_order: sql`play_order + 1` })
          .where(
            and(
              eq(flowsheet.show_id, show_id),
              gte(flowsheet.play_order, position_new),
              lte(flowsheet.play_order, position_old - 1)
            )
          );
      } else if (position_new > position_old) {
        await trx
          .update(flowsheet)
          .set({ play_order: sql`play_order - 1` })
          .where(
            and(
              eq(flowsheet.show_id, show_id),
              gte(flowsheet.play_order, position_old + 1),
              lte(flowsheet.play_order, position_new)
            )
          );
      }

      await trx.update(flowsheet).set({ play_order: position_new }).where(eq(flowsheet.id, entry_id));
    },
    {
      isolationLevel: 'read committed',
      accessMode: 'read write',
      deferrable: true,
    }
  );

  // Filter by id, not play_order — post-#693 multiple shows legitimately
  // share play_order values, so `WHERE play_order = ? LIMIT 1` could
  // surface a row from a different show.
  const response = await db.select().from(flowsheet).where(eq(flowsheet.id, entry_id)).limit(1);

  return response[0];
};

/**
 * Gets show metadata (DJs, specialty show name) without fetching entries.
 * Returns `undefined` when `show_id` doesn't exist (BS#1113) — mirrors the
 * `library.service.ts:getAlbumFromDB` convention; the controller translates
 * this to a 404.
 */
export const getShowMetadata = async (show_id: number): Promise<ShowMetadata | undefined> => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

  if (!show[0]) return undefined;

  const showDJs = (await getDJsInShow(show_id, false)).map((dj) => ({
    id: dj.id,
    dj_name: resolveDjDisplayName(dj.djName ?? null),
  }));

  let specialty_show_name = '';
  if (show[0].specialty_id != null) {
    const specialty_show = await db.select().from(specialty_shows).where(eq(specialty_shows.id, show[0].specialty_id));
    specialty_show_name = specialty_show[0].specialty_name;
  }

  return {
    ...show[0],
    specialty_show_name: specialty_show_name,
    show_djs: showDJs,
  };
};

/**
 * Transform a V1 flowsheet entry to V2 discriminated union format.
 * Removes irrelevant fields based on entry_type for cleaner API responses.
 */
/**
 * The minimal row shape {@link attachUpcomingShows} reads and writes — a
 * structural subset of `IFSEntry`, so the `/flowsheet` read paths satisfy it
 * unchanged. Stated as a `Pick` (not a hand-written literal) so a rename on
 * `IFSEntry` is a compile error here rather than a silent fork.
 *
 * It exists because BS#2103 attaches the same enrichment to the legacy
 * `recentEntries?v=2` payload, whose rows are not `IFSEntry`s. Widening the
 * parameter is a type-level change only: the runtime body is untouched.
 */
export type UpcomingShowAttachable = Pick<IFSEntry, 'entry_type' | 'artist_id' | 'artist_name' | 'upcoming_show'>;

/**
 * Attach the per-playcut `upcoming_show` enrichment to a feed page of entries
 * (BS#1607, widened to a hybrid id-arm ∪ name-arm match in BS#1613; touring-
 * events Phase 3).
 *
 * Batched — ONE indexed concerts query for the whole page via
 * `getUpcomingShowsMapsCached`, never one per row (the no-N+1 guarantee; project
 * #32 perf posture). And that query only fires on a cold build: the wrapper
 * memoizes the maps per ET day for a short TTL (BS#1616), so the hot poll path
 * (`getLatest`) skips the concerts scan entirely on warm reads. Each track row
 * resolves through two arms, id first:
 *   1. id arm — `byArtistId.get(artist_id)`: the album-resolved catalog artist
 *      (`flowsheet.album_id → library.artist_id`) matched a resolved concert.
 *      Precise; the sole BS#1607 path, kept as-is (regression-guarded).
 *   2. name arm (BS#1613) — `byNormName.get(normalizeFreetextArtist(artist_name))`:
 *      catches FREE-TEXT plays (no `album_id`, so no `artist_id`) and CLEAN
 *      UNRESOLVED concerts (touring artists absent from our catalog). Uses the
 *      free-text match SSOT (`normalizeArtistName` + collapse internal
 *      whitespace + trim) — the SAME normalizer the concert side keys with, so
 *      incidental spacing can't split the key and the two sides are provably
 *      drift-free.
 *
 * The name arm keys only on a non-empty `artist_name` (`?.trim()`), so a blank
 * free-text name can't form a `''` key that collides. Rows that match neither
 * arm are returned unchanged (`upcoming_show` stays absent) — the wire shape is
 * byte-identical to pre-1607 for the no-match case (additive/optional field).
 *
 * "Today" is America/New_York (`nyCalendarDate`), matching `GET /concerts`'s
 * default `from`: `starts_on` is a venue-local calendar date, so a UTC "today"
 * would flip the window at 8 PM Eastern and prematurely drop tonight's shows.
 *
 * Returns the same array reference with the matched entries mutated in place;
 * the caller maps the result through `transformToV2`, which reads
 * `entry.upcoming_show`.
 */
export const attachUpcomingShows = async <T extends UpcomingShowAttachable>(entries: T[]): Promise<T[]> => {
  // Skip the DB only when NO track row could match either arm: a track matches
  // the id arm with a non-null artist_id, or the name arm with a non-empty
  // artist_name. (Almost every track carries a name, so this mainly short-
  // circuits all-marker pages.)
  // `entry?.` guards a transient nullish array element (Sentry
  // BACKEND-SERVICE-2T / BS#1864) — statically every element of `entries`
  // should be a real IFSEntry, but a bad element must not 500 the prefilter.
  const hasMatchableTrack = entries.some(
    (entry) => entry?.entry_type === 'track' && (entry.artist_id !== null || !!entry.artist_name?.trim())
  );
  if (!hasMatchableTrack) {
    return entries;
  }

  const { byArtistId, byNormName } = await getUpcomingShowsMapsCached(nyCalendarDate(new Date()));

  for (const entry of entries) {
    // Same defensive guard as the prefilter above (Sentry BACKEND-SERVICE-2T /
    // BS#1864): skip a falsy element instead of reading `.entry_type` off it.
    if (!entry || entry.entry_type !== 'track') {
      continue;
    }
    const byId = entry.artist_id !== null ? byArtistId.get(entry.artist_id) : undefined;
    const byName =
      byId === undefined && entry.artist_name?.trim()
        ? byNormName.get(normalizeFreetextArtist(entry.artist_name))
        : undefined;
    const show = byId ?? byName;
    if (show !== undefined) {
      entry.upcoming_show = show;
    }
  }
  return entries;
};

/**
 * The minimal row shape {@link attachCriticReviews} reads and writes. Same
 * `Pick`-of-`IFSEntry` rationale as {@link UpcomingShowAttachable} above.
 */
export type CriticReviewAttachable = Pick<IFSEntry, 'entry_type' | 'album_id' | 'critic_reviews'>;

/**
 * Attach batched critic-review snippets to a feed page of entries
 * (album-critic-reviews slice, ADR 0012; BS#1870). Modeled directly on
 * {@link attachUpcomingShows} — same "batch a page, mutate in place" shape —
 * but deliberately narrower in two ways:
 *
 *   1. **Id-arm only.** Keys strictly on the track's resolved `album_id`
 *      (`flowsheet.album_id`, populated only for library-linked plays) via
 *      {@link lookupCriticReviewsByAlbumIds}. There is NO name-arm fallback
 *      like `attachUpcomingShows`'s BS#1613 hybrid — a review must never
 *      attach by fuzzy artist-name match, only by the exact linked album,
 *      mirroring the `album-critic-reviews-etl` writer's own exact-match
 *      ceiling (it never guesses an album for a review either).
 *   2. **Flag-gated.** Early-returns without touching the DB when
 *      `getCriticReviewsConfig().enabled` is false — the same
 *      `CRITIC_REVIEWS_ENABLED` gate `proxy.controller.ts`'s
 *      `/proxy/metadata/album` handler uses. Default off, so this attach adds
 *      zero queries to the hot public flowsheet path until an operator opts
 *      in (Post-launch service hardening / project #32 posture).
 *   3. **Fails open.** The lookup + fan-out runs inside its own try/catch:
 *      a DB error is reported via `Sentry.captureException` and swallowed,
 *      returning `entries` unmodified (no `critic_reviews` attached) rather
 *      than rejecting. This is called `Promise.all`'d with
 *      `attachUpcomingShows` at every `GET /flowsheet` call site, and
 *      `CRITIC_REVIEWS_ENABLED` is already on in prod, so an unguarded
 *      rejection here would 500 the hottest public endpoint on a mere
 *      `album_critic_reviews` blip — the same "strictly additive, must never
 *      break the response" contract `proxy.controller.ts` applies to this
 *      identical lookup on the metadata-proxy serve path.
 *
 * Batched — ONE indexed `album_critic_reviews` query for the whole page via
 * `lookupCriticReviewsByAlbumIds`, never one per row (the same no-N+1
 * guarantee `attachUpcomingShows` documents). Unlike the concerts maps, this
 * is NOT memoized: the key set (the page's distinct `album_id`s) varies per
 * page and the query is a plain indexed lookup, so a short-TTL cache would
 * mostly miss while adding bookkeeping for no real savings.
 *
 * Watermark/staleness note (document, don't engineer): `GET /flowsheet` and
 * `GET /flowsheet/latest` 304 on the flowsheet watermark (`conditionalGet`,
 * BS#902/BS#1689). The weekly `album-critic-reviews-etl` (BS#1830) writes
 * only `album_critic_reviews` and does not advance that watermark, so a
 * freshly-written review can stay masked behind a stale 304 until the next
 * ordinary flowsheet mutation — potentially minutes during a live broadcast.
 * This is accepted: unlike the concerts ET-midnight fold (which corrects a
 * genuine correctness cliff — a past show's CTA would otherwise render
 * indefinitely), a late-surfacing review is a freshness lag with no
 * incorrect state, so it is not worth folding into the watermark.
 *
 * Returns the same array reference with matched entries mutated in place;
 * the caller maps the result through `transformToV2`, which reads
 * `entry.critic_reviews`.
 */
export const attachCriticReviews = async <T extends CriticReviewAttachable>(entries: T[]): Promise<T[]> => {
  if (!getCriticReviewsConfig().enabled) {
    return entries;
  }

  // Same defensive `entry?.` guard as attachUpcomingShows's prefilter
  // (Sentry BACKEND-SERVICE-2T / BS#1864): a transient nullish array element
  // must not throw here either.
  const hasLinkedTrack = entries.some((entry) => entry?.entry_type === 'track' && entry.album_id !== null);
  if (!hasLinkedTrack) {
    return entries;
  }

  const albumIds = [
    ...new Set(
      entries
        .filter((entry): entry is T & { album_id: number } => {
          return !!entry && entry.entry_type === 'track' && entry.album_id !== null;
        })
        .map((entry) => entry.album_id)
    ),
  ];

  // Same "strictly additive, must never break the response" contract
  // proxy.controller.ts's `/proxy/metadata/album` handler applies to this
  // exact lookup (see its comment there). Here the stakes are higher: this
  // runs Promise.all'd with attachUpcomingShows at all 5 GET /flowsheet call
  // sites, and CRITIC_REVIEWS_ENABLED is already true in prod, so an
  // unguarded rejection here would 500 the hottest public endpoint on a mere
  // album_critic_reviews DB blip. Degrade to "no cards" instead: report to
  // Sentry and hand the page back untouched.
  try {
    const reviewsByAlbumId = await lookupCriticReviewsByAlbumIds(albumIds);

    for (const entry of entries) {
      if (!entry || entry.entry_type !== 'track' || entry.album_id === null) {
        continue;
      }
      const reviews = reviewsByAlbumId.get(entry.album_id);
      if (reviews !== undefined && reviews.length > 0) {
        entry.critic_reviews = reviews;
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: 'attach-critic-reviews' },
      extra: { album_id_count: albumIds.length },
    });
  }
  return entries;
};

export const transformToV2 = (entry: IFSEntry): Record<string, unknown> => {
  const baseFields = {
    id: entry.id,
    show_id: entry.show_id,
    play_order: entry.play_order,
    add_time: entry.add_time,
    entry_type: entry.entry_type,
  };

  // For marker entry types (show_start, show_end, dj_join, dj_leave), dj_name is
  // surfaced directly from the flowsheet.dj_name column — see the v2 contract in
  // apps/backend/app.yaml. Track entries do not include dj_name in the v2 payload
  // (the artist_name / album_title / track_title fields carry the relevant
  // attribution); flowsheet.dj_name on track rows exists solely for the search
  // service's hot path (search.service.ts, originally steps 5b.1-5b.3).
  switch (entry.entry_type) {
    case 'track':
      return {
        ...baseFields,
        album_id: entry.album_id,
        rotation_id: entry.rotation_id,
        // Resolved catalog artist id (flowsheet.album_id -> library.artist_id),
        // already computed on the read path (FSEntryFieldsRaw). Additive,
        // nullable wire field (BS#1625): null for free-form entries (no
        // album_id) and library rows with no artist link. Shares the artists.id
        // keyspace with concerts.headlining_artist_id / upcoming_show, so the
        // iOS On Tour likes match can intersect a liked playcut against
        // concert headliners. SSOT: FlowsheetV2TrackEntry.artist_id (wxyc-shared
        // api.yaml 1.19.0).
        artist_id: entry.artist_id ?? null,
        artist_name: entry.artist_name,
        album_title: entry.album_title,
        track_title: entry.track_title,
        track_position: entry.track_position ?? null,
        record_label: entry.record_label,
        label_id: entry.label_id,
        request_flag: entry.request_flag,
        segue: entry.segue,
        rotation_bin: entry.rotation_bin,
        artwork_url: entry.metadata?.artwork_url ?? null,
        discogs_url: entry.metadata?.discogs_url ?? null,
        release_year: entry.metadata?.release_year ?? null,
        spotify_url: entry.metadata?.spotify_url ?? null,
        apple_music_url: entry.metadata?.apple_music_url ?? null,
        youtube_music_url: entry.metadata?.youtube_music_url ?? null,
        bandcamp_url: entry.metadata?.bandcamp_url ?? null,
        soundcloud_url: entry.metadata?.soundcloud_url ?? null,
        artist_bio: entry.metadata?.artist_bio ?? null,
        artist_wikipedia_url: entry.metadata?.artist_wikipedia_url ?? null,
        // Arrays coerce empty→null (unlike the sibling scalars' plain `?? null`):
        // a `'{}'` album_metadata row carries no information, so it collapses to
        // the same `null` the contract uses for "absent". See BS#1441 rationale.
        genres: entry.metadata?.genres?.length ? entry.metadata.genres : null,
        styles: entry.metadata?.styles?.length ? entry.metadata.styles : null,
        on_streaming: entry.on_streaming ?? null,
        // BS#1908 (Not-on-Discogs epic #1280): MD-set discogs-unavailable flag
        // on the V2 flowsheet album embed, matching BS#1895's other read
        // surfaces and the already-published wxyc-shared@3.2.0 contract
        // (FlowsheetEntryResponse.discogsUnavailable — boolean, NOT required;
        // discogsUnavailableNote — nullable string). Wire is deliberately
        // camelCase (the `withDiscogsUnavailableCamelCase` convention),
        // unlike the snake_case siblings above. Emitted only when this track
        // resolved to a library row (`entry.discogs_unavailable !== null`) —
        // a freeform/unlinked track omits the field entirely rather than
        // sending `null`/`false`, mirroring the upcoming_show/critic_reviews
        // present-or-absent projection pattern below. The note is emitted
        // independently whenever non-null (a library row can have the flag
        // set with no note, or not have a library row at all — both leave
        // discogs_unavailable_note null, so this single check covers both).
        ...(entry.discogs_unavailable !== null ? { discogsUnavailable: entry.discogs_unavailable } : {}),
        ...(entry.discogs_unavailable_note !== null ? { discogsUnavailableNote: entry.discogs_unavailable_note } : {}),
        // BS#891. iOS branches on this to decide whether to render inline
        // metadata or fall back to the proxy-fetch path
        // (WXYC/wxyc-ios-64#270). Always present on track rows once the
        // column ships; `pending` is the default for newly-inserted rows.
        metadata_status: entry.metadata_status,
        // Per-playcut upcoming-show enrichment (BS#1607). The key is emitted
        // ONLY when `attachUpcomingShows` matched a curated upcoming concert
        // for this track's artist — a no-match track row is byte-identical to
        // its pre-1607 shape (the parity requirement), and iOS decodes the
        // absent field as "no touring CTA". The SSOT field is optional +
        // nullable, so this present-or-absent projection is spec-conformant.
        ...(entry.upcoming_show ? { upcoming_show: entry.upcoming_show } : {}),
        // Batched critic-review snippets (BS#1870). Emitted ONLY when
        // `attachCriticReviews` found at least one seeded review for this
        // track's `album_id` (flag on + a linked album with reviews) — absent
        // otherwise, so a no-match or flag-off track row is byte-identical to
        // its pre-1870 shape. Mirrors the `upcoming_show` present-or-absent
        // projection above.
        ...(entry.critic_reviews && entry.critic_reviews.length > 0 ? { critic_reviews: entry.critic_reviews } : {}),
      };

    case 'show_start':
    case 'show_end': {
      const timestamp = entry.add_time ? entry.add_time.toLocaleString('en-US', { timeZone: 'America/New_York' }) : '';
      return {
        ...baseFields,
        dj_name: entry.dj_name ?? '',
        timestamp,
      };
    }

    case 'dj_join':
    case 'dj_leave':
      return {
        ...baseFields,
        dj_name: entry.dj_name ?? '',
      };

    case 'talkset':
    case 'message':
      return {
        ...baseFields,
        message: entry.message,
      };

    case 'breakpoint':
      return {
        ...baseFields,
        message: entry.message,
        // The authoritative top-of-hour (BS#1449). Date here; res.json emits ISO
        // (or null). Clients format this instead of the early add_time.
        radio_hour: entry.radio_hour,
      };

    default: {
      // Fallback for unknown types - return all fields
      const { metadata, ...rest } = entry;
      return { ...rest, ...metadata };
    }
  }
};
