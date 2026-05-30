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
import * as libraryService from '../services/library.service.js';
import * as labelsService from '../services/labels.service.js';
import * as librarySearchService from '../services/library-search.service.js';
import type { CatalogSort, CatalogOrder } from '../services/library-search.service.js';
import { checkStreamingAvailability, lookupMetadata, isLmlConfigured, envInt } from '@wxyc/lml-client';
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
      lookupMetadata(artistName, body.album_title, undefined, { budgetMs: LIBRARY_LML_BUDGET_MS }),
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

    if (artworkResult.status === 'fulfilled') {
      const artworkUrl = filterSpacerGif(artworkResult.value.results?.[0]?.artwork?.artwork_url);
      if (artworkUrl) {
        try {
          await libraryService.updateArtworkUrl(inserted_album.id, artworkUrl);
          (inserted_album as Record<string, unknown>).artwork_url = artworkUrl;
        } catch (e) {
          console.warn('Failed to persist artwork URL:', (e as Error).message);
        }
      }
    } else {
      console.warn('Artwork fetch failed for new album:', artworkResult.reason);
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

  lookupMetadata(artistName, albumTitle, undefined, { budgetMs: LIBRARY_LML_BUDGET_MS })
    .then(async (response) => {
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
export const addRotation: RequestHandler<object, unknown, NewRotationRelease> = async (req, res) => {
  if (req.body.album_id === undefined || req.body.rotation_bin === undefined) {
    throw new WxycError('Missing Parameters: album_id or rotation_bin', 400);
  }

  const rotationRelease: RotationRelease = await libraryService.addToRotation(req.body);
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
  genre?: string;
  format?: string;
};

const VALID_CATALOG_SORTS: CatalogSort[] = ['artist', 'album', 'plays', 'date'];
const VALID_CATALOG_ORDERS: CatalogOrder[] = ['asc', 'desc'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const searchLibraryQueryEndpoint: RequestHandler<object, unknown, unknown, LibraryQueryParams> = async (
  req,
  res
) => {
  const q = req.query.q ?? '';

  const page = parseInt(req.query.page ?? '0');
  if (isNaN(page) || page < 0) {
    throw new WxycError('page must be a non-negative integer', 400);
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

  const genre = req.query.genre || undefined;
  const format = req.query.format || undefined;

  const { results, total } = await librarySearchService.searchLibrary({
    q,
    page,
    limit,
    sort,
    order,
    on_streaming,
    genre,
    format,
  });
  const totalPages = Math.ceil(total / limit);
  res.status(200).json({ results, total, page, totalPages });
};
