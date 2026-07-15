import { Request, RequestHandler } from 'express';
import {
  Album,
  Artist,
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  NewRotationRelease,
  RotationRelease,
} from '@wxyc/database';
import { gunzipSync } from 'node:zlib';
import * as libraryService from '../services/library.service.js';
import * as catalogExportService from '../services/catalog-export.service.js';
import * as bmiPerformanceService from '../services/bmi-performance.service.js';
import * as labelsService from '../services/labels.service.js';
import * as librarySearchService from '../services/library-search.service.js';
import type { CatalogSort, CatalogOrder } from '../services/library-search.service.js';
import { checkStreamingAvailability, isLmlConfigured, envInt } from '@wxyc/lml-client';
import { lmlLookupCoordinator } from '../services/lml/index.js';
import { filterSpacerGif } from '../services/metadata/metadata.service.js';
import WxycError from '../utils/error.js';

/**
 * Budget for the add-album insert + fire-and-forget canonical-entity paths.
 * The row is already persisted before either call fires, so the budget is
 * about freeing LML's Discogs quota — not about 201 latency. 5 s matches the
 * other runtime-interactive sites. See `LookupOptions.budgetMs` for mechanics.
 */
const LIBRARY_LML_BUDGET_MS = envInt('LIBRARY_LML_BUDGET_MS', 5000);

type NewAlbumRequest = {
  album_title: string;
  artist_name?: string;
  artist_id?: number;
  alternate_artist_name?: string;
  label: string;
  label_id?: number;
  genre_id: number;
  format_id: number;
  disc_quantity?: number;
};

//Check if artist exists.
//Add new album to library
export const addAlbum: RequestHandler = async (req: Request<object, object, NewAlbumRequest>, res) => {
  const { body } = req;
  if (
    body.album_title === undefined ||
    body.label === undefined ||
    body.genre_id === undefined ||
    body.format_id === undefined ||
    (body.artist_name === undefined && body.artist_id === undefined)
  ) {
    throw new WxycError('Missing Parameters: album_title, label, genre_id, format_id, artist_name, or artist_id', 400);
  }
  // '' satisfies the NOT NULL constraint but is never a valid title — reject
  // before it lands in the catalog (PR #1154 review issue 8).
  if (typeof body.album_title !== 'string' || body.album_title.trim() === '') {
    throw new WxycError('album_title must be a non-empty string', 400);
  }

  let artist_id = body.artist_id;
  if (artist_id === undefined && body.artist_name !== undefined) {
    artist_id = await libraryService.artistIdFromName(body.artist_name, body.genre_id);
  }
  if (!artist_id) {
    throw new WxycError(
      "Artist doesn't exist or hasn't released an album in this genre before. Add a new artist entry to the library",
      400
    );
  }

  // Denormalize the canonical artist_name onto library (Epic A.3). We always
  // re-fetch from `artists` rather than trusting body.artist_name so the
  // library row stays consistent with the FK target even when the client
  // sent a casing variant. Renames cascade via the trigger added in 0060.
  const canonical_artist_name = await libraryService.getArtistNameById(artist_id);

  // Resolve label string to label_id via upsert
  let label_id = body.label_id;
  if (label_id === undefined && body.label) {
    const resolvedLabel = await labelsService.createLabel(body.label);
    label_id = resolvedLabel.id;
  }

  const new_album: NewAlbum = {
    artist_id: artist_id,
    artist_name: canonical_artist_name,
    genre_id: body.genre_id,
    format_id: body.format_id,
    album_title: body.album_title,
    label: body.label,
    label_id: label_id,
    code_number: await libraryService.generateAlbumCodeNumber(artist_id),
    alternate_artist_name: body.alternate_artist_name,
    disc_quantity: body.disc_quantity,
  };

  let inserted_album: Album = await libraryService.insertAlbum(new_album);

  // Enrich with LML metadata (streaming + artwork) -- don't fail the insert
  if (isLmlConfigured()) {
    const artistName = body.alternate_artist_name || body.artist_name || '';
    const [streamingResult, artworkResult] = await Promise.allSettled([
      checkStreamingAvailability(artistName, body.album_title),
      lmlLookupCoordinator.lookup(artistName, body.album_title, undefined, {
        budgetMs: LIBRARY_LML_BUDGET_MS,
        caller: 'library-add-album',
        warm_cache: true,
        requireSearchType: 'direct',
      }),
    ]);

    if (streamingResult.status === 'fulfilled' && streamingResult.value.on_streaming !== null) {
      try {
        inserted_album = await libraryService.updateOnStreaming(inserted_album.id, streamingResult.value.on_streaming);
      } catch (e) {
        console.warn('Failed to persist streaming status:', (e as Error).message);
      }
    } else if (streamingResult.status === 'rejected') {
      console.warn('Streaming check failed for new album:', streamingResult.reason);
    }

    if (artworkResult.status === 'rejected') {
      console.warn('Artwork fetch failed for new album:', artworkResult.reason);
    } else if (artworkResult.value !== null) {
      const artworkUrl = filterSpacerGif(artworkResult.value.results?.[0]?.artwork?.artwork_url);
      if (artworkUrl) {
        try {
          await libraryService.updateArtworkUrl(inserted_album.id, artworkUrl);
          (inserted_album as Record<string, unknown>).artwork_url = artworkUrl;
        } catch (e) {
          console.warn('Failed to persist artwork URL:', (e as Error).message);
        }
      }
    }

    // Fire-and-forget canonical-entity resolution (Epic B.1.3). The library
    // insert succeeds immediately; the canonical_entity_id lands within
    // seconds. UI and downstream consumers tolerate the lag. We use the
    // canonical artist name resolved from the artists table, not the raw
    // request body, so casing/diacritic variants in client input don't
    // poison LML's match.
    fireAndForgetCanonicalEntity(inserted_album.id, canonical_artist_name, body.album_title);
  }

  res.status(201).json(inserted_album);
};

