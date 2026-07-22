import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import * as Sentry from '@sentry/node';
import type { ReconciledIdentity, TrackMatchHint } from '@wxyc/shared/dtos';
import { RotationAddRequest } from '../controllers/library.controller.js';
import { db } from '@wxyc/database';
import {
  AlbumFormat,
  Artist,
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  RotationRelease,
  album_plays,
  artist_search_alias,
  artists,
  compilation_track_artist,
  genre_artist_crossreference,
  format,
  genres,
  library,
  library_identity,
  library_watermark,
  rotation,
  LibraryArtistViewEntry,
} from '@wxyc/database';
import {
  LibraryResult,
  EnrichedLibraryResult,
  enrichLibraryResult,
  ArtistMatchHint,
  ArtistSearchAliasSource,
} from './requestLine/types.js';
import {
  getRelease,
  lookupBySong,
  isLmlConfigured,
  envInt,
  LmlClientError,
  resolveIdentity,
  type LookupResponse,
  type DiscogsTrackItem,
  type DiscogsReleaseMetadata,
} from '@wxyc/lml-client';
import { lmlLookupCoordinator } from './lml/index.js';
import { filterSpacerGif } from './metadata/metadata.service.js';
import { checkLibraryArtistNameHealth } from './library-artist-name-assertion.service.js';
import { getConfig as getCatalogTrackSearchConfig } from '../config/catalogTrackSearch.js';
import { getConfig as getCatalogSearchAliasConfig } from '../config/catalogSearchAlias.js';
import { isCompilationArtist } from './requestLine/matching/index.js';
import { ilikeEscaped } from '../utils/sql-like.js';

/**
 * Catalog freshness watermark for the conditional-GET path (BS#1467 / Epic F
 * pattern). Returns `library_watermark.last_modified_at`, the single-row
 * sibling table advanced by the `touch_library_watermark` AFTER STATEMENT
 * trigger on `library` (migration 0104). The trigger fires on every
 * INSERT/UPDATE/DELETE — including the daily `jobs/library-etl/` write that
 * bypasses this service layer — so the watermark is correct even though most
 * catalog mutations never call into `library.service`.
 *
 * The conditional-GET middleware (`conditionalGet(getCatalogLastModifiedAt)`)
 * reads this on every poll; PK lookup is O(1). Returns the epoch
 * (`new Date(0)`) only as a defensive fallback — the migration seeds the
 * singleton row at apply time, so in production the SELECT always returns
 * exactly one row.
 *
 * Analogue of `flowsheet.service.getLastModifiedAt`.
 */
export const getCatalogLastModifiedAt = async (): Promise<Date> => {
  const result = await db.select({ at: library_watermark.last_modified_at }).from(library_watermark).limit(1);
  return result[0]?.at ?? new Date(0);
};

/**
 * Source columns on `artists` (and any joined / view-projected row) that
 * comprise a ReconciledIdentity. Kept in sync with the @wxyc/shared schema;
 * if a new external-ID field appears on the shared type, add it here too.
 */
const RECONCILED_IDENTITY_KEYS = [
  'discogs_artist_id',
  'musicbrainz_artist_id',
  'wikidata_qid',
  'spotify_artist_id',
  'apple_music_artist_id',
  'bandcamp_id',
] as const;

type ReconciledIdentityKey = (typeof RECONCILED_IDENTITY_KEYS)[number];

/**
 * A library_artist_view row that may carry an attached `matched_via` hint when
 * the cascade's CTA or LML `/lookup` fallback surfaced it (catalog-track-search
 * plan §5.1), or a `matched_via_alias` hint when the artist-search-alias
 * UNION ALL branch surfaced it (artist-search-alias plan §PR 5, post-#1318).
 * Wraps `LibraryArtistViewEntry` rather than replacing it so downstream
 * functions (enrichWithArtwork, serializeReconciledIdentity) accept tagged
 * rows without signature changes.
 */
export type TaggedLibraryViewEntry = LibraryArtistViewEntry & {
  matched_via?: TrackMatchHint[];
  matched_via_alias?: ArtistMatchHint[];
};

/**
 * Raw projection fields appended to the SELECT when the alias UNION ALL
 * branch is on (BS#1318). Returned as nullable columns so callers can detect
 * a no-hit row by `alias_max_sim === null` without forcing a separate query.
 */
type AliasHitFields = {
  alias_max_sim: number | null;
  alias_matched_variant: string | null;
  alias_matched_source: string | null;
};

/**
 * Attach `matched_via_alias` to a tagged row when the alias UNION ALL branch
 * surfaced a non-null hit. No-op when all three alias fields are null (the
 * row matched via the underlying trigram predicate, not via the alias cache).
 */
function attachAliasHint<R extends LibraryArtistViewEntry & AliasHitFields>(row: R): TaggedLibraryViewEntry {
  // Strip the alias-only fields off the wire-shape; matched_via_alias carries
  // the same information in the public sibling-type shape.
  const { alias_max_sim, alias_matched_variant, alias_matched_source, ...rest } = row;
  // Defensive: require non-nullish numeric and truthy variant + source. The
  // alias branch should never emit empty-string fields, but mirror the same
  // guard `toAlbumSearchResultRow` uses in library-search.service so the
  // catalog (/library/query) and request-line surfaces agree on what counts
  // as an alias hit.
  if (alias_max_sim === null || alias_max_sim === undefined || !alias_matched_variant || !alias_matched_source) {
    return rest as TaggedLibraryViewEntry;
  }
  return {
    ...(rest as TaggedLibraryViewEntry),
    matched_via_alias: [
      { matched_variant: alias_matched_variant, source: alias_matched_source as ArtistSearchAliasSource },
    ],
  };
}

/** A row that carries the six external-ID fields (artist row, view row, or any join projection). */
type ReconciledIdentitySource = {
  discogs_artist_id: number | null;
  musicbrainz_artist_id: string | null;
  wikidata_qid: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
};

/**
 * Build a shared `ReconciledIdentity` from any row carrying the six external-ID
 * fields, or null when all six are populated as null. Matching the semantic-index
 * pattern lets consumers distinguish "no IDs resolved yet" from "resolved with
 * some null IDs."
 */
export function toReconciledIdentity(row: ReconciledIdentitySource): ReconciledIdentity | null {
  const identity: ReconciledIdentity = {
    discogs_artist_id: row.discogs_artist_id,
    musicbrainz_artist_id: row.musicbrainz_artist_id,
    wikidata_qid: row.wikidata_qid,
    spotify_artist_id: row.spotify_artist_id,
    apple_music_artist_id: row.apple_music_artist_id,
    bandcamp_id: row.bandcamp_id,
  };
  if (RECONCILED_IDENTITY_KEYS.every((key) => identity[key] === null)) {
    return null;
  }
  return identity;
}

/**
 * Strip the six flat external-ID fields from a row and replace them with a
 * nested `reconciled_identity` object. Works for any shape that includes the
 * six fields (artist rows, view rows, ad-hoc join projections), so all four
 * library read endpoints can return the same wire shape.
 */
export function serializeReconciledIdentity<T extends ReconciledIdentitySource>(
  row: T
): Omit<T, ReconciledIdentityKey> & { reconciled_identity: ReconciledIdentity | null } {
  const {
    discogs_artist_id: _discogs,
    musicbrainz_artist_id: _mb,
    wikidata_qid: _qid,
    spotify_artist_id: _spotify,
    apple_music_artist_id: _apple,
    bandcamp_id: _bandcamp,
    ...rest
  } = row;
  return { ...rest, reconciled_identity: toReconciledIdentity(row) } as Omit<T, ReconciledIdentityKey> & {
    reconciled_identity: ReconciledIdentity | null;
  };
}

/**
 * Wire-format for an artist response. Replaces the six flat external-ID
 * columns with a nested `reconciled_identity` object that conforms to the
 * shared @wxyc/shared schema.
 */
export type ArtistResponse = Omit<Artist, ReconciledIdentityKey> & {
  reconciled_identity: ReconciledIdentity | null;
};

/**
 * Convert a Drizzle `artists` row to the public-facing artist response.
 * Strips the six flat external-ID columns and replaces them with a nested
 * `reconciled_identity` object.
 */
export function serializeArtist(artist: Artist): ArtistResponse {
  return serializeReconciledIdentity(artist);
}

export const getFormatsFromDB = async () => {
  const formats = await db
    .select()
    .from(format)
    .where(sql`true`);
  return formats;
};

export const insertFormat = async (new_format: NewAlbumFormat) => {
  const response = await db.insert(format).values(new_format).returning();
  return response[0];
};

/**
 * Look up a single format row by id. Used by PATCH /library/:id to validate an
 * incoming `format_id` against the `format` table so a stale/guessed id
 * surfaces as a 400 instead of tripping the NOT NULL FK (PG 23503) → 500
 * (BS#1550), mirroring `labelsService.getLabelById`.
 */
export const getFormatById = async (id: number): Promise<AlbumFormat | undefined> => {
  const result = await db.select().from(format).where(eq(format.id, id)).limit(1);
  return result[0];
};

export interface Rotation {
  id: number | null;
  code_letters: string | null;
  code_artist_number: number | null;
  code_number: number | null;
  artist_name: string | null;
  alphabetical_name: string | null;
  album_title: string | null;
  record_label: string | null;
  label_id: number | null;
  genre_name: string | null;
  format_name: string | null;
  rotation_id: number;
  add_date: Date | null;
  rotation_add_date: string;
  rotation_bin: 'S' | 'L' | 'M' | 'H' | 'N';
  rotation_kill_date: string | null;
  plays: number | null;
  reconciled_identity: ReconciledIdentity | null;
}

/**
 * Raw row shape returned by the rotation query before reconciled-identity
 * serialization. Mirrors the SELECT list in `getRotationFromDB`. Carries
 * the six external-ID columns flat; `serializeReconciledIdentity` strips
 * them and replaces them with a nested `reconciled_identity` object.
 *
 * Most fields are nullable because the LEFT JOINs (#689) intentionally
 * surface rotation rows whose `album_id` doesn't resolve to a `library`
 * row; those rows fall back to rotation's denormalized
 * artist/album/label snapshot fields and have NULL ancillary metadata
 * (`code_letters`, `genre_name`, `format_name`, identity ids).
 */
type RotationRow = Omit<Rotation, 'reconciled_identity'> & ReconciledIdentitySource;

/**
 * Read-side query for `GET /library/rotation`.
 *
 * **Shape rules** (see #689 / #694, BS CLAUDE.md `SOURCE: tubafrenzy`
 * annotation on the rotation table). Tubafrenzy is the upstream writer
 * and BS is downstream; we cannot constrain what tubafrenzy writes, so
 * the read collapses the full upstream shape on the way out.
 *
 * - **LEFT JOIN to library, artists, format, genres,
 *   genre_artist_crossreference.** Tubafrenzy permits rotation rows
 *   with NULL `album_id` (rotation entries that pre-date or didn't
 *   link to a library row); ~147 such rows are currently active in
 *   prod and were dropped by the previous INNER JOIN. We instead
 *   surface them and `COALESCE` artist_name/album_title/record_label
 *   from rotation's denormalized snapshot columns when the library
 *   join is NULL.
 *
 * - **DISTINCT ON `(coalesce(album_id::bigint, -(abs(hashtext(lower(artist)||'|'||lower(album))::bigint) + 1)), rotation_bin)`
 *   ORDER BY same key, then `add_date DESC, id ASC`.**
 *   Tubafrenzy permits multiple active rows per
 *   `(album_id, rotation_bin)` over an album's lifecycle (re-bins,
 *   re-adds, label-driven re-promotes); we collapse those duplicates
 *   to one row per group on the way out, picking the most-recently
 *   added (tie-broken by lowest rotation id for deterministic output).
 *   When `album_id IS NULL` (151/310 active rows in the 2026-05-14
 *   prod snapshot — tubafrenzy entries that never resolved to a
 *   library row), we partition on a hash of the denormalized
 *   `(artist_name, album_title)` snapshot columns instead. This both
 *   keeps NULL-album rows in their own groups (Postgres DISTINCT ON
 *   would otherwise treat NULLs as equal and collapse all 151 to one)
 *   AND collapses unlinked dupes that share the same release — fixing
 *   #862, where the dropdown surfaced the same release ×3 because the
 *   prior `-id` trick was unique-per-row and never collapsed.
 *   `hashtext` is deterministic and cheap; collisions at this row
 *   count are negligible (birthday-bound ~32k for a 32-bit space and
 *   we're at ~151). `abs(hashtext::bigint) + 1` is always >= 1 (no
 *   int4 overflow on `abs(INT_MIN)` because it widens to bigint
 *   cleanly); negating gives a strictly negative key so it can never
 *   collide with a positive `album_id`.
 *
 * - **`kill_date IS NULL OR kill_date > CURRENT_DATE`.** Active rows
 *   only; the planner-stable predicate also excludes future-dated
 *   kills correctly.
 */
