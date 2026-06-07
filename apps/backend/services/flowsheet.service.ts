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
} from '@wxyc/database';
import { IFSEntry, ShowInfo, ShowMetadata, UpdateRequestBody } from '../controllers/flowsheet.controller.js';
import { PgSelectQueryBuilder, QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * Resolve the DJ display name shown to listeners on the public flowsheet,
 * applying the rules locked by the 2026-06-02 Aubrey Hearst on-air incident
 * (WXYC/Backend-Service#1286, epic #1288):
 *
 *   1. Prefer `djName` (the user's stage handle on `auth_user.dj_name`).
 *   2. Fall back to `name` (better-auth `auth_user.name`).
 *   3. Treat the literal string "Anonymous" (case- and whitespace-insensitive)
 *      as if `djName` were absent. The better-auth anonymous plugin and a
 *      since-corrected onboarding default were both observed writing the
 *      literal "Anonymous" into `auth_user.dj_name`; rendering that string to
 *      the public on-air playlist confuses listeners and the wxyc.info playlist.
 *   4. Trim returned values; return `null` if both inputs are blank or
 *      Anonymous-with-no-fallback.
 *
 * Callers should treat `null` as "name is unresolvable" and either degrade
 * the marker template (show_start / show_end keep a row but drop the name) or
 * suppress the row entirely and log to Sentry (dj_join / dj_leave) — see
 * `startShow`, `endShow`, `createJoinNotification`, `createLeaveNotification`.
 */
export const resolveDjDisplayName = (djName: string | null, name: string | null): string | null => {
  const trimmedDjName = djName?.trim() ?? '';
  if (trimmedDjName.length > 0 && trimmedDjName.toLowerCase() !== 'anonymous') {
    return trimmedDjName;
  }
  const trimmedName = name?.trim() ?? '';
  if (trimmedName.length > 0) {
    return trimmedName;
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
 */
export const getLastModifiedAt = async (): Promise<Date> => {
  const result = await db.select({ at: flowsheet_watermark.last_modified_at }).from(flowsheet_watermark).limit(1);
  return result[0]?.at ?? new Date(0);
};

// SQL query fields (flat structure from database)
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
  // kill_date is compared against the flowsheet entry's add_time so historical rotation
  // status is preserved — mirrors how tubafrenzy classifies at mirror time (WXYC/dj-site#750).
  // Subquery only fires per-row on a missed FK join; on rows with a populated rotation_id
  // COALESCE short-circuits and the subquery is not evaluated.
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
        WHERE (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
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
  discogs_url: sql<string | null>`coalesce(${album_metadata.discogs_url}, ${flowsheet.discogs_url})`,
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
  on_streaming: library.on_streaming,
  metadata_status: flowsheet.metadata_status,
  enriching_since: flowsheet.enriching_since,
};

// Raw result type from SQL query
type FSEntryRaw = {
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
  on_streaming: boolean | null;
  metadata_status: FSEntry['metadata_status'];
  enriching_since: Date | null;
};

/** Transform flat SQL result to nested IFSEntry structure */
const transformToIFSEntry = (raw: FSEntryRaw): IFSEntry => ({
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
  spotify_url: raw.spotify_url,
  apple_music_url: raw.apple_music_url,
  youtube_music_url: raw.youtube_music_url,
  bandcamp_url: raw.bandcamp_url,
  soundcloud_url: raw.soundcloud_url,
  artist_bio: raw.artist_bio,
  artist_wikipedia_url: raw.artist_wikipedia_url,
  on_streaming: raw.on_streaming ?? null,
  metadata_status: raw.metadata_status,
  enriching_since: raw.enriching_since,
  // Nested metadata view (used by transformToV2)
  metadata: {
    artwork_url: raw.artwork_url,
    discogs_url: raw.discogs_url,
    release_year: raw.release_year,
    spotify_url: raw.spotify_url,
    apple_music_url: raw.apple_music_url,
    youtube_music_url: raw.youtube_music_url,
    bandcamp_url: raw.bandcamp_url,
    soundcloud_url: raw.soundcloud_url,
    artist_bio: raw.artist_bio,
    artist_wikipedia_url: raw.artist_wikipedia_url,
  },
});

/**
 * Resolve the DJ name for a show using the priority:
 *   1. `shows.dj_name_override` (per-show operator-intent override, BS#1321)
 *   2. `auth_user.dj_name` (filtered for the literal "Anonymous", see
 *      `resolveDjDisplayName`)
 *   3. `shows.legacy_dj_name` (tubafrenzy-owned; "DJ name at time of the
 *      show for shows whose primary_dj_id couldn't be resolved")
 *   4. `auth_user.name`
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
 */
export const resolveDjNameForShow = async (show: Show): Promise<string | null> => {
  const override = ((show.dj_name_override as string | null | undefined) ?? '').trim();
  if (override.length > 0) return override;

  const legacy = (show.legacy_dj_name as string | null | undefined) ?? null;
  const primaryDjId = (show.primary_dj_id as string | null | undefined) ?? null;

  if (primaryDjId == null) return legacy;

  const rows = await db
    .select({ djName: user.djName, name: user.name })
    .from(user)
    .where(eq(user.id, primaryDjId))
    .limit(1);
  const dj = rows[0];
  if (!dj) return legacy;
  // Apply the same Anonymous / blank filtering used everywhere else, but
  // splice the legacy_dj_name in as a middle priority so existing imports
  // continue to surface on shows whose auth_user has no usable handle.
  const filteredDjName = resolveDjDisplayName(dj.djName ?? null, null);
  if (filteredDjName) return filteredDjName;
  if (legacy && legacy.trim().length > 0) return legacy.trim();
  return resolveDjDisplayName(null, dj.name ?? null);
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
    .orderBy(desc(flowsheet.play_order));

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

export const removeTrack = async (entry_id: number): Promise<FSEntry> => {
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

export const updateEntry = async (entry_id: number, entry: UpdateRequestBody): Promise<FSEntry> => {
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
  const display_dj_name = effective_override ?? resolveDjDisplayName(dj_info.djName ?? null, dj_info.name ?? null);
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

  const display_dj_name = resolveDjDisplayName(dj?.djName ?? null, dj?.name ?? null);

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
  const display_dj_name = resolveDjDisplayName(dj_information?.djName ?? null, dj_information?.name ?? null);
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

  const display_dj_name = resolveDjDisplayName(dj?.djName ?? null, dj?.name ?? null);

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
export const changeOrder = async (entry_id: number, position_new: number): Promise<FSEntry> => {
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
    dj_name: resolveDjDisplayName(dj.djName ?? null, dj.name ?? null),
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

export const getPlaylist = async (show_id: number): Promise<ShowInfo> => {
  const [metadata, entries] = await Promise.all([
    getShowMetadata(show_id),
    db.select().from(flowsheet).where(eq(flowsheet.show_id, show_id)),
  ]);

  return {
    ...metadata,
    entries,
  };
};

/**
 * Transform a V1 flowsheet entry to V2 discriminated union format.
 * Removes irrelevant fields based on entry_type for cleaner API responses.
 */
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
        on_streaming: entry.on_streaming ?? null,
        // BS#891. iOS branches on this to decide whether to render inline
        // metadata or fall back to the proxy-fetch path
        // (WXYC/wxyc-ios-64#270). Always present on track rows once the
        // column ships; `pending` is the default for newly-inserted rows.
        metadata_status: entry.metadata_status,
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
      };

    default: {
      // Fallback for unknown types - return all fields
      const { metadata, ...rest } = entry;
      return { ...rest, ...metadata };
    }
  }
};
