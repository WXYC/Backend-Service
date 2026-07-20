import { sql, desc, eq, and, lte, gte, inArray } from 'drizzle-orm';
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
} from '@wxyc/database';
import { isSpotifyUrl, isAppleMusicUrl } from '@wxyc/lml-client';
import { getUpcomingShowsMapsCached } from './concerts.service.js';
import { IFSEntry, ShowMetadata, UpdateRequestBody } from '../controllers/flowsheet.controller.js';
import { PgSelectQueryBuilder, QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * Resolve the DJ display name shown to listeners on the public flowsheet.
 *
 * Rules:
 *   1. Use `djName` (the user's stage handle on `auth_user.dj_name`).
 *   2. Treat the literal string "Anonymous" (case- and whitespace-insensitive)
 *      as if `djName` were absent. The better-auth anonymous plugin and a
 *      since-corrected onboarding default were both observed writing the
 *      literal "Anonymous" into `auth_user.dj_name`; rendering that string
 *      to the public on-air playlist confused listeners and the wxyc.info
 *      playlist (BS#1286, epic #1288, 2026-06-02 Aubrey Hearst on-air
 *      incident).
 *   3. Trim the returned value; return `null` if blank or Anonymous.
 *
 * Why this no longer falls back to `auth_user.name`: dj-site's admin
 * provisioning flow writes the user's real name into `auth_user.name`
 * (`name: newAccount.realName || newAccount.username` in roster UI), so
 * surfacing `name` on the public v2 flowsheet wire would leak PII —
 * exactly the same class of incident BS#1286 fixed for the 'Anonymous'
 * literal. Real names are appropriate for DJ-to-DJ internal views; they
 * are not appropriate for the public on-air playlist.
 *
 * Callers should treat `null` as "name is unresolvable" and either degrade
 * the marker template (show_start / show_end keep a row but drop the name)
 * or suppress the row entirely and log to Sentry (dj_join / dj_leave) —
 * see `startShow`, `endShow`, `createJoinNotification`,
 * `createLeaveNotification`.
 */
export const resolveDjDisplayName = (djName: string | null): string | null => {
  const trimmedDjName = djName?.trim() ?? '';
  if (trimmedDjName.length > 0 && trimmedDjName.toLowerCase() !== 'anonymous') {
    return trimmedDjName;
  }
  return null;
};

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
  // Tie-break (`ORDER BY r2.id`): the schema source comment at `rotation` explicitly
  // permits multiple active rows per (album_id, rotation_bin) over an album's lifecycle
  // (re-bins, re-adds, label-driven re-promotes). Picking the lowest `id` (oldest active
  // row) is a deliberate, stable choice for the badge UX — when an album has been re-binned
  // L → M, the badge reports its original cohort rather than flipping retroactively. This
  // matches the historical-correctness story above (add_date/kill_date window filtered against add_time).
  // The primary FK join via flowsheet.rotation_id remains canonical when present.
  rotation_bin: sql<string | null>`
    COALESCE(
      ${rotation.rotation_bin},
      CASE WHEN ${flowsheet.rotation_id} IS NULL
        AND coalesce(${flowsheet.artist_name}, '') <> ''
        AND coalesce(${flowsheet.album_title}, '') <> ''
      THEN (
        SELECT r2.rotation_bin
        FROM ${rotation} r2
        LEFT JOIN ${library} l2 ON l2.id = r2.album_id
        LEFT JOIN ${artists} a2 ON a2.id = l2.artist_id
        WHERE r2.add_date <= ${flowsheet.add_time}::date
          AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
          AND (
            (${flowsheet.album_id} IS NOT NULL AND r2.album_id = ${flowsheet.album_id})
            OR (
              lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
              AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
            )
            OR (
              lower(trim(coalesce(a2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
              AND lower(trim(coalesce(l2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
            )
          )
        ORDER BY r2.id
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
  artwork_url: sql<string | null>`coalesce(${album_metadata.artwork_url}, ${flowsheet.artwork_url})`,
  // discogs_url additionally NULLIFs the '' synthetic-match sentinel LML
  // persists for streaming-only/artist-only matches (LML#401/#487) so it
  // never reaches the wire (BS#1628). NULLIF wraps the COALESCE — an ''
  // verdict in album_metadata stays authoritative over a stale inline URL
  // rather than falling through to it. The persisted '' is deliberate
  // (BS#1185 keys off it); only the projection normalizes.
  discogs_url: sql<string | null>`nullif(coalesce(${album_metadata.discogs_url}, ${flowsheet.discogs_url}), '')`,
  release_year: sql<number | null>`coalesce(${album_metadata.release_year}, ${flowsheet.release_year})`,
  spotify_url: sql<string | null>`coalesce(${album_metadata.spotify_url}, ${flowsheet.spotify_url})`,
  apple_music_url: sql<string | null>`coalesce(${album_metadata.apple_music_url}, ${flowsheet.apple_music_url})`,
  youtube_music_url: sql<string | null>`coalesce(${album_metadata.youtube_music_url}, ${flowsheet.youtube_music_url})`,
  bandcamp_url: sql<string | null>`coalesce(${album_metadata.bandcamp_url}, ${flowsheet.bandcamp_url})`,
  soundcloud_url: sql<string | null>`coalesce(${album_metadata.soundcloud_url}, ${flowsheet.soundcloud_url})`,
  artist_bio: sql<string | null>`coalesce(${album_metadata.artist_bio}, ${flowsheet.artist_bio})`,
  artist_wikipedia_url: sql<
    string | null
  >`coalesce(${album_metadata.artist_wikipedia_url}, ${flowsheet.artist_wikipedia_url})`,
  // genres/styles live ONLY on album_metadata (no inline flowsheet column to
  // COALESCE over), so these are plain column reads. BS#1441.
  genres: album_metadata.genres,
  styles: album_metadata.styles,
  on_streaming: library.on_streaming,
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
  // BS#1714: suppress a persisted `spotify_url`/`apple_music_url` whose host
  // isn't Spotify/Apple (mislabeled at the LML boundary before #1712 shipped)
  // so it never reaches the hardwired iOS "Spotify"/"Apple Music" button. No
  // synthesized fallback exists at this seam, so a mislabeled value drops to
  // null. Applied once and reused for both the top-level field and the nested
  // `metadata` object below.
  const spotify_url = isSpotifyUrl(raw.spotify_url) ? raw.spotify_url : null;
  const apple_music_url = isAppleMusicUrl(raw.apple_music_url) ? raw.apple_music_url : null;
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
  const override = ((show.dj_name_override as string | null | undefined) ?? '').trim();
  if (override.length > 0) return override;

  const legacy = (show.legacy_dj_name as string | null | undefined) ?? null;
  const primaryDjId = (show.primary_dj_id as string | null | undefined) ?? null;

  if (primaryDjId == null) return legacy;

  const rows = await db.select({ djName: user.djName }).from(user).where(eq(user.id, primaryDjId)).limit(1);
  const dj = rows[0];
  if (!dj) return legacy;
  const filteredDjName = resolveDjDisplayName(dj.djName ?? null);
  if (filteredDjName) return filteredDjName;
  if (legacy && legacy.trim().length > 0) return legacy.trim();
  return null;
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

/** Gets flowsheet entries by page with metadata joins */
export const getEntriesByPage = async (offset: number, limit: number): Promise<IFSEntry[]> => {
  const raw = await db
    .select(FSEntryFieldsRaw)
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .leftJoin(library, eq(library.id, flowsheet.album_id))
    .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .orderBy(desc(flowsheet.id))
    .offset(offset)
    .limit(limit);
  return raw.map(transformToIFSEntry);
};

export const getEntriesByRange = async (startId: number, endId: number): Promise<IFSEntry[]> => {
  // play_order is per-show after #693; id is globally monotonic across shows.
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

  await db.update(shows).set({ end_time: new Date() }).where(eq(shows.id, currentShow.id));

  // We just ended this show, so a latest show always exists here
  return (await getLatestShow())!;
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
 * Resolve the display name of the DJ currently on air, or `null` when the
 * station is on automation.
 *
 * Backs the `on_air` field on the default paginated GET /flowsheet response.
 * A show is "on air" when the latest show (`MAX(shows.id)`) has no `end_time`;
 * its display name comes from `resolveDjNameForShow`, the same precedence chain
 * (`dj_name_override` → primary DJ's `user.djName` → `legacy_dj_name`) used to
 * denormalize DJ names onto flowsheet rows.
 *
 * Deliberately does NOT consult the `show_djs` join table the way
 * `getDJsInCurrentShow`/`getOnAirStatusForDJ` do: tubafrenzy-mirrored shows have
 * no `show_djs` rows (the DJ has no Backend-Service account), so a join-table
 * read reports automation for essentially every legacy live show — the "AUTO DJ
 * while a human DJ is live" bug. `legacy_dj_name` is the authoritative identity
 * for those shows, and `resolveDjNameForShow` already reads it.
 *
 * Known limitation (inherited from the `getLatestShow`-based on-air endpoints):
 * legacy/tubafrenzy shows are created open (`end_time: null`) and closed later by
 * the ETL. Between a legacy show actually ending and the ETL stamping `end_time`,
 * this reports that DJ as live — i.e. `on_air` can name a just-departed DJ during
 * real automation. That is the lesser evil versus the false-"Auto DJ" bug this
 * fixes, and it is the practical limit of the "`null` means automation" guarantee.
 *
 * @returns the on-air DJ's display name, or `null` when no show is open or the
 *   open show has no resolvable name.
 */
export const getOnAirDJName = async (): Promise<string | null> => {
  const latest_show = await getLatestShow();
  if (!latest_show || latest_show.end_time !== null) {
    return null;
  }
  return await resolveDjNameForShow(latest_show);
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

/** Gets show metadata (DJs, specialty show name) without fetching entries */
export const getShowMetadata = async (show_id: number): Promise<ShowMetadata> => {
  const show = await db.select().from(shows).where(eq(shows.id, show_id));

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
export const attachUpcomingShows = async (entries: IFSEntry[]): Promise<IFSEntry[]> => {
  // Skip the DB only when NO track row could match either arm: a track matches
  // the id arm with a non-null artist_id, or the name arm with a non-empty
  // artist_name. (Almost every track carries a name, so this mainly short-
  // circuits all-marker pages.)
  const hasMatchableTrack = entries.some(
    (entry) => entry.entry_type === 'track' && (entry.artist_id !== null || !!entry.artist_name?.trim())
  );
  if (!hasMatchableTrack) {
    return entries;
  }

  const { byArtistId, byNormName } = await getUpcomingShowsMapsCached(nyCalendarDate(new Date()));

  for (const entry of entries) {
    if (entry.entry_type !== 'track') {
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