export const getRotationFromDB = async (): Promise<Rotation[]> => {
  // Stable partition key for the DISTINCT ON / ORDER BY: real album_id when
  // present, else a hash of the (artist_name, album_title) snapshot so
  // unlinked duplicates collapse together (#862). The expression is computed
  // entirely in bigint to defuse two latent failures:
  //   1. `hashtext` returns int4; negating `INT_MIN` raises `integer out of
  //      range` on Postgres rather than wrapping.
  //   2. Naïvely negating a negative `hashtext` produces a positive value
  //      that could collide with a real positive `album_id` in the COALESCE
  //      and silently drop a real-album row from the output.
  // `abs(hashtext::bigint) + 1` is always >= 1 (no overflow because
  // `abs(INT_MIN)` widens to bigint cleanly); negating gives <= -1 — strictly
  // negative, so it can never collide with a positive `album_id`.
  const partitionKey = sql`COALESCE(
    ${rotation.album_id}::bigint,
    -(abs(hashtext(lower(coalesce(${rotation.artist_name}, '')) || '|' || lower(coalesce(${rotation.album_title}, '')))::bigint) + 1)
  )`;
  const query = sql`
    SELECT DISTINCT ON (${partitionKey}, ${rotation.rotation_bin})
      ${library.id} AS id,
      ${artists.code_letters} AS code_letters,
      ${genre_artist_crossreference.artist_genre_code} AS code_artist_number,
      ${library.code_number} AS code_number,
      COALESCE(${artists.artist_name}, ${rotation.artist_name}) AS artist_name,
      COALESCE(${artists.alphabetical_name}, ${rotation.artist_name}) AS alphabetical_name,
      COALESCE(${library.album_title}, ${rotation.album_title}) AS album_title,
      COALESCE(${library.label}, ${rotation.record_label}) AS record_label,
      ${library.label_id} AS label_id,
      ${genres.genre_name} AS genre_name,
      ${format.format_name} AS format_name,
      ${rotation.id} AS rotation_id,
      ${library.add_date} AS add_date,
      ${rotation.add_date} AS rotation_add_date,
      ${rotation.rotation_bin} AS rotation_bin,
      ${rotation.kill_date} AS rotation_kill_date,
      ${library.plays} AS plays,
      ${artists.discogs_artist_id} AS discogs_artist_id,
      ${artists.musicbrainz_artist_id} AS musicbrainz_artist_id,
      ${artists.wikidata_qid} AS wikidata_qid,
      ${artists.spotify_artist_id} AS spotify_artist_id,
      ${artists.apple_music_artist_id} AS apple_music_artist_id,
      ${artists.bandcamp_id} AS bandcamp_id
    FROM ${rotation}
    LEFT JOIN ${library} ON ${library.id} = ${rotation.album_id}
    LEFT JOIN ${artists} ON ${artists.id} = ${library.artist_id}
    LEFT JOIN ${format} ON ${library.format_id} = ${format.id}
    LEFT JOIN ${genres} ON ${library.genre_id} = ${genres.id}
    LEFT JOIN ${genre_artist_crossreference}
      ON ${genre_artist_crossreference.artist_id} = ${library.artist_id}
      AND ${genre_artist_crossreference.genre_id} = ${library.genre_id}
    WHERE ${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL
    ORDER BY ${partitionKey},
             ${rotation.rotation_bin},
             ${rotation.add_date} DESC,
             ${rotation.id} ASC
  `;

  const response = await db.execute(query);
  const rows = response as unknown as RotationRow[];

  return rows.map((row) => serializeReconciledIdentity(row));
};

/**
 * BS#1380: Sentry counter `lml.resolve.fallback_to_null` reason buckets.
 * Each value signals a different operational response:
 *   - `timeout`: LML latency/capacity (look at LML p95)
 *   - `5xx`:     LML deploy regression (look at LML release notes)
 *   - `4xx`:     BS-side caller bug (the library_identity row pointed at
 *                a sentinel ID LML rejects, etc.)
 *   - `network`: infra noise (transient TCP/DNS failures)
 *   - `other`:   uncategorised — investigate per-event
 *
 * Surfaced separately so a per-bucket regression doesn't get masked by the
 * rollup. Revisit (split the knob or tune the value) if Sentry shows p95
 * user-facing add-to-rotation > 2.5 s OR fallback rate > 5% in any bucket.
 */
export type LmlResolveFallbackReason = 'timeout' | '5xx' | '4xx' | 'network' | 'other';

/**
 * Classify the error caught from `resolveIdentity(...)` into one of the
 * five operational buckets above. Pulled out so the unit test can
 * exhaustively exercise every branch without spinning up an LML server.
 *
 * `LmlClientError` is the wrapper `lmlFetch` throws; its `statusCode` was
 * already translated upstream (5xx → 502, AbortError → 504). The catch
 * here untranslates so the Sentry attribute reads as the original
 * operational signal.
 */
export function classifyLmlResolveError(err: unknown): LmlResolveFallbackReason {
  if (!err || typeof err !== 'object') return 'other';
  const e = err as { name?: string; code?: string; statusCode?: number; message?: string };
  if (e.name === 'AbortError') return 'timeout';
  if (err instanceof LmlClientError) {
    // `lmlFetch` translates `AbortError` → 504 and upstream 5xx → 502; restore
    // the operational bucket from those translations + the raw status range.
    if (e.statusCode === 504) return 'timeout';
    if (e.statusCode === 502) {
      // 502 is overloaded: it's the wrapper for both upstream 5xx and a raw
      // fetch failure (the catch-all in `lmlFetch`). Disambiguate from the
      // message — "LML request failed" is the fetch-threw path.
      return typeof e.message === 'string' && e.message.startsWith('LML request failed') ? 'network' : '5xx';
    }
    if (typeof e.statusCode === 'number') {
      if (e.statusCode >= 500) return '5xx';
      if (e.statusCode >= 400) return '4xx';
    }
    return 'other';
  }
  if (e.code === 'ECONNRESET' || e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
    return 'network';
  }
  return 'other';
}

/**
 * Add an album to rotation (dj-site path, `POST /library/rotation`).
 *
 * Synchronously triple-writes `(discogs_release_id, discogs_release_id_source =
 * 'library_identity', lml_identity_id)` when the album's `library_identity`
 * row supplies a non-NULL `discogs_release_id` (BS#1380):
 *
 *   1. Read `library_identity.discogs_release_id` for the requested
 *      `album_id`. `library_identity.library_id` is the PRIMARY KEY
 *      (see schema.ts:1391-1393); `LIMIT 1` is defensive.
 *   2. If non-NULL, `await resolveIdentity({kind:'release',
 *      source:'discogs_release', external_id})` to mint a stable
 *      `lml_identity_id`. The hop runs inside this handler — the response
 *      row carries the populated columns without needing a follow-up
 *      patch.
 *   3. INSERT all three columns. On resolve failure (timeout / 5xx /
 *      network), `lml_identity_id` falls back to NULL but
 *      `discogs_release_id` + `discogs_release_id_source = 'library_identity'`
 *      still land — the *source of the Discogs id* is library_identity
 *      regardless of whether the mint succeeded. The daily backfill cron
 *      catches up within ~24h.
 *
 * Rationale for synchronous-before-INSERT: dj-site's optimistic UI
 * (WXYC/dj-site#648) covers the latency tail at the client side — the row
 * appears in-rotation immediately on click. Blocking the music director on
 * an LML outage is worse than a temporarily-incomplete row, so the catch
 * arm proceeds rather than rethrowing.
 */
export const addToRotation = async (newRotation: RotationAddRequest) => {
  const values: RotationAddRequest = { ...newRotation };

  // Allowlist guard already runs at the controller layer, but the server-
  // derived fields below must always come from this function, not the
  // request — defense in depth.
  if (values.album_id != null) {
    const [identityRow] = await db
      .select({ discogs_release_id: library_identity.discogs_release_id })
      .from(library_identity)
      .where(eq(library_identity.library_id, values.album_id))
      .limit(1);
    const discogsReleaseId = identityRow?.discogs_release_id ?? null;

    // BS#1429: rotation.discogs_release_id rejects `0` and negative ids via
    // CHECK constraint. library_identity.discogs_release_id has no such
    // fence today, so a poisoned upstream value would 23514 this INSERT and
    // surface as a 5xx to the music director. Treat any non-positive value
    // as "no Discogs handle" — same graceful-degradation path the LML
    // resolve-failure catch arm already takes.
    if (discogsReleaseId != null && discogsReleaseId > 0) {
      // The source-of-the-Discogs-id is library_identity, regardless of
      // whether the LML mint that follows succeeds.
      values.discogs_release_id = discogsReleaseId;
      values.discogs_release_id_source = 'library_identity';

      let lmlIdentityId: number | null = null;
      try {
        const resolved = await resolveIdentity({
          kind: 'release',
          source: 'discogs_release',
          external_id: String(discogsReleaseId),
        });
        lmlIdentityId = resolved.identity_id;
      } catch (err) {
        const reason = classifyLmlResolveError(err);
        // BS#1380: classify once at fallback time so each reason bucket
        // signals a different operational response (timeout → LML
        // latency, 5xx → LML deploy regression, 4xx → BS-side caller bug,
        // network → infra noise). v10 SDK shape — `Sentry.metrics.count(
        // name, value, {attributes})`. Pre-v8
        // `Sentry.metrics.increment(..., {tags})` was removed.
        try {
          Sentry.metrics.count('lml.resolve.fallback_to_null', 1, {
            attributes: { caller: 'add_to_rotation', reason },
          });
        } catch {
          // Observability must never break the request path; swallow.
        }
        // lml_identity_id stays NULL; INSERT proceeds.
      }
      values.lml_identity_id = lmlIdentityId;
    }
  }

  const insertedRotation: RotationRelease[] = await db.insert(rotation).values(values).returning();
  return insertedRotation[0];
};

export const killRotationInDB = async (rotationId: number, updatedKillDate?: string) => {
  const updatedRotation = await db
    .update(rotation)
    .set({ kill_date: updatedKillDate || sql`CURRENT_DATE` })
    .where(eq(rotation.id, rotationId))
    .returning();
  return updatedRotation[0];
};

export const insertAlbum = async (newAlbum: NewAlbum) => {
  const response = await db.insert(library).values(newAlbum).returning();
  return response[0];
};

/**
 * Look up the resolved Discogs release id for a library row by its
 * legacy id — the id the dj-site flowsheet picker carries (LML
 * `library.db.id` = BS `library.legacy_release_id`). JOINs `library`
 * to `library_identity` via that bridge in a single query.
 *
 * Returns null when any of these holds (the picker degrades to free-text):
 *   - legacy id doesn't map to a BS library row,
 *   - the row has no `library_identity` entry (not yet backfilled by BS#802), or
 *   - the identity row has no resolved `discogs_release_id`.
 *
 * Used by `/proxy/library/{id}/tracks` (E6-5 / BS#836) to compose against
 * LML's `/api/v1/discogs/release/{id}` for the tracklist.
 */
export async function getDiscogsReleaseIdByLegacyId(legacyId: number): Promise<number | null> {
  const rows = await db
    .select({ discogs_release_id: library_identity.discogs_release_id })
    .from(library)
    .innerJoin(library_identity, eq(library_identity.library_id, library.id))
    .where(eq(library.legacy_release_id, legacyId))
    .limit(1);
  return rows[0]?.discogs_release_id ?? null;
}

/**
 * Per-rotation_id LRU for the LML `POST /api/v1/lookup` fallback in
 * `resolveRotationPickerSource`. The dj-site picker is opened many times
 * per session against a handful of rotation rows; caching avoids restarting
 * the LML query for each open. Mirrors tubafrenzy's `RotationTracklistCache`
 * concept (process-local map keyed by rotation id), minus the warm-on-startup
 * pass.
 *
 * Two caches — positive (resolved release id) and negative (LML returned
 * nothing). lru-cache v11 constrains value types to non-nullable, so the
 * negative cache stores `true` and uses key presence as the signal. Both
 * TTLs are 24 h: Discogs release tracklists and the negative classification
 * ("no Discogs release for this artist+album") are both stable conditions
 * that don't flip within a day; deploys re-warm both caches via the
 * `rotation-tracks-cache-warm` walker (BS#1231); 24 h is a soft ceiling
 * against drift, not a refresh interval.
 *
 * (Distinct from `proxy.controller.ts`'s artwork/negativeCache pair, which
 * uses a 1 h positive TTL because artwork images can be re-uploaded but the
 * Discogs release ID for a given (artist, album) is effectively immutable.)
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROTATION_LML_LOOKUP_CACHE_MAX = 500;
const ROTATION_LML_LOOKUP_TTL_POSITIVE_MS = MS_PER_DAY;
const ROTATION_LML_LOOKUP_TTL_NEGATIVE_MS = MS_PER_DAY;
/**
 * How long a persisted `rotation.tracklist_lookup_attempted_at` stamp
 * suppresses re-asking LML. Negative outcomes here are "this artist+album
 * combo isn't resolvable to a Discogs release" — a stable condition that
 * rarely flips. 7 days lets a music-director typo correction self-heal
 * within a week without being so aggressive that we re-pay the 22 s cascade
 * cost on every deploy.
 */