/**
 * Resolve the canonical entity for a freshly inserted library row via LML and
 * persist the linkage. Errors are swallowed (logged + reported to Sentry) so
 * lookup failures never propagate back into the addAlbum response — the row
 * is already persisted; the link is best-effort.
 */
function fireAndForgetCanonicalEntity(libraryId: number, artistName: string | null, albumTitle: string): void {
  if (!artistName) return;

  lmlLookupCoordinator
    .lookup(artistName, albumTitle, undefined, {
      budgetMs: LIBRARY_LML_BUDGET_MS,
      caller: 'library-canonical-entity',
      warm_cache: true,
      requireSearchType: 'direct',
    })
    .then(async (response) => {
      if (response === null) return;
      const linkage = libraryService.mapLookupToCanonicalEntity(response);
      if (!linkage) return;
      await libraryService.updateCanonicalEntity(libraryId, linkage.id, linkage.confidence);
    })
    .catch((err) => {
      console.warn('[Library] Canonical-entity resolution failed:', (err as Error).message);
    });
}

type AlbumQueryParams = {
  artist_name?: string;
  album_title?: string;
  code_letters?: string;
  code_artist_number?: string;
  code_number?: number;
  n?: number;
  page?: number;
  on_streaming?: string;
};

export const searchForAlbum: RequestHandler = async (req: Request<object, object, object, AlbumQueryParams>, res) => {
  const { query } = req;
  // `on_streaming` is sufficient on its own to scope the result set (used by
  // dj-site Classic's "Browse Exclusive Albums" view, which surfaces all
  // non-streaming releases without a text query). See #872.
  if (
    query.artist_name === undefined &&
    query.album_title === undefined &&
    query.on_streaming === undefined &&
    (query.code_letters === undefined || query.code_artist_number === undefined)
  ) {
    throw new WxycError(
      'Missing query parameter. Query must include: artist_name, album_title, on_streaming, or code_letters and code_artist_number',
      400
    );
  }

  if (query.code_letters !== undefined && query.code_artist_number !== undefined) {
    //quickly look up albums by that artist
    throw new WxycError('TODO: Library Code Lookup', 501);
  }

  const onStreaming = query.on_streaming === 'true' ? true : query.on_streaming === 'false' ? false : undefined;

  const response = await libraryService.fuzzySearchLibrary(query.artist_name, query.album_title, query.n, onStreaming);
  const enriched = await raceEnrichmentBudget(response, libraryService.enrichWithArtwork(response));
  res.status(200).json(enriched.map((row) => libraryService.serializeLibraryArtistViewEntry(row)));
};

/**
 * Cap how long an interactive search will wait on artwork enrichment. LML's
 * own per-call timeout is 5s — appropriate for non-interactive callers
 * (request line, single-album lookup) but unacceptable on the search hot path
 * where one cache-miss gates the entire response. If the budget elapses we
 * return the raw search rows; the in-flight LML lookups keep running and still
 * write artwork_url to the DB, so subsequent searches benefit.
 */
const SEARCH_ENRICHMENT_BUDGET_MS = Number(process.env.LIBRARY_SEARCH_ENRICHMENT_BUDGET_MS ?? 500);