const ROTATION_TRACKLIST_LOOKUP_NEGATIVE_WINDOW_MS = 7 * MS_PER_DAY;
/**
 * Per-call LML timeout for the picker's tier-3 lookup. 10 s matches
 * tubafrenzy's `RELEASE_LOOKUP_TIMEOUT` (`LibrarySearchClient.java:64`),
 * which is the parity bar we measure picker coverage against. Shorter
 * timeouts cut off LML's cascade before the later strategies that find
 * obscure college-rotation releases get to run — the source of the
 * coverage regression that motivated dropping the BS#1186 budget.
 *
 * Intentionally no `budgetMs` companion: BS#1186 added a 4 s
 * `X-Caller-Budget-Ms` header to short-circuit LML's empty-results
 * cascade. That cap was justified by malformed-query examples
 * (track-titles-as-album-names) and applied uniformly across callers,
 * including this one. For the picker — which always passes real
 * `(artist_name, album_title)` pairs from rotation rows — the cascade's
 * later strategies are exactly where matches come from, so capping at
 * 4 s collapsed picker coverage to ~23 %. The iOS proxy/artwork hot-path
 * callers keep their budgets; only this call site opts out.
 */
const ROTATION_LML_LOOKUP_TIMEOUT_MS = 10000;

/**
 * Budget for `enrichWithArtwork` and `searchLibraryByTrack` — both user-visible
 * read paths that would rather degrade than hold the response on an obscure-
 * artist cascade. See `LookupOptions.budgetMs` for mechanics.
 */
const LIBRARY_INTERACTIVE_LML_BUDGET_MS = envInt('LIBRARY_INTERACTIVE_LML_BUDGET_MS', 5000);

/**
 * Wire shape returned by `GET /library/rotation/:rotation_id/tracks`. The
 * dj-site rotation entry picker (`useGetRotationTracksQuery`) consumes this
 * directly — keep field names + types in lockstep with the dj-site
 * `RotationTrack` type in `lib/features/rotation/api.ts`. Re-exported from
 * `apps/backend/controllers/library.controller.ts` for the surface that
 * consumers reference today.
 */
export interface RotationTrack {
  position: string;
  title: string;
  duration: string | null;
  artists: string[];
}

/**
 * What `resolveRotationPickerSource` hands back to the picker controller.
 *
 * The controller short-circuits whenever `inlineTracklist !== null` and
 * returns it as the response. That covers both:
 *   - tier 3 Discogs hit with `extended=true` (LML returned the tracklist
 *     in the same response we asked for the release id), and
 *   - tier 3 MusicBrainz rescue (LML synthesized the result; `releaseId`
 *     is `null` because there's no Discogs release behind it — BS#1185).
 *
 * When `inlineTracklist === null` the controller calls `getRelease(releaseId)`
 * and projects its tracklist. That path is taken for tiers 1 and 2 (stored
 * id, no LML round-trip) and for tier-3 responses that LML couldn't extend
 * with a tracklist (e.g. extended-mode payload was suppressed upstream).
 */
export interface RotationPickerSource {
  releaseId: number | null;
  inlineTracklist: RotationTrack[] | null;
}

const rotationLmlPositiveCache = new LRUCache<number, RotationPickerSource>({
  max: ROTATION_LML_LOOKUP_CACHE_MAX,
  ttl: ROTATION_LML_LOOKUP_TTL_POSITIVE_MS,
  ttlAutopurge: true,
});

const rotationLmlNegativeCache = new LRUCache<number, true>({
  max: ROTATION_LML_LOOKUP_CACHE_MAX,
  ttl: ROTATION_LML_LOOKUP_TTL_NEGATIVE_MS,
  ttlAutopurge: true,
});

export function __resetRotationLmlLookupCacheForTests(): void {
  rotationLmlPositiveCache.clear();
  rotationLmlNegativeCache.clear();
}

/**
 * Current sizes of the rotation LML LRUs. Used by the rotation-tracks
 * cache-warm service (BS#998) to classify warm-pass outcomes per row
 * (positive-cache-hit vs negative-cache-hit) without coupling to LRU
 * internals. Underscored so it stays out of the public service surface —
 * production callers should not depend on cache shape.
 */
export function __rotationLmlCacheSizesForWarm(): { positive: number; negative: number } {
  return {
    positive: rotationLmlPositiveCache.size,
    negative: rotationLmlNegativeCache.size,
  };
}

/**
 * Resolve the source the rotation-tracks picker should render against, by
 * `rotation_id`. Returns either a `releaseId` the controller can hand to
 * `getRelease(id)`, an inline tracklist the controller can return as-is, or
 * `null` if every tier missed and the picker should degrade to free-text.
 *
 * Three-tier resolution to match tubafrenzy's `RotationTracklistCache` parity
 * (see BS#986):
 *
 *   1. `rotation.discogs_release_id` (direct) — mirrored from tubafrenzy
 *      `ROTATION_RELEASE.DISCOGS_RELEASE_ID` by `jobs/rotation-etl`. Populated
 *      via the rotation-add form's paste-URL prefill flow.
 *      → `{ releaseId, inlineTracklist: null }`
 *   2. `library_identity.discogs_release_id` via the `album_id` bridge
 *      (fallback) — written by `jobs/library-identity-consumer` (BS#802).
 *      → `{ releaseId, inlineTracklist: null }`
 *   3. LML `POST /api/v1/lookup` on `(rotation.artist_name, rotation.album_title)`
 *      with `extended=true` — the same `(artist, title)` lookup tubafrenzy's
 *      `RotationTracklistCache.fetchAndCache` uses, but extended to carry the
 *      tracklist inline. When LML returns a tracklist (Discogs hit OR
 *      MusicBrainz-rescued synth path on the BS#1185 sentinel + LML#427),
 *      the controller returns it directly; no follow-up `getRelease(id)`
 *      round-trip needed. Per-`rotation_id` LRU caches positive and negative
 *      outcomes.
 *      → `{ releaseId, inlineTracklist }`
 *
 * Returns null when all three tiers miss: rotation row doesn't exist; the
 * row has no `artist_name` or `album_title`; LML returns no results,
 * isn't configured, or fails. The picker degrades to free-text.
 *
 * Used by `/library/rotation/:rotation_id/tracks` (BS#940). Parallel to
 * `getDiscogsReleaseIdByLegacyId` (BS#836) which the catalog-search picker
 * uses via `legacy_release_id`.
 */
export async function resolveRotationPickerSource(rotationId: number): Promise<RotationPickerSource | null> {
  const rows = await db
    .select({
      direct: rotation.discogs_release_id,
      fallback: library_identity.discogs_release_id,
      artist_name: rotation.artist_name,
      album_title: rotation.album_title,
      tracklist_lookup_attempted_at: rotation.tracklist_lookup_attempted_at,
    })
    .from(rotation)
    .leftJoin(library_identity, eq(library_identity.library_id, rotation.album_id))
    .where(eq(rotation.id, rotationId))
    .limit(1);
  if (!rows[0]) return null;

  const stored = rows[0].direct ?? rows[0].fallback ?? null;
  if (stored !== null) return { releaseId: stored, inlineTracklist: null };

  // Persistent negative marker. The in-memory rotationLmlNegativeCache covers
  // within-process repeats; this column covers across-restart so the 28-row
  // "negative" set doesn't re-pay 22 s cascade exhaustion on every deploy.
  const attemptedAt = rows[0].tracklist_lookup_attempted_at;
  if (attemptedAt && Date.now() - attemptedAt.getTime() < ROTATION_TRACKLIST_LOOKUP_NEGATIVE_WINDOW_MS) {
    return null;
  }

  return resolveRotationDiscogsReleaseViaLml(rotationId, rows[0].artist_name, rows[0].album_title);
}

/**
 * Tier-3 of `resolveRotationPickerSource`. Asks LML to identify the
 * Discogs release for a rotation row's `(artist_name, album_title)` when
 * the direct column and `library_identity` fallback both miss. Mirrors
 * tubafrenzy's `RotationTracklistCache.fetchAndCache`, which calls
 * `LibrarySearchClient.searchDiscogsRelease` → `POST /api/v1/lookup`.
 *
 * Caches positive and negative results per `rotation_id`. The negative
 * TTL is shorter so rows that become resolvable (LML catalog improvements,
 * Discogs additions) recover within minutes rather than waiting for a
 * process restart. No DB cache-through here — tubafrenzy's MySQL column
 * isn't a write target on this path either, and a column-mix between
 * paste-URL-prefilled and LML-resolved values would muddy provenance.
 *
 * Bounded at `ROTATION_LML_LOOKUP_TIMEOUT_MS` (10 s) per call — fast-fail
 * for the user-visible picker (BS#992). Caller errors are swallowed so
 * the picker degrades to free-text rather than 500ing; the LML client
 * already wraps the call in a Sentry span carrying `lml.cache.*` and
 * `lml.queue_depth` attributes for trace-explorer drill-down.
 */
/**
 * Detect Various-Artists artist-name variants the picker should omit from
 * the LML lookup. Mirrors tubafrenzy's `LibrarySearchClient.isVariousArtistsName`
 * (`LibrarySearchClient.java:429`): passing "Various Artists" pollutes
 * LML's fuzzy matching and surfaces unrelated compilations instead of the
 * actual release. LML's /lookup orchestrator supports the album-only path.
 *
 * Exported for the unit-test parity matrix; not part of the public service
 * surface.
 */
export function isVariousArtistsName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  if (/^v[\s./]*a\.?$/.test(trimmed)) return true;
  if (trimmed === 'various') return true;
  if (/^various\s+art/.test(trimmed)) return true;
  if (/^var\.?\s+art/.test(trimmed)) return true;
  return false;
}

async function resolveRotationDiscogsReleaseViaLml(
  rotationId: number,
  artistName: string | null,
  albumTitle: string | null
): Promise<RotationPickerSource | null> {
  if (!artistName || !albumTitle) return null;
  if (!isLmlConfigured()) return null;

  const cachedPositive = rotationLmlPositiveCache.get(rotationId);
  if (cachedPositive !== undefined) return cachedPositive;
  if (rotationLmlNegativeCache.has(rotationId)) return null;

  const lookupArtist = isVariousArtistsName(artistName) ? undefined : artistName;

  let source: RotationPickerSource | null;
  try {
    // BS#1351: non-direct `search_type` values surface candidates for the wrong
    // album (Yenbett → Tzenni). The coordinator enforces the gate via
    // `requireSearchType: 'direct'` and projects `lml.coordinator.trust_reject_reason`
    // on the per-lookup span. LML's `fetch_one` enforces the 80/80 album-title
    // floor for `direct` matches, so this is sufficient — the picker falls
    // through to free-text on rejection.
    const response = await lmlLookupCoordinator.lookup(lookupArtist, albumTitle, undefined, {
      timeoutMs: ROTATION_LML_LOOKUP_TIMEOUT_MS,
      caller: 'library-rotation-picker',
      requireSearchType: 'direct',
    });
    if (response === null) {
      source = null;
    } else {
      const artwork = response.results?.[0]?.artwork ?? null;
      // `release_id: 0` is LML's MusicBrainz-rescued synth sentinel
      // (orchestrator.py emits it when ARTIST_PLUS_ALBUM hits but Discogs
      // carries no artwork). Treat as "no Discogs id" so the controller
      // doesn't follow up with `/discogs/release/0`. The tracklist on the
      // synth result is still valid and is what the picker hands to the DJ.
      const rawReleaseId = artwork?.release_id ?? null;
      const releaseId = rawReleaseId !== null && rawReleaseId > 0 ? rawReleaseId : null;
      const inlineTracklist = projectInlineTracklist(artwork?.tracklist, artistName);
      source = releaseId !== null || inlineTracklist !== null ? { releaseId, inlineTracklist } : null;
    }
  } catch (err) {
    console.warn(
      '[library.service] LML /lookup for rotation_id=%d failed; degrading picker to free-text: %s',
      rotationId,
      (err as Error).message
    );
    return null;
  }

  if (source !== null) {
    rotationLmlPositiveCache.set(rotationId, source);
  } else {
    rotationLmlNegativeCache.set(rotationId, true);
    // Best-effort persistent stamp — the in-memory LRU is enough for the
    // current request; the column survives restarts. Failure logs and is
    // swallowed so the picker response isn't blocked on the write.
    void (async () => {
      try {
        await db
          .update(rotation)
          .set({ tracklist_lookup_attempted_at: sql`NOW()` })
          .where(eq(rotation.id, rotationId));
      } catch (err) {
        console.warn(
          '[library.service] failed to stamp rotation.tracklist_lookup_attempted_at for rotation_id=%d: %s',
          rotationId,
          (err as Error).message
        );
      }
    })();
  }

  return source;
}

/**
 * Project the LML tracklist shape onto the picker's wire shape. Shared
 * between the service's `extended=true` inline path (BS#1185 + LML#427)
 * and the controller's follow-up `getRelease(id)` path so the two surfaces
 * can't drift. Returns `null` (not `[]`) when the tracklist is absent so
 * the caller can distinguish "LML carried tracks" from "fall through to
 * the release fetch". `artistFallback` is rendered against any track whose
 * per-track `artists[]` is empty.
 */
export function projectInlineTracklist(
  tracklist: ReadonlyArray<DiscogsTrackItem> | null | undefined,
  artistFallback: string
): RotationTrack[] | null {
  if (!tracklist || tracklist.length === 0) return null;
  return tracklist.map((t) => ({
    position: t.position,
    title: t.title,
    duration: t.duration ?? null,
    artists: t.artists && t.artists.length > 0 ? Array.from(t.artists) : [artistFallback],
  }));
}

/**
 * Per-`release_id` LRU on the projected `RotationTrack[]` from LML's
 * `GET /api/v1/discogs/release/{id}`. Absorbs the dominant cost on the
 * rotation-tracks picker — the LML release-fetch endpoint takes 2-9 s on
 * Discogs cache miss vs. 78 ms warm.
 *
 * Positive TTL is long (24 h) because Discogs release tracklists are
 * effectively immutable. Negative TTL is short so a release that becomes
 * known to Discogs recovers quickly. In-flight map coalesces concurrent
 * dropdown opens on the same release so a cold-deploy burst pays the
 * cold-path once across DJs, not once per DJ.
 */
const RELEASE_TRACKLIST_CACHE_MAX = 500;
const RELEASE_TRACKLIST_TTL_POSITIVE_MS = MS_PER_DAY;
const RELEASE_TRACKLIST_TTL_NEGATIVE_MS = 10 * 60 * 1000;

const releaseTracklistPositiveCache = new LRUCache<number, RotationTrack[]>({
  max: RELEASE_TRACKLIST_CACHE_MAX,
  ttl: RELEASE_TRACKLIST_TTL_POSITIVE_MS,
  ttlAutopurge: true,
});

const releaseTracklistNegativeCache = new LRUCache<number, true>({
  max: RELEASE_TRACKLIST_CACHE_MAX,
  ttl: RELEASE_TRACKLIST_TTL_NEGATIVE_MS,
  ttlAutopurge: true,
});

const releaseTracklistInflight = new Map<number, Promise<RotationTrack[] | null>>();

export function __resetReleaseTracklistCacheForTests(): void {
  releaseTracklistPositiveCache.clear();
  releaseTracklistNegativeCache.clear();
  releaseTracklistInflight.clear();
}

/**
 * Sizes of the per-release-id tracklist LRUs. Used by the rotation-tracks
 * cache-warm service to classify post-`getRotationTracksFromRelease`
 * outcomes (positive vs negative) without coupling to LRU internals.
 * Parallel to `__rotationLmlCacheSizesForWarm`.
 */
export function __releaseTracklistCacheSizesForWarm(): { positive: number; negative: number } {
  return {
    positive: releaseTracklistPositiveCache.size,
    negative: releaseTracklistNegativeCache.size,
  };
}

/**
 * Fetch a Discogs release tracklist via LML and project it onto the
 * picker's `RotationTrack` wire shape. Cached per `release_id`.
 *
 * Returns:
 *   - `RotationTrack[]` — positive-cached projection.
 *   - `null` — LML returned 404; negative-cached. Controller maps to 200 + `[]`.
 *
 * Other LML errors (5xx, network, parse) bubble so transient upstream
 * failures surface rather than silently degrading the picker.
 */
export async function getRotationTracksFromRelease(releaseId: number): Promise<RotationTrack[] | null> {
  const cachedPositive = releaseTracklistPositiveCache.get(releaseId);
  if (cachedPositive !== undefined) return cachedPositive;
  if (releaseTracklistNegativeCache.has(releaseId)) return null;

  const inflight = releaseTracklistInflight.get(releaseId);
  if (inflight) return inflight;

  const pending = (async () => {
    let release: DiscogsReleaseMetadata;
    try {
      release = await getRelease(releaseId);
    } catch (err) {
      if (err instanceof LmlClientError && err.statusCode === 404) {
        releaseTracklistNegativeCache.set(releaseId, true);
        return null;
      }
      throw err;
    }
    const tracks = projectInlineTracklist(release.tracklist, release.artist) ?? [];
    releaseTracklistPositiveCache.set(releaseId, tracks);
    return tracks;
  })().finally(() => {
    releaseTracklistInflight.delete(releaseId);
  });
  releaseTracklistInflight.set(releaseId, pending);
  return pending;
}

export const updateOnStreaming = async (id: number, on_streaming: boolean | null) => {
  const response = await db.update(library).set({ on_streaming }).where(eq(library.id, id)).returning();
  return response[0];
};

/**
 * Cache the artwork URL for a library entry, but only when the row's current
 * `artwork_url` is NULL. The narrowing predicate makes this safe to call
 * concurrently with `jobs/library-artwork-url-backfill` (#637) and forecloses
 * a class of last-write-wins inconsistencies if a future LML response shape
 * ever diverges between the runtime and backfill code paths. Today both
 * writers source from the same `discogs-cache.release.artwork_url`, so the
 * clobber was benign — but the symmetry with the backfill's WHERE makes the
 * race contract honest. Returns the updated row when a write happened, or
 * `undefined` when the row was already populated; both callers (search-path
 * `enrichWithArtwork` and post-create cache-through in
 * `library.controller.ts`) ignore the return.
 */
export const updateArtworkUrl = async (id: number, artwork_url: string | null) => {
  const response = await db
    .update(library)
    .set({ artwork_url })
    .where(and(eq(library.id, id), isNull(library.artwork_url)))
    .returning();
  return response[0];
};

/**
 * Confidence heuristics derived from LML's `search_type` per the B-0
 * calibration (see issue #492). LML does not return per-result confidence,
 * so the link-time value stored on `library.canonical_entity_confidence` is
 * a coarse band kept around so future analyses can re-judge weak matches
 * once LML exposes a real signal.
 *
 * The non-direct rows are load-bearing for `flowsheet-linkage.service.ts`,
 * which calls `mapLookupToCanonicalEntity` on the raw (non-gated) lookup
 * response and uses the band to gate auto-link vs. gray-zone-review.
 * `library.controller.fireAndForgetCanonicalEntity` instead gates with
 * `requireSearchType: 'direct'` at the coordinator (BS#1355) — a deliberate
 * tightening, not a refactor: the old caller path persisted canonical
 * entities for non-direct matches (fallback / alternative / compilation /
 * song_as_artist) with their banded confidence; the gated path persists
 * only `search_type === 'direct'` (band 0.9). The non-direct bands stay
 * here for flowsheet-linkage; do not reuse them on the librarian-write
 * path without re-opening the BS#1355 decision.
 */
const SEARCH_TYPE_CONFIDENCE: Record<LookupResponse['search_type'], number | null> = {
  direct: 0.9,
  fallback: 0.5,
  alternative: 0.3,
  compilation: 0.3,
  song_as_artist: 0.3,
  none: null,
};

/**
 * Map an LML lookup response to a (canonical_entity_id, confidence) pair, or
 * null if the response carries nothing linkable. The id is namespaced by
 * source (`discogs:release:<id>`) — the column's contract is opaque text, but
 * a namespace keeps the door open for MusicBrainz / other resolvers later.
 */
export const mapLookupToCanonicalEntity = (response: LookupResponse): { id: string; confidence: number } | null => {
  const top = response.results?.[0];
  const releaseId = top?.artwork?.release_id;
  if (!releaseId) return null;
  const confidence = SEARCH_TYPE_CONFIDENCE[response.search_type];
  if (confidence === null || confidence === undefined) return null;
  return { id: `discogs:release:${releaseId}`, confidence };
};

/**
 * Persist a canonical-entity linkage on a library row. Stamps
 * `canonical_entity_resolved_at` with the current time so audits can tell
 * when the link was made and retry policies can age weak matches.
 */
export const updateCanonicalEntity = async (id: number, entityId: string, confidence: number) => {
  const response = await db
    .update(library)
    .set({
      canonical_entity_id: entityId,
      canonical_entity_confidence: confidence,
      canonical_entity_resolved_at: new Date(),
    })
    .where(eq(library.id, id))
    .returning();
  return response[0];
};

/**
 * Enrich search results with artwork URLs from LML.
 *
 * Results that already have artwork cached return as-is. For uncached results,
 * fetches artwork from LML in parallel via Promise.allSettled and writes back
 * to the library table (cache-through). Gracefully degrades if LML is
 * unavailable or times out.
 */
type ArtworkEnrichable = {
  id: number;
  artist_name: string;
  album_title: string;
  artwork_url: string | null | undefined;
};

export async function enrichWithArtwork<T extends ArtworkEnrichable>(results: T[]): Promise<T[]> {
  if (!isLmlConfigured()) return results;

  const uncached = results.filter((r) => r.artwork_url === null || r.artwork_url === undefined);
  if (uncached.length === 0) return results;

  const settlements = await Promise.allSettled(
    uncached.map(async (row) => {
      const lookupResult = await lmlLookupCoordinator.lookup(row.artist_name, row.album_title, undefined, {
        budgetMs: LIBRARY_INTERACTIVE_LML_BUDGET_MS,
        caller: 'library-enrich-artwork',
        requireSearchType: 'direct',
      });
      if (lookupResult === null) return;
      const artworkUrl = filterSpacerGif(lookupResult.results?.[0]?.artwork?.artwork_url);
      if (!artworkUrl) return;
      row.artwork_url = artworkUrl;
      await updateArtworkUrl(row.id, artworkUrl);
    })
  );

  for (const s of settlements) {
    if (s.status === 'rejected') {
      console.warn('[Library] Artwork enrichment failed:', s.reason);
    }
  }

  return results;
}

/**
 * Projection that mirrors `library_artist_view` so the search functions can
 * read from `library` directly (with explicit joins) and still return the
 * shape consumers expect. Reading from `library` is what lets the planner
 * pick the trigram or tsvector index on the predicated column instead of
 * forcing the 5-way view JOIN to materialize first.
 */
const LIBRARY_VIEW_PROJECTION = {
  id: library.id,
  code_letters: artists.code_letters,
  code_artist_number: genre_artist_crossreference.artist_genre_code,
  code_number: library.code_number,
  artist_name: artists.artist_name,
  alphabetical_name: artists.alphabetical_name,
  album_title: library.album_title,
  format_name: format.format_name,
  genre_name: genres.genre_name,
  rotation_bin: rotation.rotation_bin,
  add_date: library.add_date,
  label: library.label,
  label_id: library.label_id,
  on_streaming: library.on_streaming,
  album_artist: library.album_artist,
  plays: library.plays,
  artwork_url: library.artwork_url,
  discogs_artist_id: artists.discogs_artist_id,
  musicbrainz_artist_id: artists.musicbrainz_artist_id,
  wikidata_qid: artists.wikidata_qid,
  spotify_artist_id: artists.spotify_artist_id,
  apple_music_artist_id: artists.apple_music_artist_id,
  bandcamp_id: artists.bandcamp_id,
  artist_id: library.artist_id,
} as const;

/**
 * Raw SQL mirror of `libraryViewQuery(false)`'s join chain. Used when the
 * caller needs a query shape Drizzle's chained builder can't express
 * (the UNION ALL alias path emitted by `buildAliasHitsCte`). Schema is
 * named once here so a future column change is a single edit.
 */
const LIBRARY_VIEW_JOINS_RAW = sql`
  INNER JOIN ${artists} ON ${artists.id} = ${library.artist_id}
  INNER JOIN ${format} ON ${format.id} = ${library.format_id}
  INNER JOIN ${genres} ON ${genres.id} = ${library.genre_id}
  INNER JOIN ${genre_artist_crossreference}
    ON ${genre_artist_crossreference.artist_id} = ${library.artist_id}
    AND ${genre_artist_crossreference.genre_id} = ${library.genre_id}
  LEFT JOIN ${rotation}
    ON ${rotation.album_id} = ${library.id}
    AND (${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL)
`;