async function raceEnrichmentBudget<T>(unenriched: T[], enrichment: Promise<T[]>): Promise<T[]> {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<T[]>((resolve) => {
    budgetTimer = setTimeout(() => resolve(unenriched), SEARCH_ENRICHMENT_BUDGET_MS);
  });
  // Swallow rejections from the enrichment promise so the budget path can win
  // without an unhandledRejection. enrichWithArtwork already collects per-row
  // failures internally; this guard covers the rare case it throws as a whole.
  enrichment.catch((err) => {
    console.warn('[Library] Search-time artwork enrichment failed:', err);
  });
  try {
    return await Promise.race([enrichment, budget]);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

type NewArtistRequest = {
  artist_name: string;
  alphabetical_name?: string;
  code_letters: string;
  genre_id: number;
  code_number: number;
};

export const addArtist: RequestHandler = async (req: Request<object, object, NewArtistRequest>, res) => {
  const { body } = req;
  if (
    body.artist_name === undefined ||
    body.code_letters === undefined ||
    body.genre_id === undefined ||
    body.code_number === undefined
  ) {
    throw new WxycError('Missing Request Parameters: artist_name, code_letters, genre_id, or code_number', 400);
  }

  const existingArtist = await libraryService.getArtistByCode(body.code_letters, body.genre_id, body.code_number);
  if (existingArtist) {
    res.status(409).json({
      message: 'Artist code already exists for that genre and code letters.',
      artist: existingArtist,
    });
    return;
  }

  const new_artist: NewArtist = {
    artist_name: body.artist_name,
    alphabetical_name: body.alphabetical_name ?? body.artist_name,
    code_letters: body.code_letters,
  };

  const response: Artist = await libraryService.insertArtist(new_artist);
  await libraryService.insertArtistGenreCrossreference(response.id, body.genre_id, body.code_number);
  res.status(201).json({
    ...libraryService.serializeArtist(response),
    code_number: body.code_number,
    genre_id: body.genre_id,
  });
};

type SearchArtistsInGenreQuery = {
  genre_id?: string;
  q?: string;
  limit?: string;
};

export const searchArtistsInGenre: RequestHandler = async (
  req: Request<object, object, object, SearchArtistsInGenreQuery>,
  res
) => {
  const genreId = Number(req.query.genre_id);
  if (!Number.isInteger(genreId) || genreId < 1) {
    throw new WxycError('Invalid genre_id: must be a positive integer', 400);
  }

  // Express's `simple` query parser yields string[] for repeated keys
  // (`?q=Bu&q=lt`); reject anything that isn't a single string before .trim().
  if (req.query.q !== undefined && typeof req.query.q !== 'string') {
    throw new WxycError('Invalid q: must be a single string value', 400);
  }
  const q = (req.query.q ?? '').trim();
  if (q.length < 2) {
    throw new WxycError('Missing or invalid q: must be at least 2 characters', 400);
  }

  const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : 10;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 10;

  // Distinguish a stale/unknown genre_id from a genre with no matching
  // artists — silent `{ artists: [] }` hides stale dropdown IDs from clients.
  if (!(await libraryService.genreExists(genreId))) {
    throw new WxycError('Genre not found', 404);
  }

  const artists = await libraryService.searchArtistsInGenre(genreId, q, limit);
  res.status(200).json({ artists });
};

type ArtistNumberPeekQuery = {
  code_letters?: string;
  genre_id?: string;
};

export const peekArtistNumber: RequestHandler = async (
  req: Request<object, object, object, ArtistNumberPeekQuery>,
  res
) => {
  const { query } = req;
  if (!query.code_letters || !query.genre_id) {
    throw new WxycError('Missing query parameters: code_letters and genre_id', 400);
  }

  const genreId = Number(query.genre_id);
  if (!Number.isFinite(genreId)) {
    throw new WxycError('Invalid genre_id', 400);
  }

  const nextCode = await libraryService.generateArtistNumber(query.code_letters, genreId);
  res.status(200).json({ next_code_number: nextCode });
};

export const getRotation: RequestHandler = async (req, res) => {
  const rotation = await libraryService.getRotationFromDB();
  res.status(200).json(rotation);
};

export type RotationAddRequest = Omit<NewRotationRelease, 'id'>;

/**
 * Pick only the fields the client is allowed to write through the public
 * `POST /library/rotation` endpoint (BS#1380). Mirrors
 * `pickUpdateEntryFields()` in flowsheet.controller.ts (BS#1099).
 *
 * Server-derived columns (`legacy_rotation_id`, `legacy_library_release_id`,
 * `discogs_release_id`, `discogs_release_id_source`, `lml_identity_id`,
 * `tracklist_lookup_attempted_at`, `kill_date`) and tubafrenzy-ETL-only
 * snapshot columns (`add_date`, `artist_name`, `album_title`,
 * `record_label`) must never be client-supplied through this endpoint —
 * `addToRotation` derives the LML-handle columns from `library_identity`
 * and the synchronous `resolveIdentity` hop, and tubafrenzy is the only
 * legitimate source for the snapshot columns.
 *
 * Phrased as an allowlist (signature-typed accept list) so a future column
 * addition to `rotation` is implicitly rejected by typecheck until
 * explicitly added to the signature. Matches dj-site's `RotationParams`
 * (`{ album_id, rotation_bin }`); widen the signature here when a future
 * caller legitimately needs another field.
 */
type AddRotationAllowlist = Pick<NewRotationRelease, 'album_id' | 'rotation_bin'>;

export function pickAddRotationFields(body: Partial<NewRotationRelease>): AddRotationAllowlist {
  const picked = {} as AddRotationAllowlist;
  if (body.album_id !== undefined) picked.album_id = body.album_id;
  if (body.rotation_bin !== undefined) picked.rotation_bin = body.rotation_bin;
  return picked;
}

export const addRotation: RequestHandler<object, unknown, NewRotationRelease> = async (req, res) => {
  if (req.body.album_id === undefined || req.body.rotation_bin === undefined) {
    throw new WxycError('Missing Parameters: album_id or rotation_bin', 400);
  }

  const picked = pickAddRotationFields(req.body);
  const rotationRelease: RotationRelease = await libraryService.addToRotation(picked);
  res.status(201).json(rotationRelease);
};

export type KillRotationRelease = {
  rotation_id: number;
  kill_date?: string; //Accepts ISO8601 formatted dates YYYY-MM-DD
};

export const killRotation: RequestHandler<object, unknown, KillRotationRelease> = async (req, res) => {
  const { body } = req;

  if (body.rotation_id === undefined) {
    throw new WxycError('Bad Request, Missing Parameter: rotation_id', 400);
  }
  if (body.kill_date !== undefined && !libraryService.isISODate(body.kill_date)) {
    throw new WxycError('Bad Request, Incorrect Date Format: kill_date should be of form YYYY-MM-DD', 400);
  }

  const updatedRotation: RotationRelease = await libraryService.killRotationInDB(body.rotation_id, body.kill_date);
  if (updatedRotation !== undefined) {
    res.status(200).json(updatedRotation);
  } else {
    throw new WxycError('Rotation entry not found', 400);
  }
};

// Wire shape `RotationTrack` lives in `library.service.ts` so the service
// can project the LML extended-mode tracklist inline (BS#1185 + LML#427)
// without crossing the controller → service direction; re-exported here so
// consumers that import the type alongside the handler stay unbroken.
//
// Distinct from the `/proxy/library/:libraryId/tracks` shape
// (`{position, title, artist_credit, duration_ms}`) consumed by the
// catalog-search picker (BS#836 / dj-site#501). Same upstream data, two
// pickers with two pre-existing wire contracts.
import type { RotationTrack } from '../services/library.service.js';
export type { RotationTrack };

/**
 * GET /library/rotation/:rotation_id/tracks (BS#940)
 *
 * Composition for the dj-site rotation entry mode track picker.
 *   1. Resolve the picker source via `resolveRotationPickerSource`, which
 *      walks three tiers: `rotation.discogs_release_id` (mirrored from
 *      tubafrenzy by jobs/rotation-etl, migration 0077),
 *      `library_identity.discogs_release_id` via the `rotation.album_id`
 *      bridge, and an LML `POST /api/v1/lookup` (with `extended=true`)
 *      against the rotation row's `(artist_name, album_title)`. Tier-3
 *      results are cached per `rotation_id` in the service layer.
 *   2. If the source carries an `inlineTracklist`, return it directly. LML
 *      already projected the tracks (Discogs hit OR MusicBrainz rescue on
 *      LML#427) — no follow-up `getRelease(id)` round-trip.
 *   3. Otherwise fetch the tracklist from LML's
 *      `GET /api/v1/discogs/release/{id}` and project per-track artists
 *      onto the dj-site shape, falling back to the release-level artist
 *      when a track has no per-track credits.
 *
 * Degrades gracefully: returns 200 + `[]` when the rotation row doesn't
 * exist, when all three resolution tiers miss, and when LML 404s the
 * release. Only LML 5xx bubbles up so transient upstream failures surface
 * rather than silently hiding the dropdown.
 *
 * No controller-side cache on the `/release/{id}` fetch — LML's 3-tier
 * cache already deduplicates by release id. The tier-3 lookup is cached at
 * the service layer (keyed by `rotation_id`).
 */
export const getRotationTracks: RequestHandler<{ rotation_id: string }> = async (req, res) => {
  const rotationId = parseInt(req.params.rotation_id, 10);
  if (!Number.isInteger(rotationId) || rotationId <= 0) {
    throw new WxycError('rotation_id must be a positive integer', 400);
  }

  const source = await libraryService.resolveRotationPickerSource(rotationId);
  if (source === null) {
    res.status(200).json([]);
    return;
  }

  if (source.inlineTracklist !== null) {
    res.status(200).json(source.inlineTracklist);
    return;
  }

  // The service contract guarantees `releaseId !== null` when
  // `inlineTracklist === null`, but TypeScript can't narrow that without
  // a discriminated union — guard explicitly so the cache shape stays
  // simple.
  if (source.releaseId === null) {
    res.status(200).json([]);
    return;
  }

  const tracks = await libraryService.getRotationTracksFromRelease(source.releaseId);
  res.status(200).json(tracks ?? []);
};

export const getFormats: RequestHandler = async (req, res) => {
  const formats = await libraryService.getFormatsFromDB();
  res.status(200).json(formats);
};

export const addFormat: RequestHandler = async (req, res) => {
  const { body } = req;
  if (body.name === undefined) {
    throw new WxycError('Bad Request, Missing Parameter: name', 400);
  }

  const newFormat: NewAlbumFormat = {
    format_name: body.name,
  };

  const insertion = await libraryService.insertFormat(newFormat);
  res.status(201).json(insertion);
};

export const getGenres: RequestHandler = async (req, res) => {
  const genres = await libraryService.getGenresFromDB();
  res.status(200).json(genres);
};

export const addGenre: RequestHandler = async (req, res) => {
  const { body } = req;
  if (body.name === undefined || body.description === undefined) {
    throw new WxycError('Bad Request, Parameters name and description are required.', 400);
  }

  const newGenre: NewGenre = {
    genre_name: body.name,
    description: body.description,
    plays: 0,
    add_date: new Date().toISOString(),
    last_modified: new Date(),
  };

  const insertion = await libraryService.insertGenre(newGenre);

  res.status(201).json(insertion);
};

export const getAlbum: RequestHandler<object, unknown, unknown, { album_id: string }> = async (req, res) => {
  const { query } = req;
  if (query.album_id === undefined) {
    throw new WxycError('Bad Request, missing album identifier: album_id', 400);
  }

  const album = await libraryService.getAlbumFromDB(parseInt(query.album_id));
  res.status(200).json(album);
};

const parseAlbumId = (rawId: string): number => {
  const albumId = Number(rawId);
  if (!Number.isInteger(albumId) || albumId <= 0) {
    throw new WxycError('Invalid album ID', 400);
  }
  return albumId;
};

type UpdateAlbumRequest = {
  album_title?: string;
  label?: string;
  label_id?: number | null;
  genre_id?: number;
  format_id?: number;
  artist_id?: number;
  alternate_artist_name?: string | null;
  disc_quantity?: number;
  // BS#1281 (Not-on-Discogs 1a): the music director's write surface for
  // suppressing false LML fuzzy matches. camelCase per the issue spec; the DB
  // columns are `discogs_unavailable` / `discogs_unavailable_note`.
  // `last_discogs_recheck_at` is deliberately absent — it is server-write-only
  // (the recheck cron writes it directly), so any client-supplied value is
  // silently dropped rather than read here.
  discogsUnavailable?: boolean;
  discogsUnavailableNote?: string | null;
};

const MAX_DISCOGS_UNAVAILABLE_NOTE_LENGTH = 500;

const UPDATABLE_ALBUM_FIELDS = [
  'album_title',
  'label',
  'label_id',
  'genre_id',
  'format_id',
  'artist_id',
  'alternate_artist_name',
  'disc_quantity',
  'discogsUnavailable',
  'discogsUnavailableNote',
] as const;

// `album_title`, `alternate_artist_name`, and `label` are all `varchar(128)`
// in the library schema. Reject over-length input as a 400 rather than letting
// it reach the UPDATE and trip PG 22001 ("value too long") → 500 (#1551).
const MAX_ALBUM_TEXT_LENGTH = 128;

/**
 * PATCH /library/:id with true partial semantics (PR #1154 review issues
 * 5–8, 10–13): only fields present in the body are validated and written, so
 * a title-typo fix can't reset disc_quantity, wipe alternate_artist_name, or
 * NULL a long-stable label_id.
 */
export const updateAlbum: RequestHandler<{ id: string }, unknown, UpdateAlbumRequest> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);
  const { body } = req;

  if (!UPDATABLE_ALBUM_FIELDS.some((field) => field in body)) {
    throw new WxycError(`Bad Request: provide at least one of ${UPDATABLE_ALBUM_FIELDS.join(', ')}`, 400);
  }

  // Resolve the album before any side effects — the old order ran the label
  // upsert first, leaving orphan labels rows on the 404 path (issue 10).
  const existing = await libraryService.getLibraryRowById(albumId);
  if (!existing) {
    throw new WxycError('Album not found', 404);
  }

  const updates: libraryService.UpdateAlbumRow = {};

  if (body.album_title !== undefined) {
    if (typeof body.album_title !== 'string' || body.album_title.trim() === '') {
      throw new WxycError('album_title must be a non-empty string', 400);
    }
    const trimmedTitle = body.album_title.trim();
    if (trimmedTitle.length > MAX_ALBUM_TEXT_LENGTH) {
      throw new WxycError(`album_title must be ${MAX_ALBUM_TEXT_LENGTH} characters or fewer`, 400);
    }
    updates.album_title = trimmedTitle;
  }

  if ('alternate_artist_name' in body) {
    if (body.alternate_artist_name !== null && typeof body.alternate_artist_name !== 'string') {
      throw new WxycError('alternate_artist_name must be a string or null', 400);
    }
    const trimmedAlternate = body.alternate_artist_name?.trim() || null;
    if (trimmedAlternate !== null && trimmedAlternate.length > MAX_ALBUM_TEXT_LENGTH) {
      throw new WxycError(`alternate_artist_name must be ${MAX_ALBUM_TEXT_LENGTH} characters or fewer`, 400);
    }
    updates.alternate_artist_name = trimmedAlternate;
  }

  if (body.disc_quantity !== undefined) {
    if (!Number.isInteger(body.disc_quantity) || body.disc_quantity < 1 || body.disc_quantity > 99) {
      throw new WxycError('disc_quantity must be an integer between 1 and 99', 400);
    }
    updates.disc_quantity = body.disc_quantity;
  }

  if (body.format_id !== undefined) {
    if (!Number.isInteger(body.format_id) || body.format_id < 1) {
      throw new WxycError('format_id must be a positive integer', 400);
    }
    // Validate against the format table so a stale/guessed id surfaces as 400
    // instead of a PG 23503 → 500 (mirrors the label_id guard). This runs
    // before the label upsert below, so a bad format_id can't strand an orphan
    // labels row on the failure path (#1550).
    const formatRow = await libraryService.getFormatById(body.format_id);
    if (!formatRow) {
      throw new WxycError('format_id does not reference an existing format', 400);
    }
    updates.format_id = body.format_id;
  }

  // Validate the *effective* (artist, genre) pair so a genre-only move still
  // checks the current artist is catalogued there, and vice versa.
  if (body.artist_id !== undefined || body.genre_id !== undefined) {
    if (body.artist_id !== undefined && (!Number.isInteger(body.artist_id) || body.artist_id < 1)) {
      throw new WxycError('artist_id must be a positive integer', 400);
    }
    if (body.genre_id !== undefined && (!Number.isInteger(body.genre_id) || body.genre_id < 1)) {
      throw new WxycError('genre_id must be a positive integer', 400);
    }
    const effectiveArtistId = body.artist_id ?? existing.artist_id;
    const effectiveGenreId = body.genre_id ?? existing.genre_id;

    const canonical_artist_name = await libraryService.getArtistNameById(effectiveArtistId);
    if (!canonical_artist_name) {
      throw new WxycError('Artist not found', 404);
    }

    const inGenre = await libraryService.artistExistsInGenre(effectiveArtistId, effectiveGenreId);
    if (!inGenre) {
      throw new WxycError('Artist is not catalogued in the selected genre', 400);
    }

    if (body.genre_id !== undefined) updates.genre_id = body.genre_id;
    if (body.artist_id !== undefined && body.artist_id !== existing.artist_id) {
      updates.artist_id = body.artist_id;
      updates.artist_name = canonical_artist_name;
      // Re-attribution keeps the album's code_number unless the new artist
      // already owns it (issue 7) — only on collision do we burn the next
      // number in the new artist's sequence.
      if (await libraryService.albumCodeNumberTaken(body.artist_id, existing.code_number, albumId)) {
        updates.code_number = await libraryService.generateAlbumCodeNumber(body.artist_id);
      }
    }
  }

  const labelProvided = body.label !== undefined;
  const labelIdProvided = 'label_id' in body;
  if (labelProvided || labelIdProvided) {
    if (labelProvided && typeof body.label !== 'string') {
      throw new WxycError('label must be a string', 400);
    }
    const trimmedLabel = labelProvided ? (body.label as string).trim() : undefined;
    if (labelProvided && trimmedLabel === '') {
      // '' slid past the old `=== undefined` guard and silently NULLed a
      // long-stable label_id (issue 6). Clearing must be explicit.
      throw new WxycError('label must be a non-empty string; clear the label by sending label_id: null', 400);
    }
    if (trimmedLabel !== undefined && trimmedLabel.length > MAX_ALBUM_TEXT_LENGTH) {
      throw new WxycError(`label must be ${MAX_ALBUM_TEXT_LENGTH} characters or fewer`, 400);
    }

    if (labelIdProvided && body.label_id === null) {
      if (trimmedLabel) {
        throw new WxycError('label_id: null cannot be combined with a non-empty label', 400);
      }
      updates.label_id = null;
      updates.label = null;
    } else if (labelIdProvided) {
      if (!Number.isInteger(body.label_id) || (body.label_id as number) < 1) {
        throw new WxycError('label_id must be a positive integer or null', 400);
      }
      // Validate against the labels table so a stale/guessed id surfaces as
      // 400 instead of a PG 23503 → 500.
      const labelRow = await labelsService.getLabelById(body.label_id as number);
      if (!labelRow) {
        throw new WxycError('label_id does not reference an existing label', 400);
      }
      updates.label_id = labelRow.id;
      updates.label = trimmedLabel ?? labelRow.label_name;
    } else if (trimmedLabel) {
      // Trim before the upsert: `createLabel('  Drag City  ')` would insert a
      // padded labels row that future trimmed submissions miss (issue 11).
      const resolvedLabel = await labelsService.createLabel(trimmedLabel);
      updates.label_id = resolvedLabel.id;
      updates.label = trimmedLabel;
    }
  }

  // --- discogs_unavailable block (BS#1281 / Not-on-Discogs 1a) ------------
  // Runs before the no-op short-circuit below so a discogs-only PATCH lands in
  // `updates` and is seen by the effectiveChange check. Enforces the
  // `note alive ⟺ flag alive` invariant the DB CHECK
  // (`discogs_unavailable OR discogs_unavailable_note IS NULL`) also guards.
  const hasUnavailableFlag = 'discogsUnavailable' in body;
  const hasUnavailableNote = 'discogsUnavailableNote' in body;
  if (hasUnavailableFlag || hasUnavailableNote) {
    if (hasUnavailableFlag && typeof body.discogsUnavailable !== 'boolean') {
      throw new WxycError('discogsUnavailable must be a boolean', 400);
    }

    let note: string | null | undefined;
    if (hasUnavailableNote) {
      if (body.discogsUnavailableNote !== null && typeof body.discogsUnavailableNote !== 'string') {
        throw new WxycError('discogsUnavailableNote must be a string or null', 400);
      }
      note = body.discogsUnavailableNote === null ? null : body.discogsUnavailableNote.trim() || null;
      if (note !== null && note.length > MAX_DISCOGS_UNAVAILABLE_NOTE_LENGTH) {
        throw new WxycError(
          `discogsUnavailableNote must be at most ${MAX_DISCOGS_UNAVAILABLE_NOTE_LENGTH} characters`,
          400
        );
      }
    }

    // Effective flag: the incoming value if the body sets it, else the row's
    // current value (so a note-only PATCH is judged against the live flag).
    const effectiveFlag = hasUnavailableFlag ? (body.discogsUnavailable as boolean) : existing.discogs_unavailable;
    if (hasUnavailableFlag) {
      updates.discogs_unavailable = body.discogsUnavailable as boolean;
    }

    if (!effectiveFlag) {
      // No flag ⟹ no note. A non-null note here contradicts the invariant;
      // reject rather than let the DB CHECK surface it as a 500.
      if (note != null) {
        throw new WxycError('discogsUnavailableNote requires discogsUnavailable: true', 400);
      }
      // Clearing the flag (or a note-null PATCH on an already-unflagged row)
      // clears any lingering note, even when the body omits it.
      updates.discogs_unavailable_note = null;
    } else if (hasUnavailableNote) {
      updates.discogs_unavailable_note = note ?? null;
    }
  }
  // --- end discogs_unavailable block --------------------------------------

  // Short-circuit a no-op edit: updateAlbumInDB always SETs last_modified =
  // NOW(), which fires the touch_library_watermark trigger and advances the
  // catalog conditional-GET watermark — forcing every iOS / dj-site poller to
  // re-download the full catalog for a write that changed nothing (#1555). A
  // PATCH resolves to no-op when every computed update already equals the
  // stored value (e.g. `{artist_id: <same>}`, or a dj-site "Save" that
  // resubmits the unchanged record). Compare against the already-fetched row
  // and return it unchanged rather than running the UPDATE.
  const effectiveChange = (Object.keys(updates) as Array<keyof libraryService.UpdateAlbumRow>).some(
    (key) => updates[key] !== existing[key as keyof typeof existing]
  );
  if (!effectiveChange) {
    const album = await libraryService.getAlbumFromDB(albumId);
    res.status(200).json(album);
    return;
  }

  // Identity-affecting edits re-fire the same LML pipeline addAlbum runs (issue
  // 12), so on_streaming / artwork_url / canonical_entity can be rebound to the
  // NEW (artist, title) identity. We do NOT null those columns up front:
  // enrichAlbumAfterIdentityChange overwrites each one only on a successful
  // lookup (refill-then-swap), so an unconfigured LML or a no-match re-lookup
  // leaves the prior — still-better-than-blank — enrichment intact rather than
  // permanently wiping it with no repair path (BS#1549).
  const identityChanged =
    (updates.artist_id !== undefined && updates.artist_id !== existing.artist_id) ||
    (updates.album_title !== undefined && updates.album_title !== existing.album_title) ||
    ('alternate_artist_name' in body &&
      (updates.alternate_artist_name ?? null) !== (existing.alternate_artist_name ?? null));

  const updated = await libraryService.updateAlbumInDB(albumId, updates);
  if (!updated) {
    throw new WxycError('Album not found', 404);
  }

  if (identityChanged && isLmlConfigured()) {
    const canonicalArtistName =
      updates.artist_name ?? existing.artist_name ?? (await libraryService.getArtistNameById(existing.artist_id));
    const effectiveAlternate =
      'alternate_artist_name' in body ? updates.alternate_artist_name : existing.alternate_artist_name;
    const effectiveTitle = updates.album_title ?? existing.album_title;
    await enrichAlbumAfterIdentityChange(
      albumId,
      effectiveAlternate || canonicalArtistName || '',
      effectiveTitle,
      canonicalArtistName
    );
  }

  const album = await libraryService.getAlbumFromDB(albumId);
  res.status(200).json(album);
};