/** Raw SQL projection mirroring `LIBRARY_VIEW_PROJECTION` for the alias path. */
const LIBRARY_VIEW_PROJECTION_RAW = sql`
  ${library.id} AS id,
  ${artists.code_letters} AS code_letters,
  ${genre_artist_crossreference.artist_genre_code} AS code_artist_number,
  ${library.code_number} AS code_number,
  ${artists.artist_name} AS artist_name,
  ${artists.alphabetical_name} AS alphabetical_name,
  ${library.album_title} AS album_title,
  ${format.format_name} AS format_name,
  ${genres.genre_name} AS genre_name,
  ${rotation.rotation_bin} AS rotation_bin,
  ${library.add_date} AS add_date,
  ${library.label} AS label,
  ${library.label_id} AS label_id,
  ${library.on_streaming} AS on_streaming,
  ${library.album_artist} AS album_artist,
  ${library.plays} AS plays,
  ${library.artwork_url} AS artwork_url,
  ${artists.discogs_artist_id} AS discogs_artist_id,
  ${artists.musicbrainz_artist_id} AS musicbrainz_artist_id,
  ${artists.wikidata_qid} AS wikidata_qid,
  ${artists.spotify_artist_id} AS spotify_artist_id,
  ${artists.apple_music_artist_id} AS apple_music_artist_id,
  ${artists.bandcamp_id} AS bandcamp_id,
  ${library.artist_id} AS artist_id
`;

/**
 * Build the `alias_hits` CTE used by the UNION ALL alias-aware search paths
 * (BS#1318). The CTE runs the trigram bitmap scan over `artist_search_alias`
 * exactly once and groups by `artist_id`, yielding (artist_id, max_sim,
 * matched_variant, matched_source) for every artist whose alias substrate
 * matches `query`. Callers join this CTE on `artist_id` rather than running
 * a correlated LATERAL per candidate row.
 *
 * Replacement for the previous `LEFT JOIN LATERAL` design: the LATERAL was
 * correlated on `asa.artist_id = library.artist_id`, which steered the
 * planner onto the PK btree and filtered `variant % q` row-by-row, never
 * touching the GIN trigram index. The CTE form lets the planner pick the
 * trigram bitmap scan once and hash-join into the outer query.
 */
function buildAliasHitsCte(query: string) {
  return sql`WITH alias_hits AS (
    SELECT
      asa.artist_id,
      MAX(similarity(asa.variant, ${query})) AS max_sim,
      (array_agg(asa.variant ORDER BY similarity(asa.variant, ${query}) DESC))[1] AS matched_variant,
      (array_agg(asa.source ORDER BY similarity(asa.variant, ${query}) DESC))[1] AS matched_source
    FROM ${artist_search_alias} asa
    WHERE asa.variant % ${query}
    GROUP BY asa.artist_id
  )`;
}

/** Projection columns emitted by the alias branch of a UNION ALL search query. */
const ALIAS_HITS_PROJECTION = sql`,
  alias_hits.max_sim AS alias_max_sim,
  alias_hits.matched_variant AS alias_matched_variant,
  alias_hits.matched_source AS alias_matched_source`;

/** NULL placeholders for the alias-shape columns on the non-alias UNION ALL branch. */
const ALIAS_HITS_PROJECTION_NULLS = sql`,
  NULL::real AS alias_max_sim,
  NULL::text AS alias_matched_variant,
  NULL::text AS alias_matched_source`;

/**
 * Build the `FROM library` query shape with the joins needed to project the
 * `LibraryArtistViewEntry` columns. `withPlays` adds the `album_plays`
 * materialized view as a LEFT JOIN — only the tsvector ranker needs it, so
 * single-column trigram paths skip it.
 */
function libraryViewQuery(withPlays: boolean) {
  const base = db
    .select(LIBRARY_VIEW_PROJECTION)
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .leftJoin(
      rotation,
      sql`${rotation.album_id} = ${library.id} AND (${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL)`
    );
  return withPlays ? base.leftJoin(album_plays, eq(album_plays.album_id, library.id)) : base;
}

/** A query has at least one alphanumeric character. Pure punctuation skips both search paths. */
function hasAlphanumeric(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}

/**
 * Tsvector + plays ranker for the dj-site Both-mode default. Reads
 * `library.search_doc` (the STORED generated tsvector from migration 0058)
 * with `websearch_to_tsquery('simple', ...)` so multi-term queries get
 * AND-semantics, then weights ts_rank by `1 + ln(plays + 1)` to nudge
 * canonical answers up.
 *
 * The `(1 + ln(...))` shape is deliberate: `ln(plays + 1)` zeros out the
 * text-rank signal for albums with zero plays (most of the catalog), which
 * erases the ranking entirely for unpopular-but-relevant matches.
 */
async function searchLibraryByTsvector(
  query: string,
  n: number,
  on_streaming?: boolean
): Promise<LibraryArtistViewEntry[]> {
  const tsquery = sql`websearch_to_tsquery('simple', ${query})`;
  const tsvectorPredicate = sql`${library.search_doc} @@ ${tsquery}`;
  const streamingPredicate = on_streaming !== undefined ? eq(library.on_streaming, on_streaming) : undefined;

  return libraryViewQuery(true)
    .where(streamingPredicate ? and(tsvectorPredicate, streamingPredicate) : tsvectorPredicate)
    .orderBy(desc(sql`ts_rank(${library.search_doc}, ${tsquery}) * (1 + ln(coalesce(${album_plays.plays}, 0) + 1))`))
    .limit(n) as unknown as Promise<LibraryArtistViewEntry[]>;
}

/**
 * Trigram fallback for Both-mode: typos and weird casing that
 * `websearch_to_tsquery` won't match. Operates on the denormalized
 * `library.artist_name` (backfilled in A.2) so the predicate is
 * single-table and reachable by the per-column GIN trigram indexes.
 */
async function searchLibraryByTrigramBoth(
  query: string,
  n: number,
  on_streaming?: boolean
): Promise<TaggedLibraryViewEntry[]> {
  const aliasEnabled = getCatalogSearchAliasConfig().enabled;

  if (!aliasEnabled) {
    // Byte-identical legacy path. The alias-off branch must stay on the
    // chained builder so the planner reaches the per-column GIN trigram
    // indexes via the same bind shape as today.
    const trigramPredicate = sql`(${library.artist_name} % ${query} OR ${library.album_title} % ${query})`;
    const streamingPredicate = on_streaming !== undefined ? eq(library.on_streaming, on_streaming) : undefined;
    return libraryViewQuery(false)
      .where(streamingPredicate ? and(trigramPredicate, streamingPredicate) : trigramPredicate)
      .orderBy(
        desc(sql`GREATEST(similarity(${library.artist_name}, ${query}), similarity(${library.album_title}, ${query}))`)
      )
      .limit(n) as unknown as Promise<TaggedLibraryViewEntry[]>;
  }

  // Alias-enabled path: ALT1 UNION ALL (BS#1318). The CTE runs the trigram
  // bitmap scan once over `artist_search_alias`; branch (a) is the
  // byte-identical alias-OFF trigram predicate against `library`, branch (b)
  // joins the CTE on `artist_id` and dedupes against branch (a) via NOT-of
  // the same trigram predicate.
  //
  // The trigram OR-predicate is evaluated twice — once positively in (a),
  // once negated in (b) — but each is bitmap-indexable on its own, so the
  // total cost is dominated by the substrate scan + LIMIT pushdown on the
  // outer LAV scan rather than the correlated LATERAL's per-row scan.
  //
  // The UNION ALL is wrapped in a subquery so the outer ORDER BY can
  // reference both the trigram similarity and the CTE-provided
  // `alias_max_sim`. Postgres forbids expression-shaped ORDER BY directly on
  // a UNION result (column names only); the subquery lifts the union's
  // columns into a scope where `similarity(...)` is a legal ORDER BY term.
  const streamingClause = on_streaming !== undefined ? sql`AND ${library.on_streaming} = ${on_streaming}` : sql``;
  const trigramPredicate = sql`(${library.artist_name} % ${query} OR ${library.album_title} % ${query})`;
  const rows = (await db.execute(sql`
    ${buildAliasHitsCte(query)}
    SELECT * FROM (
      (
        SELECT ${LIBRARY_VIEW_PROJECTION_RAW}${ALIAS_HITS_PROJECTION_NULLS}
        FROM ${library}
        ${LIBRARY_VIEW_JOINS_RAW}
        WHERE ${trigramPredicate}
        ${streamingClause}
      )
      UNION ALL
      (
        SELECT ${LIBRARY_VIEW_PROJECTION_RAW}${ALIAS_HITS_PROJECTION}
        FROM ${library}
        ${LIBRARY_VIEW_JOINS_RAW}
        INNER JOIN alias_hits ON alias_hits.artist_id = ${library.artist_id}
        WHERE NOT ${trigramPredicate}
        ${streamingClause}
      )
    ) alias_search
    ORDER BY GREATEST(
      similarity(artist_name, ${query}),
      similarity(album_title, ${query}),
      COALESCE(alias_max_sim, 0)
    ) DESC
    LIMIT ${n}
  `)) as unknown as (LibraryArtistViewEntry & AliasHitFields)[];

  return rows.map(attachAliasHint);
}

/**
 * Catalog-track-search cascade: CTA (Track 1) → LML `/lookup` (Track 2),
 * each layer gated by its own `CATALOG_TRACK_SEARCH_*` feature flag.
 *
 * Shared by `searchLibraryBothMode` (the `/library/` route) and
 * `library-search.service.ts::runCascade` (the `/library/query` route) so
 * the two callers can't drift on flag gating, layer order, or future
 * per-layer concerns (telemetry, error isolation, cost guards).
 *
 * Returns raw `TaggedLibraryViewEntry[]`; callers handle their own
 * post-cascade projection (the catalog read-path applies
 * `serializeLibraryArtistViewEntry`; the query endpoint projects to
 * `AlbumSearchResultRow` and re-applies enum filters in-memory).
 */
export async function runCatalogTrackSearchCascade(
  query: string,
  limit: number,
  on_streaming?: boolean
): Promise<TaggedLibraryViewEntry[]> {
  const flags = getCatalogTrackSearchConfig();
  if (!flags.ctaEnabled && !flags.discogsEnabled) return [];

  if (flags.ctaEnabled) {
    const ctaResults = await searchLibraryByCTARaw(query, limit, on_streaming);
    if (ctaResults.length > 0) return ctaResults;
  }
  if (flags.discogsEnabled) {
    const trackResults = await searchLibraryByTrackRaw(query, limit);
    if (trackResults.length > 0) return trackResults;
  }
  return [];
}

/**
 * Run the Both-mode search cascade: tsvector → trigram → CTA → LML `/lookup`.
 *
 * Stages 1-2 (tsvector, trigram) read `library` directly via the per-column
 * GIN indexes. Stages 3-4 (CTA, LML) are the catalog-track-search cascade,
 * shared with `library-search.service.ts::runCascade` via
 * {@link runCatalogTrackSearchCascade}.
 *
 * Tsvector / trigram return plain `LibraryArtistViewEntry` rows; CTA / LML
 * return the same shape with a `matched_via` field tagging the fallback
 * source. The catalog read-path serializes the union via
 * `serializeLibraryArtistViewEntry`, so `matched_via` rides through to the
 * wire unchanged.
 *
 * Both feature flags default off, so for any deployment that hasn't opted in,
 * behavior is byte-identical to the pre-#972 baseline (tsvector → trigram → []).
 */
async function searchLibraryBothMode(
  query: string,
  n: number,
  on_streaming?: boolean
): Promise<TaggedLibraryViewEntry[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || !hasAlphanumeric(trimmed)) return [];

  const tsvectorResults = await searchLibraryByTsvector(trimmed, n, on_streaming);
  if (tsvectorResults.length > 0) return tsvectorResults;

  if (trimmed.length >= 2) {
    const trigramResults = await searchLibraryByTrigramBoth(trimmed, n, on_streaming);
    if (trigramResults.length > 0) return trigramResults;
  }

  return runCatalogTrackSearchCascade(trimmed, n, on_streaming);
}