/**
 * Mirror of the addAlbum LML enrichment block (streaming + artwork +
 * canonical entity), fired when a PATCH changes the album's identity. The
 * row is already updated; every branch here is best-effort.
 */
async function enrichAlbumAfterIdentityChange(
  albumId: number,
  displayArtistName: string,
  albumTitle: string,
  canonicalArtistName: string | null
): Promise<void> {
  if (!displayArtistName) return;

  const [streamingResult, artworkResult] = await Promise.allSettled([
    checkStreamingAvailability(displayArtistName, albumTitle),
    lmlLookupCoordinator.lookup(displayArtistName, albumTitle, undefined, {
      budgetMs: LIBRARY_LML_BUDGET_MS,
      caller: 'library-update-album',
      warm_cache: true,
      requireSearchType: 'direct',
    }),
  ]);

  if (streamingResult.status === 'fulfilled' && streamingResult.value.on_streaming !== null) {
    try {
      await libraryService.updateOnStreaming(albumId, streamingResult.value.on_streaming);
    } catch (e) {
      console.warn('Failed to persist streaming status after album update:', (e as Error).message);
    }
  } else if (streamingResult.status === 'rejected') {
    console.warn('Streaming check failed for updated album:', streamingResult.reason);
  }

  if (artworkResult.status === 'rejected') {
    console.warn('Artwork fetch failed for updated album:', artworkResult.reason);
  } else if (artworkResult.value !== null) {
    const artworkUrl = filterSpacerGif(artworkResult.value.results?.[0]?.artwork?.artwork_url);
    if (artworkUrl) {
      try {
        await libraryService.updateArtworkUrl(albumId, artworkUrl);
      } catch (e) {
        console.warn('Failed to persist artwork URL after album update:', (e as Error).message);
      }
    }
  }

  fireAndForgetCanonicalEntity(albumId, canonicalArtistName, albumTitle);
}