export const fuzzySearchLibrary = async (
  artist_name?: string,
  album_title?: string,
  n = 5,
  on_streaming?: boolean
): Promise<TaggedLibraryViewEntry[]> => {
  // Skip only the trigram-OR branches; the both-same tsvector path handles
  // V/A queries cheaply via the search_doc GIN index.
  if (artist_name !== album_title && isCompilationArtist(artist_name)) {
    return [];
  }

  await checkLibraryArtistNameHealth();

  // Both-mode default (dj-site sends the same string as artist and title).
  // Route through tsvector → trigram → CTA → LML cascade so catalog clients
  // see `matched_via` for fallback-sourced hits (BS#972, plan §4.1 / §5.1).
  if (artist_name && album_title && artist_name === album_title) {
    return searchLibraryBothMode(artist_name, n, on_streaming);
  }

  const streamingPredicate = on_streaming !== undefined ? eq(library.on_streaming, on_streaming) : undefined;

  // Both fields set but different — keep the existing OR semantics, but
  // run on `library` directly so each side of the OR can use its trigram
  // index via BitmapOr instead of materializing the full view first.
  if (artist_name && album_title) {
    const trigramPredicate = sql`(${library.artist_name} % ${artist_name} OR ${library.album_title} % ${album_title})`;
    return libraryViewQuery(false)
      .where(streamingPredicate ? and(trigramPredicate, streamingPredicate) : trigramPredicate)
      .orderBy(asc(sql`${library.artist_name} <-> ${artist_name}`), asc(sql`${library.album_title} <-> ${album_title}`))
      .limit(n) as unknown as LibraryArtistViewEntry[];
  }

  // Single-column trigram path (Artists or Albums mode).
  const column = artist_name ? library.artist_name : library.album_title;
  const value = artist_name ?? album_title ?? null;
  const trigramPredicate = sql`${column} % ${value}`;
  return libraryViewQuery(false)
    .where(streamingPredicate ? and(trigramPredicate, streamingPredicate) : trigramPredicate)
    .orderBy(asc(sql`${column} <-> ${value}`))
    .limit(n) as unknown as LibraryArtistViewEntry[];
};

/**
 * Public wire-format for a library_artist_view row: the six flat external-ID
 * columns are stripped and replaced with a nested `reconciled_identity`.
 * `matched_via` rides through when the row came from the catalog-track-search
 * cascade (CTA / LML `/lookup` fallback), otherwise absent.
 */
export type LibraryArtistViewResponse = Omit<LibraryArtistViewEntry, ReconciledIdentityKey> & {
  reconciled_identity: ReconciledIdentity | null;
  matched_via?: TrackMatchHint[];
  matched_via_alias?: ArtistMatchHint[];
};

/**
 * Serialize a library_artist_view row for the wire (or any iterable of them).
 * Used at the read-endpoint boundary so the four `/library*` endpoints all
 * return the same nested-identity shape, regardless of whether they read the
 * view or join `artists` directly. Tagged rows (carrying `matched_via`)
 * preserve the tag through serialization.
 */
export function serializeLibraryArtistViewEntry(row: TaggedLibraryViewEntry): LibraryArtistViewResponse {
  return serializeReconciledIdentity(row) as LibraryArtistViewResponse;
}

/**
 * Look up the canonical `artist_name` for an `artists.id`. Used by addAlbum
 * (A.3) to denormalize the canonical name onto the library row so client-
 * supplied casing variants ("jessica pratt") never get persisted to library
 * out of sync with the `artists` row.
 */
export const getArtistNameById = async (artist_id: number): Promise<string | null> => {
  const response = await db
    .select({ artist_name: artists.artist_name })
    .from(artists)
    .where(eq(artists.id, artist_id))
    .limit(1);
  return response[0]?.artist_name ?? null;
};

export type ArtistInGenreSearchRow = {
  id: number;
  artist_name: string;
  code_letters: string;
  code_number: number;
};

/**
 * Prefix search for artists in a genre (catalog add-entry autocomplete).
 * `code_number` is the artist's number within that genre (`artist_genre_code`).
 */
export const searchArtistsInGenre = async (
  genre_id: number,
  q: string,
  limit: number
): Promise<ArtistInGenreSearchRow[]> => {
  const prefix = q.trim();
  if (prefix.length < 2) {
    return [];
  }

  const cappedLimit = Math.min(20, Math.max(1, limit));

  // Escape %/_ so e.g. q='%a' can't short the prefix-search contract into a
  // contains-anything scan (review issue 14).
  return db
    .select({
      id: artists.id,
      artist_name: artists.artist_name,
      code_letters: artists.code_letters,
      code_number: genre_artist_crossreference.artist_genre_code,
    })
    .from(artists)
    .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(and(eq(genre_artist_crossreference.genre_id, genre_id), ilikeEscaped(artists.artist_name, prefix, 'prefix')))
    .orderBy(asc(artists.artist_name))
    .limit(cappedLimit);
};

export const artistIdFromName = async (artist_name: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ id: artists.id })
    .from(artists)
    .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(
      and(
        sql`lower(${artists.artist_name}) = lower(${artist_name})`,
        eq(genre_artist_crossreference.genre_id, genre_id)
      )
    )
    .limit(1);

  if (!response.length) {
    return 0;
  } else {
    return response[0].id;
  }
};

export const insertArtist = async (new_artist: NewArtist) => {
  const response = await db.insert(artists).values(new_artist).returning();
  return response[0];
};

export const insertArtistGenreCrossreference = async (
  artist_id: number,
  genre_id: number,
  artist_genre_code: number
) => {
  const response = await db
    .insert(genre_artist_crossreference)
    .values({ artist_id, genre_id, artist_genre_code })
    .returning();
  return response[0];
};

export const getArtistByCode = async (
  code_letters: string,
  genre_id: number,
  artist_genre_code: number
): Promise<{ artist_id: number; artist_name: string; code_letters: string } | null> => {
  const response = await db
    .select({
      artist_id: genre_artist_crossreference.artist_id,
      artist_name: artists.artist_name,
      code_letters: artists.code_letters,
    })
    .from(genre_artist_crossreference)
    .innerJoin(artists, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(
      and(
        eq(artists.code_letters, code_letters),
        eq(genre_artist_crossreference.genre_id, genre_id),
        eq(genre_artist_crossreference.artist_genre_code, artist_genre_code)
      )
    )
    .limit(1);

  // return null if no artist found
  return response[0] ?? null;
};

export const generateAlbumCodeNumber = async (artist_id: number): Promise<number> => {
  const response = await db
    .select({ code_number: library.code_number })
    .from(library)
    .where(eq(library.artist_id, artist_id))
    .orderBy(desc(library.code_number))
    .limit(1);
  //in case this is the first album
  let code_number = 1;
  if (response.length) {
    code_number = response[0].code_number + 1; //otherwise we increment on the last value
  }
  return code_number;
};

export const generateArtistNumber = async (code_letters: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ artist_genre_code: genre_artist_crossreference.artist_genre_code })
    .from(genre_artist_crossreference)
    .innerJoin(artists, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(and(eq(artists.code_letters, code_letters), eq(genre_artist_crossreference.genre_id, genre_id)))
    .orderBy(desc(genre_artist_crossreference.artist_genre_code))
    .limit(1);

  // default to being first artist in the genre
  let artist_genre_code = 1;
  if (response.length) {
    artist_genre_code = response[0].artist_genre_code + 1; //otherwise we increment on the last value
  }
  return artist_genre_code;
};

/**
 * Partial-update payload for PATCH /library/:id. Every field is optional —
 * `updateAlbumInDB` only SETs keys that are present, so omitted fields are
 * never overwritten (PR #1154 review: a title-typo fix must not reset
 * disc_quantity to 1 or wipe alternate_artist_name / label_id).
 */
export type UpdateAlbumRow = {
  album_title?: string;
  label?: string | null;
  label_id?: number | null;
  genre_id?: number;
  format_id?: number;
  artist_id?: number;
  artist_name?: string;
  alternate_artist_name?: string | null;
  disc_quantity?: number;
  code_number?: number;
  // BS#1281 (Not-on-Discogs 1a). `discogs_unavailable_note` accepts an
  // explicit null (clearing the note when the flag drops); the SET loop below
  // preserves null because `null !== undefined`.
  discogs_unavailable?: boolean;
  discogs_unavailable_note?: string | null;
};

export const updateAlbumInDB = async (album_id: number, updates: UpdateAlbumRow) => {
  const set: Record<string, unknown> = { last_modified: sql`NOW()` };
  for (const key of [
    'album_title',
    'label',
    'label_id',
    'genre_id',
    'format_id',
    'artist_id',
    'artist_name',
    'alternate_artist_name',
    'disc_quantity',
    'code_number',
    'discogs_unavailable',
    'discogs_unavailable_note',
  ] as const) {
    if (updates[key] !== undefined) set[key] = updates[key];
  }
  // Deliberately NOT nulling the LML-derived columns (on_streaming /
  // artwork_url / canonical_entity_*) here. The old reset-then-maybe-refill
  // shape permanently wiped enrichment whenever the post-write re-lookup was
  // skipped (LML unconfigured) or found no match (transient outage, or a
  // freeform-radio artist with no Discogs "direct" match) — and no recurring
  // job repairs those columns (BS#1549). The controller now re-fires
  // enrichment and overwrites each column only on a successful lookup
  // (refill-then-swap), so a failed/empty lookup leaves the prior values
  // intact instead of stranding the row blank.
  const result = await db.update(library).set(set).where(eq(library.id, album_id)).returning({ id: library.id });
  return result[0];
};

/** Raw library row used by PATCH /library/:id to diff incoming fields. */
export const getLibraryRowById = async (album_id: number) => {
  const rows = await db
    .select({
      id: library.id,
      artist_id: library.artist_id,
      genre_id: library.genre_id,
      format_id: library.format_id,
      album_title: library.album_title,
      label: library.label,
      label_id: library.label_id,
      alternate_artist_name: library.alternate_artist_name,
      disc_quantity: library.disc_quantity,
      code_number: library.code_number,
      artist_name: library.artist_name,
      // BS#1281: the PATCH handler reads the live flag to judge a note-only
      // edit against the `flag ⟺ note` invariant.
      discogs_unavailable: library.discogs_unavailable,
      discogs_unavailable_note: library.discogs_unavailable_note,
    })
    .from(library)
    .where(eq(library.id, album_id))
    .limit(1);
  return rows[0];
};

/** True when `artist_id` already owns an album with this `code_number` (excluding `exclude_album_id`). */
export const albumCodeNumberTaken = async (
  artist_id: number,
  code_number: number,
  exclude_album_id: number
): Promise<boolean> => {
  const rows = await db
    .select({ id: library.id })
    .from(library)
    .where(
      and(eq(library.artist_id, artist_id), eq(library.code_number, code_number), ne(library.id, exclude_album_id))
    )
    .limit(1);
  return rows.length > 0;
};

export const artistExistsInGenre = async (artist_id: number, genre_id: number): Promise<boolean> => {
  const rows = await db
    .select({ artist_id: genre_artist_crossreference.artist_id })
    .from(genre_artist_crossreference)
    .where(
      and(eq(genre_artist_crossreference.artist_id, artist_id), eq(genre_artist_crossreference.genre_id, genre_id))
    )
    .limit(1);
  return rows.length > 0;
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      id: library.id,
      artist_id: library.artist_id,
      genre_id: library.genre_id,
      format_id: library.format_id,
      code_letters: artists.code_letters,
      code_artist_number: genre_artist_crossreference.artist_genre_code,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      alphabetical_name: artists.alphabetical_name,
      album_title: library.album_title,
      label: library.label,
      record_label: library.label,
      label_id: library.label_id,
      alternate_artist_name: library.alternate_artist_name,
      disc_quantity: library.disc_quantity,
      album_artist: library.album_artist,
      plays: library.plays,
      add_date: library.add_date,
      last_modified: library.last_modified,
      format_name: format.format_name,
      genre_name: genres.genre_name,
      date_lost: library.date_lost,
      date_found: library.date_found,
      on_streaming: library.on_streaming,
      discogs_artist_id: artists.discogs_artist_id,
      musicbrainz_artist_id: artists.musicbrainz_artist_id,
      wikidata_qid: artists.wikidata_qid,
      spotify_artist_id: artists.spotify_artist_id,
      apple_music_artist_id: artists.apple_music_artist_id,
      bandcamp_id: artists.bandcamp_id,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .where(eq(library.id, album_id))
    .limit(1);

  if (!album[0]) return undefined;
  return serializeReconciledIdentity(album[0]);
};

export const markAlbumMissing = async (album_id: number) => {
  const result = await db
    .update(library)
    .set({ date_lost: sql`NOW()`, date_found: null, last_modified: sql`NOW()` })
    .where(eq(library.id, album_id))
    .returning({ id: library.id });
  return result[0];
};

export const markAlbumFound = async (album_id: number) => {
  const result = await db
    .update(library)
    .set({ date_found: sql`NOW()`, last_modified: sql`NOW()` })
    .where(eq(library.id, album_id))
    .returning({ id: library.id });
  return result[0];
};

export const getGenresFromDB = async () => {
  const genreCollection = await db.select().from(genres);
  return genreCollection;
};

export const genreExists = async (genre_id: number): Promise<boolean> => {
  const rows = await db.select({ id: genres.id }).from(genres).where(eq(genres.id, genre_id)).limit(1);
  return rows.length > 0;
};

export const insertGenre = async (genre: NewGenre) => {
  const response = await db.insert(genres).values(genre).returning();
  return response[0];
};

export const isISODate = (date: string): boolean => {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  return date.match(regex) !== null;
};

// =============================================================================
// Request Line Enhanced Search Functions
// =============================================================================

/**
 * Convert a library_artist_view row to LibraryResult.
 */
function viewRowToLibraryResult(row: LibraryArtistViewEntry): LibraryResult {
  return {
    id: row.id,
    title: row.album_title,
    artist: row.artist_name,
    alphabeticalName: row.alphabetical_name,
    codeLetters: row.code_letters,
    codeArtistNumber: row.code_artist_number,
    codeNumber: row.code_number,
    genre: row.genre_name,
    format: row.format_name,
    onStreaming: row.on_streaming,
    reconciledIdentity: toReconciledIdentity(row),
  };
}

/**
 * Search the library catalog with flexible query options.
 *
 * Routes per the A.5 design:
 * - Free-text `query`: tsvector + plays ranking on `library.search_doc`,
 *   with a trigram fallback when tsvector returns 0 rows. The fallback is
 *   gated so pure-punctuation / single-char queries don't hit the DB twice.
 * - Single-column `artist` or `title`: existing trigram path on the
 *   matching column, but reading from `library` directly so the planner
 *   uses the per-column GIN index instead of forcing the 5-way view JOIN.
 *
 * @param query - Free text search query (artist and/or album)
 * @param artist - Artist name filter
 * @param title - Album/title filter
 * @param limit - Maximum results to return
 * @returns Array of enriched library results
 */
export async function searchLibrary(
  query?: string,
  artist?: string,
  title?: string,
  limit = 5,
  on_streaming?: boolean
): Promise<EnrichedLibraryResult[]> {
  await checkLibraryArtistNameHealth();

  // searchLibraryBothMode now owns the full cascade (tsvector → trigram → CTA
  // → LML); BS#972 unified the cascade location so the catalog read-path at
  // GET /library/ can reach it via fuzzySearchLibrary. Map view rows to
  // EnrichedLibraryResult and carry `matched_via` through.
  const rows = query
    ? await searchLibraryBothMode(query, limit, on_streaming)
    : artist || title
      ? await fuzzySearchLibrary(artist, title, limit, on_streaming)
      : [];

  return rows.map((row) => {
    const enriched = enrichLibraryResult(viewRowToLibraryResult(row));
    if (row.matched_via) enriched.matched_via = row.matched_via;
    if (row.matched_via_alias) enriched.matched_via_alias = row.matched_via_alias;
    return enriched;
  });
}

/**
 * Find a similar artist name in the library using fuzzy matching.
 *
 * Useful for correcting typos or spelling variants (e.g., "Color" vs "Colour").
 *
 * @param artistName - Artist name to match
 * @param threshold - Minimum similarity score (0.0 to 1.0) to accept
 * @returns Corrected artist name if a good match is found, null otherwise
 */
export async function findSimilarArtist(artistName: string, threshold = 0.85): Promise<string | null> {
  await checkLibraryArtistNameHealth();

  // Use pg_trgm similarity function to find close matches. Reads from
  // `library` directly so the planner uses the GIN trigram index on
  // `library.artist_name` (added in 0058) without materializing the view.
  const query = sql`
    SELECT DISTINCT ${library.artist_name} AS artist_name,
      similarity(${library.artist_name}, ${artistName}) as sim
    FROM ${library}
    WHERE similarity(${library.artist_name}, ${artistName}) > ${threshold}
    ORDER BY sim DESC
    LIMIT 1
  `;

  const response = await db.execute(query);
  const rows = response as unknown as Array<{ artist_name: string; sim: number }>;

  if (rows.length > 0) {
    const match = rows[0];
    // Only return if it's actually different (i.e., a correction)
    if (match.artist_name.toLowerCase() !== artistName.toLowerCase()) {
      console.log(
        `[Library] Corrected artist '${artistName}' to '${match.artist_name}' (similarity: ${match.sim.toFixed(2)})`
      );
      return match.artist_name;
    }
  }

  return null;
}

/**
 * Search for albums by title with fuzzy matching.
 *
 * Useful for cross-referencing Discogs album titles with the library.
 *
 * @param albumTitle - Album title to search for
 * @param limit - Maximum results to return
 * @returns Array of enriched library results
 */
export async function searchAlbumsByTitle(albumTitle: string, limit = 5): Promise<EnrichedLibraryResult[]> {
  await checkLibraryArtistNameHealth();

  const rows = (await libraryViewQuery(false)
    .where(sql`${library.album_title} % ${albumTitle}`)
    .orderBy(desc(sql`similarity(${library.album_title}, ${albumTitle})`))
    .limit(limit)) as unknown as LibraryArtistViewEntry[];

  return rows.map((row) => enrichLibraryResult(viewRowToLibraryResult(row)));
}

/**
 * Search the library for releases that contain a track matching `query`.
 *
 * Thin BS-side proxy for LML's `/api/v1/lookup` `SONG_AS_TRACK` strategy
 * (LML#301, catalog-track-search plan §4.2). LML cross-references the title
 * against Discogs, validates the track-on-release server-side, and ranks the
 * results; BS only:
 *
 *   1. Bridges each LML `library_item.id` (which equals BS
 *      `library.legacy_release_id` — 99.88% populated) to a BS `library.id`
 *      via the unique index `library_legacy_release_id_idx`.
 *   2. Excludes library rows already covered by `compilation_track_artist`
 *      for the same query — Track 1 (BS#817) surfaces those; this is the
 *      fallback strategy and should not double-count.
 *   3. Preserves LML's ordering. BS does not re-rank.
 *
 * LML HTTP errors propagate; the wrapper translates them to an empty result
 * for callers, but the throw lets the wrapper skip cache-poisoning. Catalog
 * search is the only consumer today and treats Track 2 as best-effort.
 *
 * Results are memoized by the wrapper in a process-local LRU (size 1000, TTL
 * 10 minutes, keyed by lowercased+trimmed query plus a hash of the
 * catalog-track-search flag state); see {@link searchLibraryByTrack}.
 *
 * Always materializes the full LML-bounded result; the caller's `limit` is
 * applied by the wrapper post-cache so a `limit=10` miss can serve a smaller
 * `limit=5` hit without a second LML round-trip.
 *
 * @param query - Track-title query
 * @returns Array of enriched library results with `matched_via` populated
 * @throws Whatever `lookupBySong` throws — the wrapper handles the boundary.
 */
async function searchLibraryByTrackUncachedOrThrow(query: string): Promise<TaggedLibraryViewEntry[]> {
  const lookupStart = performance.now();
  const response: LookupResponse = await lookupBySong(query, {
    budgetMs: LIBRARY_INTERACTIVE_LML_BUDGET_MS,
    caller: 'library-track-search',
  });
  try {
    Sentry.getActiveSpan()?.setAttributes({
      'track_search.master_lookup_ms': performance.now() - lookupStart,
    });
  } catch (err) {
    console.warn('[Library] searchLibraryByTrack: failed to project master_lookup_ms onto span', err);
  }

  const items = response.results ?? [];
  if (items.length === 0) return [];

  // LML's library_item.id is the legacy MySQL surrogate; BS stores it as
  // library.legacy_release_id. Bridge that to BS library.id so callers get
  // the row id their controllers and dj-site links expect.
  const legacyIds = items.map((item) => item.library_item?.id).filter((id): id is number => typeof id === 'number');
  if (legacyIds.length === 0) return [];

  // Read the view shape plus legacy_release_id so we can re-order BS rows in
  // LML's response order below. legacy_release_id is not in
  // LIBRARY_VIEW_PROJECTION because the public view doesn't expose it.
  const rows = (await db
    .select({ ...LIBRARY_VIEW_PROJECTION, legacy_release_id: library.legacy_release_id })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .leftJoin(
      rotation,
      sql`${rotation.album_id} = ${library.id} AND (${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL)`
    )
    .where(inArray(library.legacy_release_id, legacyIds))
    // Bound by the LML response size (already capped server-side). The
    // wrapper trims to caller's `limit` post-cache so the cached entry can
    // serve any smaller caller-`limit` from a single LML + JOIN round-trip.
    .limit(legacyIds.length)) as unknown as Array<LibraryArtistViewEntry & { legacy_release_id: number | null }>;

  // CTA-covered library rows are Track 1's responsibility; filter them out so
  // the read layer doesn't double-surface compilations alongside curated CTA
  // hits.
  const ctaRows =
    rows.length === 0
      ? []
      : ((await db
          .select({ library_id: compilation_track_artist.library_id })
          .from(compilation_track_artist)
          .where(
            and(
              inArray(
                compilation_track_artist.library_id,
                rows.map((r) => r.id)
              ),
              ilikeEscaped(compilation_track_artist.track_title, query, 'contains')
            )
          )) as Array<{ library_id: number }>);
  const ctaCovered = new Set(ctaRows.map((r) => r.library_id));

  // Index BS rows by legacy_release_id so we can emit them in LML's order.
  const rowsByLegacyId = new Map<number, LibraryArtistViewEntry & { legacy_release_id: number | null }>();
  for (const row of rows) {
    if (row.legacy_release_id != null) {
      rowsByLegacyId.set(row.legacy_release_id, row);
    }
  }

  const results: TaggedLibraryViewEntry[] = [];
  for (const item of items) {
    const legacyId = item.library_item?.id;
    if (legacyId == null) continue;
    const row = rowsByLegacyId.get(legacyId);
    if (!row) continue;
    if (ctaCovered.has(row.id)) continue;
    const { legacy_release_id: _legacy, ...viewRow } = row;
    const tagged: TaggedLibraryViewEntry = { ...viewRow };
    if (item.matched_via && item.matched_via.length > 0) {
      tagged.matched_via = item.matched_via;
    }
    results.push(tagged);
  }
  return results;
}

// --- Track 2 result cache ---
//
// LML's /lookup is the slowest hop in the cascade (HTTP + 3-tier cache), and
// the BS-side bridge query is a 5-way join. Memoizing the final mapped
// EnrichedLibraryResult[] lets repeat searches skip both. Key includes a hash
// of the catalog-track-search feature flags so a flag flip invalidates the
// cache implicitly (the next call generates a new key prefix).
//
// `limit` is intentionally NOT part of the cache key. `searchLibraryByTrack`
// stores the full LML-bounded result set (LML already caps server-side; the
// BS JOIN binds to `legacyIds.length`) and slices to the caller's `limit` at
// read time. This lets a `limit=10` miss serve a subsequent `limit=5` hit
// without a second LML round-trip.
//
// Mirrors the LRUCache shape used in artworkCache (apps/backend/controllers/
// proxy.controller.ts). Plan reference:
// https://github.com/WXYC/wiki/blob/main/plans/catalog-track-search.md#103-latency--cache-budget

const trackSearchCache = new LRUCache<string, TaggedLibraryViewEntry[]>({
  max: 1000,
  ttl: 1000 * 60 * 10, // 10 minutes
});

function getFlagStateHash(): string {
  const c = getCatalogTrackSearchConfig();
  return `${c.ctaEnabled ? '1' : '0'}${c.discogsEnabled ? '1' : '0'}`;
}

function trackSearchCacheKey(query: string): string {
  return `${query.toLowerCase().trim()}:${getFlagStateHash()}`;
}

/**
 * Test-only hook for clearing the Track 2 LRU between cases. Production code
 * relies on TTL expiry + flag-state-hash invalidation; tests need a way to
 * reset state between `beforeEach` runs.
 *
 * NOTE: this cache is module-scoped, so any test file that exercises the
 * Track 2 cascade (directly or transitively) must call this in its own
 * `beforeEach` — otherwise cache state leaks across files within the same
 * Jest worker. The global unit setup (tests/setup/unit.setup.ts) deliberately
 * stays free of service imports; per-file discipline is the contract.
 */
export function __resetTrackSearchCacheForTests(): void {
  trackSearchCache.clear();
}

/**
 * Memoized wrapper around {@link searchLibraryByTrackUncachedOrThrow}. Cache hits
 * return the mapped `EnrichedLibraryResult[]` (BS rows, `matched_via`, LML
 * ordering) without touching LML or the BS PG JOIN.
 *
 * **Telemetry (BS#828).** Wraps the call in a `catalog.track_search` Sentry
 * span and projects three attributes onto it: `track_search.cache_hit` (true
 * on hit, false on miss), `track_search.master_lookup_ms` (LML hop only —
 * 0 on cache hit, set by the inner via the active span on miss), and
 * `track_search.latency_ms` (total). Pattern: wrap-at-chokepoint +
 * project-onto-span (sibling: LML#213 / BS#646 for LML cache_stats).
 * Callers up the cascade in `searchLibrary` must not add their own
 * instrumentation.
 *
 * LML failures are NOT cached: if `lookupBySong` rejects, the wrapper returns
 * `[]` straight through without polluting the cache. A genuine empty LML
 * response (no matching releases) IS cached — both because that's the
 * expected steady-state for nonsense queries and because re-running the
 * round-trip every time would defeat the cache's purpose.
 *
 * The returned array is a shallow copy of the cached entry, so callers can
 * sort or mutate without bleeding into subsequent hits.
 *
 * @param query - Track-title query
 * @param limit - Maximum results to return
 * @returns Array of enriched library results with `matched_via` populated
 */