export const markMissing: RequestHandler<{ id: string }> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);

  const result = await libraryService.markAlbumMissing(albumId);
  if (!result) throw new WxycError('Album not found', 404);

  const album = await libraryService.getAlbumFromDB(albumId);
  res.status(200).json(album);
};

export const markFound: RequestHandler<{ id: string }> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);

  const result = await libraryService.markAlbumFound(albumId);
  if (!result) throw new WxycError('Album not found', 404);

  const album = await libraryService.getAlbumFromDB(albumId);
  res.status(200).json(album);
};

// ---------------------------------------------------------------------------
// GET /library/query — query-builder search over the catalog
// ---------------------------------------------------------------------------

type LibraryQueryParams = {
  q?: string;
  page?: string;
  limit?: string;
  sort?: string;
  order?: string;
  on_streaming?: string;
  missing?: string;
  genre?: string;
  genres?: string;
  format?: string;
  formats?: string;
  rotation_bins?: string;
};

const VALID_CATALOG_SORTS: CatalogSort[] = ['artist', 'album', 'plays', 'date'];
const VALID_CATALOG_ORDERS: CatalogOrder[] = ['asc', 'desc'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const searchLibraryQueryEndpoint: RequestHandler<object, unknown, unknown, LibraryQueryParams> = async (
  req,
  res
) => {
  if (req.query.q !== undefined && typeof req.query.q !== 'string') {
    throw new WxycError('q must be a single string value', 400);
  }
  const q = req.query.q ?? '';

  // Express's `simple` query parser yields a string[] for a repeated key, and
  // parseInt(['1','2']) stringifies to '1,2' → 1, silently coercing instead of
  // erroring. Reject repeated page/limit keys the same way `q` is rejected
  // above, so a malformed request fails loudly rather than paginating wrong
  // (#1553).
  if (req.query.page !== undefined && typeof req.query.page !== 'string') {
    throw new WxycError('page must be a single string value', 400);
  }
  const page = parseInt(req.query.page ?? '0');
  if (isNaN(page) || page < 0) {
    throw new WxycError('page must be a non-negative integer', 400);
  }

  if (req.query.limit !== undefined && typeof req.query.limit !== 'string') {
    throw new WxycError('limit must be a single string value', 400);
  }
  const limit = parseInt(req.query.limit ?? String(DEFAULT_LIMIT));
  if (isNaN(limit) || limit < 1) {
    throw new WxycError('limit must be a positive integer', 400);
  }
  if (limit > MAX_LIMIT) {
    throw new WxycError(`limit must not exceed ${MAX_LIMIT}`, 400);
  }

  let sort: CatalogSort = 'album';
  if (req.query.sort !== undefined) {
    if (!VALID_CATALOG_SORTS.includes(req.query.sort as CatalogSort)) {
      throw new WxycError(`sort must be one of: ${VALID_CATALOG_SORTS.join(', ')}`, 400);
    }
    sort = req.query.sort as CatalogSort;
  }

  let order: CatalogOrder = 'asc';
  if (req.query.order !== undefined) {
    if (!VALID_CATALOG_ORDERS.includes(req.query.order as CatalogOrder)) {
      throw new WxycError(`order must be one of: ${VALID_CATALOG_ORDERS.join(', ')}`, 400);
    }
    order = req.query.order as CatalogOrder;
  }

  const onStreamingRaw = req.query.on_streaming;
  let on_streaming: boolean | undefined;
  if (onStreamingRaw !== undefined) {
    if (onStreamingRaw === 'true') on_streaming = true;
    else if (onStreamingRaw === 'false') on_streaming = false;
    else {
      throw new WxycError('on_streaming must be "true" or "false"', 400);
    }
  }

  const missingRaw = req.query.missing;
  let missing: boolean | undefined;
  if (missingRaw !== undefined) {
    if (missingRaw === 'true') missing = true;
    else if (missingRaw === 'false') missing = false;
    else {
      throw new WxycError('missing must be "true" or "false"', 400);
    }
  }

  const genres = librarySearchService.parseEnumQueryList(req.query.genres, req.query.genre);
  const formats = librarySearchService.parseEnumQueryList(req.query.formats, req.query.format);
  const rotation_bins = librarySearchService.parseRotationBinsQueryList(req.query.rotation_bins);

  const { results, total } = await librarySearchService.searchLibrary({
    q,
    page,
    limit,
    sort,
    order,
    on_streaming,
    missing,
    genres,
    formats,
    rotation_bins,
  });
  const totalPages = Math.ceil(total / limit);
  res.status(200).json({ results, total, page, totalPages });
};

// ---------------------------------------------------------------------------
// GET /library/catalog — full catalog bulk export (BS#1468 / Epic F, #1466)
// ---------------------------------------------------------------------------

/**
 * Stream the entire catalog as one gzipped NDJSON body so the iOS app can clone
 * it for on-device Spotlight indexing. Freshness is handled upstream by the
 * `conditionalGet(getCatalogLastModifiedAt)` middleware (which sets
 * `Last-Modified` and short-circuits to `304` on `If-Modified-Since` / `?since=`
 * when the `library_watermark` hasn't advanced); by the time this handler runs
 * the catalog has changed and a full `200` is owed.
 *
 * The payload is pre-gzipped and cached per watermark (one shared copy per pod),
 * so this is a memcpy on the hot path. There is no `compression` middleware in
 * the app, so we set `Content-Encoding` ourselves and honor the request's
 * `Accept-Encoding`: gzip-capable clients (iOS `URLSession` inflates
 * transparently) get the cached bytes as-is with a correct `Content-Length`; the
 * rare client that doesn't accept gzip gets a one-off inflate.
 */
export const exportCatalog: RequestHandler = async (req, res) => {
  const gzipped = await catalogExportService.getCatalogExportGzip();
  // Use Express's content-negotiation (the `accepts` library) rather than a
  // substring match: it honors q-values, so `gzip;q=0` (an explicit refusal)
  // correctly returns false, and `Accept-Encoding: *` correctly returns gzip —
  // both of which `String.includes('gzip')` gets wrong.
  const acceptsGzip = req.acceptsEncodings('gzip') === 'gzip';

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');

  if (acceptsGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', gzipped.length);
    res.status(200).end(gzipped);
    return;
  }

  const inflated = gunzipSync(gzipped);
  res.setHeader('Content-Length', inflated.length);
  res.status(200).end(inflated);
};

// ---------------------------------------------------------------------------
// GET /library/bmi-performance-list — played-works export for BMI (BS#1500)
// ---------------------------------------------------------------------------

/**
 * Successor to tubafrenzy's `recentBMI` servlet: the played-works list the
 * station librarian submits to BMI for royalty reporting. Gated to MD/SM via
 * `catalog:['write']` (the route), keyed on a real `from`/`to` date range
 * (deliberately not `recentBMI`'s stateless "recent 1000"), and returns
 * structured JSON — the rows plus a composer-provenance coverage summary the
 * dj-site admin tool previews before the librarian submits.
 *
 * The exact BMI submission *format* and the artist-proxy inclusion default are
 * deferred to #1507; the range/filter/coverage contract here does not depend on
 * either and the dj-site shell reads this JSON directly. A malformed range
 * throws `WxycError(400)`, which the async handler forwards to `errorHandler`.
 */
export const exportBmiPerformanceList: RequestHandler = async (req, res) => {
  const range = bmiPerformanceService.parseBmiDateRange(req.query.from, req.query.to);
  const payload = await bmiPerformanceService.getBmiPerformanceList(range);
  res.status(200).json(payload);
};