export async function searchLibraryByTrackRaw(query: string, limit: number): Promise<TaggedLibraryViewEntry[]> {
  return Sentry.startSpan({ name: 'searchLibraryByTrack', op: 'catalog.track_search' }, async (span) => {
    const start = performance.now();
    // master_lookup_ms is set by searchLibraryByTrackUncachedOrThrow on the
    // miss path (via the active span). Default to 0 so cache hits and
    // pre-LML failures still emit a numeric value — p95 dashboards then
    // see one row per call without coalesce.
    let lmlSucceeded = true;
    let results: TaggedLibraryViewEntry[];

    const key = trackSearchCacheKey(query);
    const cached = trackSearchCache.get(key);
    if (cached !== undefined) {
      span.setAttribute('track_search.cache_hit', true);
      results = cached.slice(0, limit);
    } else {
      span.setAttribute('track_search.cache_hit', false);
      // Fetch the full LML-bounded result; the cache stores the un-sliced array.
      try {
        results = await searchLibraryByTrackUncachedOrThrow(query);
      } catch {
        lmlSucceeded = false;
        results = [];
      }
      if (lmlSucceeded) {
        trackSearchCache.set(key, results);
      }
      results = results.slice(0, limit);
    }

    // Observability must never break the request path. If the Sentry SDK
    // (or a custom transport hook) throws, swallow the error and continue.
    try {
      span.setAttributes({ 'track_search.latency_ms': performance.now() - start });
    } catch (err) {
      console.warn('[Library] searchLibraryByTrack: failed to project latency onto span', err);
    }
    return results;
  });
}

/**
 * Enriched-shape wrapper around {@link searchLibraryByTrackRaw}. Returns
 * `EnrichedLibraryResult[]` for request-line callers; catalog callers use the
 * raw form via `searchLibraryBothMode`.
 */
export async function searchLibraryByTrack(query: string, limit: number): Promise<EnrichedLibraryResult[]> {
  const rows = await searchLibraryByTrackRaw(query, limit);
  return rows.map((row) => {
    const enriched = enrichLibraryResult(viewRowToLibraryResult(row));
    if (row.matched_via) enriched.matched_via = row.matched_via;
    return enriched;
  });
}

/**
 * Search the library for releases by a specific artist.
 *
 * @param artistName - Artist name to search for
 * @param limit - Maximum results to return
 * @returns Array of enriched library results
 */
export async function searchByArtist(artistName: string, limit = 5): Promise<EnrichedLibraryResult[]> {
  await checkLibraryArtistNameHealth();

  const aliasEnabled = getCatalogSearchAliasConfig().enabled;

  if (!aliasEnabled) {
    const rows = (await libraryViewQuery(false)
      .where(sql`${library.artist_name} % ${artistName}`)
      .orderBy(desc(sql`similarity(${library.artist_name}, ${artistName})`))
      .limit(limit)) as unknown as LibraryArtistViewEntry[];

    return rows.map((row) => enrichLibraryResult(viewRowToLibraryResult(row)));
  }

  // Alias-enabled: ALT1 UNION ALL (BS#1318). Single-column trigram on
  // `library.artist_name` as branch (a); branch (b) joins the CTE on
  // `artist_id` and excludes rows already matched by (a). GREATEST collapses
  // to MAX of two terms since there's no album_title predicate here.
  //
  // Wrap the UNION ALL in a subquery so the outer ORDER BY can use
  // expression-shaped terms (`similarity(...)`); Postgres forbids
  // expression ORDER BY directly on a UNION result.
  const trigramPredicate = sql`${library.artist_name} % ${artistName}`;
  const rows = (await db.execute(sql`
    ${buildAliasHitsCte(artistName)}
    SELECT * FROM (
      (
        SELECT ${LIBRARY_VIEW_PROJECTION_RAW}${ALIAS_HITS_PROJECTION_NULLS}
        FROM ${library}
        ${LIBRARY_VIEW_JOINS_RAW}
        WHERE ${trigramPredicate}
      )
      UNION ALL
      (
        SELECT ${LIBRARY_VIEW_PROJECTION_RAW}${ALIAS_HITS_PROJECTION}
        FROM ${library}
        ${LIBRARY_VIEW_JOINS_RAW}
        INNER JOIN alias_hits ON alias_hits.artist_id = ${library.artist_id}
        WHERE NOT ${trigramPredicate}
      )
    ) alias_search
    ORDER BY GREATEST(
      similarity(artist_name, ${artistName}),
      COALESCE(alias_max_sim, 0)
    ) DESC
    LIMIT ${limit}
  `)) as unknown as (LibraryArtistViewEntry & AliasHitFields)[];

  return rows.map((row) => {
    const tagged = attachAliasHint(row);
    const enriched = enrichLibraryResult(viewRowToLibraryResult(tagged));
    if (tagged.matched_via_alias) enriched.matched_via_alias = tagged.matched_via_alias;
    return enriched;
  });
}

/**
 * Row shape returned by `searchLibraryByCTA`: the standard `LibraryArtistViewEntry`
 * projection plus the matched track_title and artist_name from
 * `compilation_track_artist`. One row per matched CTA entry; grouped to one
 * EnrichedLibraryResult per library_id in TS.
 */
type CTASearchRow = LibraryArtistViewEntry & {
  cta_track_title: string | null;
  cta_artist_name: string;
};

/**
 * Search the library for compilation tracks whose `track_title` or
 * `artist_name` matches `query` via ILIKE. Returns raw library_artist_view
 * rows (one per matched release) with `matched_via` attached. Used by
 * `searchLibraryBothMode` as the Track 1 (CTA) cascade layer; the enriched
 * wrapper {@link searchLibraryByCTA} maps these to `EnrichedLibraryResult[]`
 * for request-line callers.
 *
 * Returning tagged view rows (rather than enriched results) lets catalog
 * read-paths reuse the wire-shape serializer (`serializeLibraryArtistViewEntry`)
 * without losing `add_date`, `label`, `artwork_url`, etc. (BS#972).
 *
 * @param query - Free text query matched against `track_title` and `artist_name`
 * @param limit - Maximum results to return (counts library rows, not CTA rows)
 * @param on_streaming - Optional filter on `library.on_streaming`
 * @returns Array of tagged view rows with `matched_via` populated
 */
export async function searchLibraryByCTARaw(
  query: string,
  limit: number,
  on_streaming?: boolean
): Promise<TaggedLibraryViewEntry[]> {
  const trimmed = query.trim();
  // Mirror searchLibraryBothMode's guard: pure-punctuation queries (`!!!`,
  // `---`) would otherwise run an unanchored ILIKE scan over every CTA row.
  if (trimmed.length === 0 || !hasAlphanumeric(trimmed)) return [];

  await checkLibraryArtistNameHealth();

  const matchPredicate = sql`(${ilikeEscaped(compilation_track_artist.track_title, trimmed, 'contains')} OR ${ilikeEscaped(compilation_track_artist.artist_name, trimmed, 'contains')})`;
  const streamingPredicate = on_streaming !== undefined ? sql` AND ${library.on_streaming} = ${on_streaming}` : sql``;

  // Raw SQL because we need both the library_artist_view projection and the
  // matched-track columns from `compilation_track_artist` in a single row,
  // which the chained `libraryViewQuery` shape can't express. `limit` is
  // applied per-library-row (via the `DENSE_RANK` window) so that callers
  // get N releases even when a single release contributes multiple hints.
  const queryStmt = sql`
    SELECT * FROM (
      SELECT
        ${library.id} AS id,
        ${artists.code_letters} AS code_letters,
        ${genre_artist_crossreference.artist_genre_code} AS code_artist_number,
        ${library.code_number} AS code_number,
        ${artists.artist_name} AS artist_name,
        ${artists.alphabetical_name} AS alphabetical_name,
        ${library.album_title} AS album_title,
        ${format.format_name} AS format_name,
        ${genres.genre_name} AS genre_name,
        ${rotation.rotation_bin} AS rotation_bin,
        ${library.add_date} AS add_date,
        ${library.label} AS label,
        ${library.label_id} AS label_id,
        ${library.on_streaming} AS on_streaming,
        ${library.album_artist} AS album_artist,
        ${library.plays} AS plays,
        ${library.artwork_url} AS artwork_url,
        ${artists.discogs_artist_id} AS discogs_artist_id,
        ${artists.musicbrainz_artist_id} AS musicbrainz_artist_id,
        ${artists.wikidata_qid} AS wikidata_qid,
        ${artists.spotify_artist_id} AS spotify_artist_id,
        ${artists.apple_music_artist_id} AS apple_music_artist_id,
        ${artists.bandcamp_id} AS bandcamp_id,
        ${compilation_track_artist.track_title} AS cta_track_title,
        ${compilation_track_artist.artist_name} AS cta_artist_name,
        DENSE_RANK() OVER (ORDER BY ${library.id}) AS library_rank
      FROM ${compilation_track_artist}
      INNER JOIN ${library} ON ${library.id} = ${compilation_track_artist.library_id}
      INNER JOIN ${artists} ON ${artists.id} = ${library.artist_id}
      INNER JOIN ${format} ON ${format.id} = ${library.format_id}
      INNER JOIN ${genres} ON ${genres.id} = ${library.genre_id}
      INNER JOIN ${genre_artist_crossreference}
        ON ${genre_artist_crossreference.artist_id} = ${library.artist_id}
        AND ${genre_artist_crossreference.genre_id} = ${library.genre_id}
      LEFT JOIN ${rotation}
        ON ${rotation.album_id} = ${library.id}
        AND (${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL)
      WHERE ${matchPredicate}${streamingPredicate}
    ) ranked
    WHERE library_rank <= ${limit}
    ORDER BY library_rank, cta_track_title
  `;

  const rows = (await db.execute(queryStmt)) as unknown as CTASearchRow[];
  if (rows.length === 0) return [];

  // Group CTA rows by library_id: one EnrichedLibraryResult per release with
  // a `matched_via` hint per CTA row. Preserves the first-seen ordering so
  // callers see the same DB sort.
  const byLibraryId = new Map<number, { row: CTASearchRow; hints: TrackMatchHint[] }>();
  for (const row of rows) {
    const existing = byLibraryId.get(row.id);
    const hint: TrackMatchHint = {
      title: row.cta_track_title ?? '',
      artist_credit: row.cta_artist_name,
      source: 'cta',
      confidence: 1.0,
    };
    if (existing) {
      existing.hints.push(hint);
    } else {
      byLibraryId.set(row.id, { row, hints: [hint] });
    }
  }

  return Array.from(byLibraryId.values()).map(({ row, hints }) => {
    // Strip the CTA-only join columns so the returned row conforms to
    // `LibraryArtistViewEntry`. The wire-shape serializer would otherwise
    // emit `cta_track_title` / `cta_artist_name` next to `matched_via`.
    const { cta_track_title: _t, cta_artist_name: _a, ...viewRow } = row;
    return { ...viewRow, matched_via: hints } as TaggedLibraryViewEntry;
  });
}

/**
 * Enriched-shape wrapper around {@link searchLibraryByCTARaw}. Returns
 * `EnrichedLibraryResult[]` for request-line callers that compose with the
 * other search strategies (`searchAlbumsByTitle`, `searchByArtist`).
 */
export async function searchLibraryByCTA(
  query: string,
  limit: number,
  on_streaming?: boolean
): Promise<EnrichedLibraryResult[]> {
  const rows = await searchLibraryByCTARaw(query, limit, on_streaming);
  return rows.map((row) => {
    const enriched = enrichLibraryResult(viewRowToLibraryResult(row));
    if (row.matched_via) enriched.matched_via = row.matched_via;
    return enriched;
  });
}

/**
 * Filter library results to only include those matching the artist.
 *
 * Requires the searched artist name to appear at the START of the result's
 * artist field (case-insensitive). This prevents false positives like
 * "Toy" matching "Chew Toy" while still allowing "Various" to match
 * "Various Artists - Rock - D".
 *
 * @param results - List of library items from search
 * @param artist - Artist name to filter by
 * @returns Filtered list containing only items where artist matches
 */
export function filterResultsByArtist(
  results: EnrichedLibraryResult[],
  artist: string | null | undefined
): EnrichedLibraryResult[] {
  if (!artist) {
    return results;
  }

  const artistLower = artist.toLowerCase();
  const filtered = results.filter((item) => {
    const itemArtist = (item.artist || '').toLowerCase();
    // Check if result's artist starts with searched artist
    return itemArtist.startsWith(artistLower);
  });

  if (filtered.length < results.length) {
    console.log(`[Library] Filtered ${results.length} results to ${filtered.length} matching artist '${artist}'`);
  }

  return filtered;
}
