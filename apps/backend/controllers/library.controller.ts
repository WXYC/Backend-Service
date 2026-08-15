import { Request, RequestHandler } from 'express';
import * as Sentry from '@sentry/node';
import {
  Album,
  Artist,
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  NewRotationRelease,
  RotationRelease,
  parseRotationBin,
  ROTATION_BINS,
} from '@wxyc/database';
import { gunzipSync } from 'node:zlib';
import * as libraryService from '../services/library.service.js';
import * as catalogExportService from '../services/catalog-export.service.js';
import * as bmiPerformanceService from '../services/bmi-performance.service.js';
import * as labelsService from '../services/labels.service.js';
import * as librarySearchService from '../services/library-search.service.js';
import type { CatalogSort, CatalogOrder } from '../services/library-search.service.js';
import { checkStreamingAvailability, isLmlConfigured } from '@wxyc/lml-client';
import { lmlLookupCoordinator } from '../services/lml/index.js';
import { filterSpacerGif } from '../services/metadata/metadata.service.js';
import { getPostHogClient } from '../utils/posthog.js';
import WxycError from '../utils/error.js';

// `genres.id` and `genre_artist_crossreference.artist_genre_code` are Postgres
// int4 columns. A query value outside that range parses fine as a JS integer
// (passing `Number.isInteger`) but blows up downstream as an unhandled
// "value out of range for type integer" Postgres error — SQLSTATE 22003, which
// is not a `WxycError` and so answers a generic 500 plus a Sentry capture.
// Same constant and same guard as `flowsheet.controller.ts` (BS#1800), which
// hit this first on `start_id`/`end_id`.
const INT4_MAX = 2147483647;

// BS#1826 PR 2: `LIBRARY_LML_BUDGET_MS` retired. Budget for the add-album
// insert + fire-and-forget canonical-entity paths now comes from the
// per-caller policy layer (`@wxyc/lml-client` `policy.ts`) — `library-add-
// album`/`library-update-album` are class 2 (budget 4000ms/timeout 5000ms),
// `library-canonical-entity` is class 3 (timeout 8000ms, no budget header).
// See `docs/env-vars.md` for the retired-constant → class mapping.

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
      checkStreamingAvailability(artistName, body.album_title, { caller: 'library-add-album-streaming' }),
      // BS#1294 (1c): pre-read the just-inserted row's discogs_unavailable
      // flag. On the fresh-insert path this is always false (the row was
      // just created with the schema default — BS#1281 / plan §3), so the
      // gate is a no-op here. Wired for consistency with the other three
      // lookupMetadata callers, and for the day addAlbum gains a dedup/
      // upsert path that could re-touch an already-flagged row.
      lmlLookupCoordinator.lookup(artistName, body.album_title, undefined, {
        caller: 'library-add-album',
        warm_cache: true,
        requireSearchType: 'direct',
        discogsUnavailable: inserted_album.discogs_unavailable,
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

    // BS#1228 (LML#376 follow-up): capture which streaming services errored
    // out so a future retry-policy decision can be data-driven. Pure
    // observability — never persisted to `library.*`, independent of the
    // on_streaming verdict above (a service can error while others still
    // resolve a match). Each emit is its own try/catch so a PostHog outage
    // can't suppress the Sentry span projection or vice versa.
    if (streamingResult.status === 'fulfilled' && streamingResult.value.errored_sources?.length) {
      try {
        getPostHogClient().capture({
          distinctId: String(inserted_album.id),
          event: 'streaming_check_partial_error',
          properties: {
            album_id: inserted_album.id,
            artist: artistName,
            title: body.album_title,
            on_streaming_verdict: streamingResult.value.on_streaming,
            errored_sources: streamingResult.value.errored_sources,
          },
        });
      } catch (e) {
        console.warn('Failed to emit streaming-check telemetry:', (e as Error).message);
      }

      try {
        // `on_streaming` is `boolean | null`; Sentry's SpanAttributeValue has
        // no `null` member, so a null verdict (LML's "inconclusive" case)
        // omits the attribute entirely rather than coercing it to a string.
        Sentry.getActiveSpan()?.setAttributes({
          'streaming_check.errored_sources': streamingResult.value.errored_sources,
          'streaming_check.on_streaming': streamingResult.value.on_streaming ?? undefined,
        });
      } catch (e) {
        console.warn('Failed to project streaming-check telemetry onto span:', (e as Error).message);
      }
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

/**
 * GET /library/ — legacy-shape catalog search.
 *
 * Canonical caller: dj-site's "classic" experience catalog panel
 * (`useSearchCatalogQuery`, `experiences/classic/catalog/SearchResults.tsx`)
 * — Search-by-Artist / Search-by-Album / Search-Both modes, plus the
 * streaming-only "Browse Exclusive Albums" view (`on_streaming` alone, no
 * text query — see #872). Still live alongside `GET /library/query`; the
 * modern experience's query-builder panel (`experiences/modern/catalog/`)
 * uses `/query` instead, so the two coexist by UI generation rather than one
 * superseding the other. `code_letters`/`code_artist_number` lookup is
 * accepted as a query shape but not implemented (throws 501 — see
 * `TODO: Library Code Lookup` below).
 *
 * Auth: `requirePermissions({ catalog: ['read'] })` — DJ role or above.
 *
 * Delegates to `libraryService.fuzzySearchLibrary(artist_name, album_title,
 * n, on_streaming)`: both fields identical (dj-site's Search-Both mode)
 * routes through the full tsvector + trigram + CTA/LML cascade
 * (`searchLibraryBothMode`, same cascade `GET /library/search` uses); both
 * fields set but different keeps the legacy OR-of-trigrams semantics
 * (`artist_name % :artist OR album_title % :album`, `<->` distance order);
 * either field alone is a single-column trigram search. Cascade fallback
 * stages are gated by `CATALOG_TRACK_SEARCH_CTA_ENABLED` /
 * `CATALOG_TRACK_SEARCH_DISCOGS_ENABLED`; alias-aware trigram matching is
 * gated by `CATALOG_SEARCH_ALIAS_ENABLED`.
 *
 * Artwork enrichment (`enrichWithArtwork`) runs fire-and-forget after the
 * response is computed — a slow/rate-limited LML artwork lookup never adds
 * to this endpoint's latency; an un-warmed album's artwork appears on the
 * *next* search instead (BS#1828).
 *
 * Response shape: a bare `LibraryArtistViewResponse[]` (serialized
 * `library_artist_view` rows, `matched_via`/`matched_via_alias` present when
 * the row came from a fallback cascade stage) — no envelope, no pagination
 * metadata. Contrast `GET /library/search`'s `{ success, results, total,
 * query }` envelope and `GET /library/query`'s `{ results, total, page,
 * totalPages }` page.
 */
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
  // BS#1828: artwork enrichment is fire-and-forget, off the response path
  // entirely — search returns local catalog rows immediately. A slow/rate-
  // limited LML can no longer show up as catalog-search latency. The detached
  // promise still runs `enrichWithArtwork`'s `updateArtworkUrl` cache-through
  // write, so an un-warmed album's artwork appears on the *next* search, not
  // this one. `enrichWithArtwork` already collects per-row failures
  // internally; the `.catch` here only guards the rare case it rejects as a
  // whole, so a detached failure can't surface as an unhandledRejection.
  libraryService.enrichWithArtwork(response).catch((err) => {
    console.warn('[Library] Search-time artwork enrichment failed:', err);
  });
  res.status(200).json(response.map((row) => libraryService.serializeLibraryArtistViewEntry(row)));
};

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

  // The code-triple check runs first and wins a collision on both axes: a
  // taken code blocks the write outright no matter what name accompanies it,
  // so it is reported over a name conflict the caller could otherwise route
  // around by picking a free code. Keeping it first makes that precedence a
  // byproduct of ordering rather than a runtime branch, so it can't drift out
  // of sync. `reason` gives this 409 the same positive discriminant as the
  // name-conflict branch below, so a client never has to infer "code
  // conflict" from the absence of a field.
  const existingArtist = await libraryService.getArtistByCode(body.code_letters, body.genre_id, body.code_number);
  if (existingArtist) {
    res.status(409).json({
      message: 'Artist code already exists for that genre and code letters.',
      reason: 'artist_code_conflict',
      artist: existingArtist,
    });
    return;
  }

  // Genre-scoped name pre-check via `artistIdFromName`, whose matcher folds
  // Unicode form, diacritics and case onto one key (backed by
  // `artists_fold_name_idx`) so a name differing only by composition form
  // still collides. That fold is this check's alone -- the code-triple check
  // above compares `code_letters` byte-for-byte -- so do not describe the two
  // as sharing matcher semantics. `reason` is the discriminant a client uses
  // to tell the two conflicts apart: they call for different remedies (use the
  // named artist vs. pick another code), so one shape would leave a client
  // unable to choose.
  const conflictingArtistId = await libraryService.artistIdFromName(body.artist_name, body.genre_id);
  const conflictingArtist = conflictingArtistId ? await libraryService.getArtistById(conflictingArtistId) : null;
  // A miss on the second lookup means the row was deleted between the two
  // queries, so the name is free again: proceed rather than answer 409 with an
  // `artist` the client cannot act on. Neither lookup is backed by a database
  // constraint, so a concurrent writer can still win this race either way.
  if (conflictingArtist) {
    res.status(409).json({
      message: 'Artist name already exists in that genre.',
      reason: 'artist_name_conflict',
      artist: conflictingArtist,
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

type ArtistByCodeQuery = {
  genre_id?: string;
  code_letters?: string;
  code_number?: string;
};

/**
 * Parses one required integer query parameter for `resolveArtistByCode`,
 * bounded on both ends. The upper bound is the int4 guard described at
 * `INT4_MAX`; the lower bound differs per parameter, so it is passed in.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, so a present-but-empty parameter
 * (`?code_number=`) would sail through `Number.isInteger` as a legitimate
 * zero — which matters now that 0 is a valid `code_number`. Hence the explicit
 * blank check before the numeric one.
 */
const parseCodeQueryInt = (raw: string | undefined, name: string, min: number): number => {
  // Express's `simple` query parser yields string[] for repeated keys
  // (`?genre_id=1&genre_id=2`), which `Number()` would collapse to NaN with a
  // misleading message; name the real problem instead.
  if (typeof raw !== 'string') {
    throw new WxycError(`Invalid ${name}: must be a single value`, 400);
  }
  if (raw.trim() === '') {
    throw new WxycError(`Invalid ${name}: must be an integer between ${min} and ${INT4_MAX}`, 400);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > INT4_MAX) {
    throw new WxycError(`Invalid ${name}: must be an integer between ${min} and ${INT4_MAX}`, 400);
  }
  return value;
};

/**
 * BS#2149: resolves a fully-specified library code to the artists that own it --
 * the `/wxycdb` "does this code already exist, and whose is it" question
 * `peek-code` (next-free-number) and `search` (name query) cannot answer.
 *
 * Answers a LIST, not a single artist. The `(code_letters, genre_id,
 * code_number)` triple is not unique — see `getArtistsByCode` for the schema
 * reason and the measured V/A collisions — so a librarian holding a compilation
 * card gets every bucket that shares the code and picks, rather than being handed
 * one arbitrary row out of 27. A single owner is simply a one-element array.
 *
 * `code_number` accepts **0**: the whole Various-Artists surface is filed at
 * `artist_genre_code = 0` (68 rows in the production clone, all `code_letters =
 * 'V/A'`), and neither sibling route imposes a floor — `addArtist` passes the
 * value straight through and `peekArtistNumber` uses `Number.isFinite`. A `< 1`
 * floor here would have made the one filing class that most needs code-first
 * resolution (compilations have no artist name to search by) the one class this
 * route could not answer.
 *
 * Two 404s, discriminated by `reason` rather than by prose the way `addArtist`
 * above discriminates its two 409s: `genre_not_found` means the client's genre
 * dropdown is stale, `code_not_assigned` means the code is free to create. A
 * client that has to string-match `message` to tell those apart cannot act on
 * either.
 */
export const resolveArtistByCode: RequestHandler = async (
  req: Request<object, object, object, ArtistByCodeQuery>,
  res
) => {
  const { query } = req;
  // Name only the parameters actually missing. A fixed string listing all three
  // would satisfy any "the error mentions code_number" assertion even when the
  // handler refused on a different parameter, which is exactly the blind spot
  // the BS#2149 review found in this route's first test.
  const missing = (['genre_id', 'code_letters', 'code_number'] as const).filter((name) => query[name] === undefined);
  if (missing.length > 0) {
    throw new WxycError(`Missing query parameters: ${missing.join(', ')}`, 400);
  }

  // The `string[]` guard here is the one `searchArtistsInGenre` applies to `q`:
  // without it, `?code_letters=B&code_letters=U` binds a text[] against Drizzle's
  // `eq(artists.code_letters, ...)` text column and surfaces as a driver-level
  // 500 instead of a 400.
  if (typeof query.code_letters !== 'string') {
    throw new WxycError('Invalid code_letters: must be a single string value', 400);
  }

  const genreId = parseCodeQueryInt(query.genre_id, 'genre_id', 1);
  // Lower bound 0, not 1 — see the V/A note in this function's doc comment.
  const codeNumber = parseCodeQueryInt(query.code_number, 'code_number', 0);

  // Trim + upper-case before matching. `artists.code_letters` is matched
  // byte-for-byte by the query below, and every one of the 24,078 artist rows in
  // the production clone stores a trimmed, upper-case value — so normalizing can
  // never turn a real hit into a miss, while NOT normalizing lets ` BU ` or `bu`
  // answer the "this code is free" 404 and invite the librarian to mint a
  // duplicate shelf code. (The sibling write path, `addArtist`, still compares
  // raw; widening its pre-check is a separate change, deliberately not made here
  // because it alters an existing route's 409 behavior.)
  const codeLetters = query.code_letters.trim().toUpperCase();
  if (codeLetters === '') {
    throw new WxycError('Invalid code_letters: must be a non-empty string', 400);
  }

  // Code lookup FIRST, genre check only to explain a miss: a hit proves the genre
  // exists (the lookup inner-joins `genre_artist_crossreference.genre_id`), so
  // probing `genreExists` up front would double the round-trips on every happy
  // path to discriminate a 404 that isn't happening.
  const owners = await libraryService.getArtistsByCode(codeLetters, genreId, codeNumber);

  if (owners.length === 0) {
    if (!(await libraryService.genreExists(genreId))) {
      res.status(404).json({ message: 'Genre not found', reason: 'genre_not_found' });
      return;
    }
    res.status(404).json({
      message: 'Artist code not assigned in that genre',
      reason: 'code_not_assigned',
    });
    return;
  }

  res.status(200).json({
    artists: owners.map((owner) => ({
      id: owner.artist_id,
      artist_name: owner.artist_name,
      // The stored `code_letters`, not the normalized input: the row is the
      // truth about how this code is filed.
      code_letters: owner.code_letters,
      code_number: codeNumber,
      genre_id: genreId,
    })),
  });
};

export const getRotation: RequestHandler = async (req, res) => {
  const rotation = await libraryService.getRotationFromDB();
  res.status(200).json(rotation);
};

/**
 * Upper bound AND default for `?limit=` on the uncatalogued queue — owned by
 * the service, since the cap is a property of the query rather than of this
 * route. Re-exported through the namespace import so the 400 message and the
 * query can never disagree about the number.
 */
const { UNCATALOGUED_ROTATION_MAX_LIMIT } = libraryService;

/**
 * Parse an optional non-negative-integer query parameter or path segment.
 * Returns `undefined` when absent, `null` when present but not a well-formed
 * non-negative integer (the caller turns that into a 400). Strict — unlike
 * `parseInt`, `'42abc'` and `'4.5'` are rejected rather than silently
 * truncated to `42` and `4`.
 */
function parseNonNegativeInt(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * `GET /library/rotation/uncatalogued` (BS#2109).
 *
 * The cataloging-backlog queue: rotation rows with no linked library
 * release, deliberately WITHOUT the `DISTINCT ON` collapse `getRotation`
 * uses for its dropdown shape — two physically distinct promos that share
 * an artist and title are two separate rows a librarian has to catalogue,
 * and collapsing them would silently hide one. See
 * `getUncataloguedRotationFromDB` for the `album_id IS NULL` predicate this
 * reads through and why the `0` sentinel it once also matched does not
 * exist on this column.
 *
 * Optional `?limit=` (1…500) and `?offset=` window the queue. **`limit`
 * defaults to 500 rather than to the whole backlog**: at ~3.8k unlinked rows
 * an uncapped response is ≈700 KB of JSON per request on a single-worker box
 * that also serves the live flowsheet, and the ceiling is far cheaper to set
 * before `wxyc-shared#354` publishes this shape than after a client starts
 * depending on "omit ⇒ everything". dj-site#1161's queue UI pages with
 * `offset`.
 *
 * ROUTE REGISTRATION ORDER IS LOAD-BEARING — must be registered ahead of any
 * `/rotation/:id`-style parameterized route (see `library.route.ts`), the
 * same trap already documented there for `/catalog` vs
 * `/:id/compilation-tracks`. Pinned by
 * `tests/unit/routes/library-rotation-uncatalogued.route.test.ts`.
 */
export const getUncataloguedRotation: RequestHandler = async (req, res) => {
  const limit = parseNonNegativeInt(req.query.limit);
  if (limit === null || (limit !== undefined && (limit < 1 || limit > UNCATALOGUED_ROTATION_MAX_LIMIT))) {
    throw new WxycError(
      `Invalid Parameter: limit must be an integer between 1 and ${UNCATALOGUED_ROTATION_MAX_LIMIT}`,
      400
    );
  }

  const offset = parseNonNegativeInt(req.query.offset);
  if (offset === null) {
    throw new WxycError('Invalid Parameter: offset must be a non-negative integer', 400);
  }

  const rotation = await libraryService.getUncataloguedRotationFromDB({ limit, offset });
  res.status(200).json(rotation);
};

export type RotationAddRequest = Omit<NewRotationRelease, 'id'>;

/**
 * Pick only the fields the client is allowed to write through the public
 * `POST /library/rotation` endpoint (BS#1380; relaxed by BS#2109).
 * Mirrors `pickUpdateEntryFields()` in flowsheet.controller.ts (BS#1099).
 *
 * Server-derived columns (`legacy_rotation_id`, `legacy_library_release_id`,
 * `discogs_release_id`, `discogs_release_id_source`, `lml_identity_id`,
 * `tracklist_lookup_attempted_at`, `kill_date`) must never be
 * client-supplied through this endpoint — `addToRotation` derives the
 * LML-handle columns from `library_identity` and the synchronous
 * `resolveIdentity` hop.
 *
 * `artist_name`/`album_title`/`record_label` are normally tubafrenzy-ETL-only
 * snapshot columns, but BS#2109 relaxed `addRotation` to accept a rotation
 * release with no catalogued `album_id` — the free-text trio is then the
 * only way to represent it. So they are picked ONLY when the client did not
 * supply an `album_id`: a catalogued row (`album_id` present) still has its
 * display sourced from the `library` join, and a client-supplied snapshot on
 * a catalogued row would leave stale free text nothing ever clears.
 *
 * **`null` and `undefined` mean the same thing in every test here.**
 * `{ album_id: selected?.id ?? null, ... }` is the idiomatic client shape,
 * and an `=== undefined` test would take the has-an-album_id branch on it —
 * dropping the free text into a row that is then permanently
 * un-catalogueable and indistinguishable from every other blank row.
 *
 * Phrased as an allowlist (signature-typed accept list) so a future column
 * addition to `rotation` is implicitly rejected by typecheck until
 * explicitly added to the signature. Matches dj-site's `RotationParams`
 * (`{ album_id, rotation_bin }`); widen the signature here when a future
 * caller legitimately needs another field.
 */
type AddRotationAllowlist = Pick<
  NewRotationRelease,
  'album_id' | 'rotation_bin' | 'artist_name' | 'album_title' | 'record_label'
>;

export function pickAddRotationFields(body: Partial<NewRotationRelease>): AddRotationAllowlist {
  const picked = {} as AddRotationAllowlist;
  if (body.album_id != null) picked.album_id = body.album_id;
  if (body.rotation_bin != null) picked.rotation_bin = body.rotation_bin;
  if (body.album_id == null) {
    if (body.artist_name != null) picked.artist_name = body.artist_name;
    if (body.album_title != null) picked.album_title = body.album_title;
    if (body.record_label != null) picked.record_label = body.record_label;
  }
  return picked;
}

/**
 * The three free-text snapshot columns are `varchar(128)`. The only other
 * writer (`internal.route.ts`) `truncate(_, 128)`s them because tubafrenzy
 * free text routinely overruns and a webhook has nobody to report a 400 to.
 * This endpoint has a human on the other end, so it **rejects rather than
 * truncates**: silently amputating a long compilation or classical title
 * would leave the librarian a corrupted record with no signal, whereas
 * without a guard PostgreSQL raises 22001 and the request becomes an opaque
 * 500 + Sentry event that names no field.
 *
 * The length check below counts `[...value].length` (Unicode code points),
 * not `value.length` (UTF-16 code units) — `varchar(128)` is a
 * **character** limit; PostgreSQL counts code points, and `value.length`
 * over-counts every character outside the BMP (astral emoji, CJK
 * Extension B, …) as 2. Review round 3 finding 6: a bare `.length` never
 * *under*-rejects (so no 22001 could ever slip through), but it does
 * over-reject values PostgreSQL would happily store — undercutting the
 * very reason this endpoint chose reject-over-truncate.
 */
const ROTATION_SNAPSHOT_MAX_LENGTH = 128;
const ROTATION_SNAPSHOT_FIELDS = ['artist_name', 'album_title', 'record_label'] as const;

/** Unicode-code-point length — see `ROTATION_SNAPSHOT_MAX_LENGTH` above. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** `true` only for a string with at least one non-whitespace character. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `POST /library/rotation` (BS#1380; relaxed by BS#2109 for uncatalogued
 * releases). `rotation_bin` is always required. `album_id` may be absent
 * when `artist_name` and `album_title` are both supplied — the free-text
 * pair that represents a rotation release the station hasn't catalogued
 * yet. 400s when neither an `album_id` nor the artist/title pair is given;
 * an anonymous rotation row helps nobody, and it is un-catalogueable
 * afterwards because `PATCH /rotation/:id/link` is the only repair and a
 * blank row gives the librarian nothing to identify it by.
 *
 * `null` is treated exactly as absent throughout (`selected?.id ?? null` is
 * the shape clients actually send), a blank/whitespace-only artist or title
 * does not count as supplied, and `album_id: 0` is rejected: there is no `0`
 * sentinel on this column — `library.id` is a `serial` starting at 1 and
 * `rotation.album_id` FKs it, so a `0` would drop the free text and then
 * violate the FK into an opaque 500. It is the literal payload the classic
 * `/wxycdb` rotation form posts, so it gets a named 400.
 *
 * **Behavior change (review round 3 finding 7):** `Number.isInteger(album_id)`
 * also tightens the pre-existing catalogued path, not just the new
 * uncatalogued one — `{"album_id": "2", "rotation_bin": "M"}` previously
 * inserted fine (PostgreSQL coerces a numeric string on the way into an
 * `integer` column) and now 400s. Kept deliberately: dj-site's
 * `addRotationEntry` mutation (`lib/features/rotation/api.ts`) is typed
 * against `AddRotationRequest` (`album_id: number`, from the shared OpenAPI
 * contract) and its sole call site (`RotationClassifyControl.tsx`) passes
 * `album.id!`, itself typed `number` — the only known caller of this
 * endpoint always sends a genuine JSON number, never a numeric string, so
 * this tightening does not affect it. A caller that does send a numeric
 * string was relying on undocumented PostgreSQL coercion rather than the
 * documented contract.
 */
export const addRotation: RequestHandler<object, unknown, NewRotationRelease> = async (req, res) => {
  const { body } = req;

  if (body.rotation_bin == null) {
    throw new WxycError('Missing Parameters: rotation_bin', 400);
  }
  // BS#2173: this checked PRESENCE but never VALUE, so an unrecognized bin
  // reached the INSERT and surfaced as a Postgres 22P02 — a 500 for what is
  // plainly bad input. Shared with the rotation webhook via `parseRotationBin`
  // so the two cannot disagree about normalization (they did: `'h'` was
  // accepted by one and rejected by the other).
  if (parseRotationBin(body.rotation_bin).kind !== 'bin') {
    throw new WxycError(
      `Invalid rotation_bin ${JSON.stringify(body.rotation_bin)}. Expected one of: ${ROTATION_BINS.join(', ')}.`,
      400
    );
  }

  const hasAlbumId = body.album_id != null;
  if (hasAlbumId && !(Number.isInteger(body.album_id) && (body.album_id as number) > 0)) {
    throw new WxycError(
      'Invalid Parameter: album_id must be a positive integer, or omitted for an uncatalogued release',
      400
    );
  }

  if (!hasAlbumId) {
    // Only guarded on the uncatalogued path: with an `album_id` present the
    // trio is deliberately dropped by `pickAddRotationFields`, so a long
    // value there is never written and must not fail an otherwise-valid add.
    for (const field of ROTATION_SNAPSHOT_FIELDS) {
      const value = body[field];
      if (value == null) continue;
      if (typeof value !== 'string') {
        throw new WxycError(`Invalid Parameter: ${field} must be a string`, 400);
      }
      if (codePointLength(value) > ROTATION_SNAPSHOT_MAX_LENGTH) {
        throw new WxycError(
          `Invalid Parameter: ${field} exceeds the ${ROTATION_SNAPSHOT_MAX_LENGTH}-character limit`,
          400
        );
      }
    }

    if (!isNonBlankString(body.artist_name) || !isNonBlankString(body.album_title)) {
      throw new WxycError('Missing Parameters: album_id, or artist_name and album_title', 400);
    }
  }

  const picked = pickAddRotationFields(body);
  const rotationRelease: RotationRelease = await libraryService.addToRotation(picked);
  res.status(201).json(rotationRelease);
};

export type LinkRotationRequest = {
  album_id: number;
};

/**
 * `PATCH /library/rotation/:rotation_id/link` (BS#2109) — links an
 * uncatalogued rotation row to a library release after the fact (the
 * "Import to Library" step of the tubafrenzy `/wxycdb` workflow). Rejects
 * double-linking. Deliberately leaves the free-text snapshot columns
 * (`artist_name` / `album_title` / `record_label`) untouched — see
 * `libraryService.linkRotationToAlbum` for the transactional details and
 * why (review round 3 finding 1: clearing them stranded the tracklist
 * picker with no self-heal path). The response is a projected shape, not
 * the raw `.returning()` row (finding 4) — see the same doc.
 */
export const linkRotationToAlbum: RequestHandler<{ rotation_id: string }, unknown, LinkRotationRequest> = async (
  req,
  res
) => {
  // Strict, not `parseInt`: `parseInt('42abc', 10)` is 42, which would let
  // `/library/rotation/42abc/link` mutate rotation 42.
  const rotationId = parseNonNegativeInt(req.params.rotation_id);
  if (rotationId == null || rotationId <= 0) {
    throw new WxycError('rotation_id must be a positive integer', 400);
  }

  const { album_id } = req.body;
  // `Number.isInteger` already rejects every non-number, so no `typeof` guard.
  if (!Number.isInteger(album_id) || album_id <= 0) {
    throw new WxycError('Missing Parameters: album_id', 400);
  }

  const result = await libraryService.linkRotationToAlbum(rotationId, album_id);

  switch (result.outcome) {
    case 'rotation_not_found':
      throw new WxycError('Rotation entry not found', 404);
    case 'album_not_found':
      throw new WxycError('Album not found', 404);
    case 'already_linked':
      throw new WxycError('Rotation entry is already linked to a library release', 409);
    case 'linked':
      res.status(200).json(result.rotation);
      break;
    default: {
      // Exhaustiveness guard. Without it, a `LinkRotationOutcome` variant
      // added later falls through every case and the handler returns having
      // written no response — the request hangs until the 35 s server
      // timeout. `never` makes that a typecheck failure instead.
      const unhandled: never = result;
      throw new WxycError(`Unhandled rotation link outcome: ${JSON.stringify(unhandled)}`, 500);
    }
  }
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

export const getAlbum: RequestHandler<
  object,
  unknown,
  unknown,
  { album_id?: string; legacy_release_id?: string }
> = async (req, res) => {
  const { query } = req;

  // dj.wxyc.org per-release permalink front door (BS#1880): external callers
  // (LML, wxyc.info, the request line) hold the tubafrenzy `legacy_release_id`,
  // not the BS serial `library.id`. When given a legacy id, resolve it to the
  // serial so a legacy-keyed permalink can reach the catalog. 404 when it maps
  // to no catalog row (a `library.db` release not yet synced into BS Postgres).
  if (query.legacy_release_id !== undefined) {
    // Strict `Number()` (not `parseInt`) so trailing garbage ("65880xyz") and a
    // repeated param (Express yields `string[]` → "1,2") both become NaN and are
    // rejected, rather than silently parsing a partial/fabricated id.
    const legacyId = Number(query.legacy_release_id);
    if (!Number.isInteger(legacyId) || legacyId <= 0) {
      throw new WxycError('Invalid legacy_release_id', 400);
    }
    const album = await libraryService.getAlbumByLegacyId(legacyId);
    if (album === undefined) {
      throw new WxycError('No catalog album for that legacy_release_id', 404);
    }
    res.status(200).json(album);
    return;
  }

  if (query.album_id === undefined) {
    throw new WxycError('Bad Request, missing album identifier: album_id or legacy_release_id', 400);
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

  // BS#1962: the SSE feeder's discogs-unavailable cache is invalidated off the
  // `cdc_library` CDC stream (see `metadata-broadcast.ts`), not from here — this
  // UPDATE's own NOTIFY drops the flipped album from every BS instance's cache,
  // so no write-path poke is needed.

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
    checkStreamingAvailability(displayArtistName, albumTitle, { caller: 'library-update-album-streaming' }),
    lmlLookupCoordinator.lookup(displayArtistName, albumTitle, undefined, {
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

/**
 * POST /library/:id/discogs-recheck (BS#1283 / epic #1280 sub-issue 3).
 *
 * Manual counterpart to the daily `library-discogs-unavailable-recheck`
 * cron: force-asks LML for a fresh Discogs match on this release (bypassing
 * the runtime BS#1293 `discogsUnavailable` gate), so an MD can close the
 * "embargo just lifted, want it now" gap instead of waiting for the next
 * cron tick. Runs the same 0.95-confidence-floor / sticky-false-match-fixed
 * writer path as the cron — see `libraryService.recheckDiscogsAvailability`.
 *
 * Gated on `catalog:write` (musicDirector + stationManager) — same bar as
 * the other catalog-mutating routes on this router (`updateAlbum`,
 * `addAlbum`), not the lighter `catalog:read` bar `markMissing`/`markFound`
 * use, because this can rewrite `rotation.discogs_release_id`.
 */
export const manualDiscogsRecheck: RequestHandler<{ id: string }> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);

  const existing = await libraryService.getLibraryRowById(albumId);
  if (!existing) {
    throw new WxycError('Album not found', 404);
  }
  if (!existing.artist_name || !existing.album_title) {
    throw new WxycError('Cannot recheck a release without artist_name and album_title', 400);
  }
  if (!isLmlConfigured()) {
    throw new WxycError('LML is not configured', 503);
  }

  const result = await libraryService.recheckDiscogsAvailability(albumId, existing.artist_name, existing.album_title);
  res.status(200).json(result);
};

/**
 * DELETE /library/:id (BS#2112). Hard delete — no soft-delete tombstone; see
 * the issue's decision record for why. Refuses with 409 when the release
 * carries `flowsheet` plays (D10 policy) by ANY of three paths: linked
 * directly via `flowsheet.album_id` (`onDelete: 'set null'`), transitively
 * via `flowsheet.rotation_id` → `rotation.album_id` (`set null` behind a
 * `cascade`), or by bare `flowsheet.legacy_release_id` — plays the tubafrenzy
 * webhook wrote that `jobs/legacy-linkage-resolve` has not yet turned into an
 * `album_id`. The first two would silently blank historical play provenance;
 * the third would strand it, since the denylist means no future `library` row
 * ever carries that `legacy_release_id` for the resolver to join to.
 * `bins`, `library_identity`, `library_identity_source`, and
 * `artist_library_crossreference` are resolved explicitly inside the same
 * transaction as the delete (see `libraryService.deleteAlbumFromDB` for why
 * the fourth one is there — schema.ts and the live constraint disagree),
 * `album_popularity.representative_library_id` is nulled there for want of
 * any FK, and the release's `legacy_release_id` is recorded in
 * `library_delete_denylist` so `jobs/library-etl` cannot resurrect it; every
 * other dependent is left to its own FK. Gated to `catalog:['write']`, the
 * same bar as `updateAlbum`/`addAlbum` — not the lighter `catalog:read` bar
 * `markMissing`/`markFound` use, since this is irreversible.
 *
 * The 409 body is non-standard for this service (`{message, reason,
 * play_count, direct_play_count, rotation_linked_play_count,
 * legacy_linked_play_count}` rather than the error handler's shape) because
 * the count is the whole point of the refusal: the librarian needs to know
 * how much history the delete would have damaged, and by which path.
 * Documented in `apps/backend/app.yaml`.
 *
 * A `503` with `reason: 'lock_unavailable'` means the delete stood down
 * rather than wait on a row a live writer holds — see
 * `libraryService.deleteAlbumFromDB`'s lock-order paragraph. It is retryable
 * and says nothing about whether the release is deletable; deliberately NOT a
 * 409, which in this endpoint's contract means "refused on the merits".
 */
export const deleteAlbum: RequestHandler<{ id: string }> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);

  // Attribution for the denylist row. Everything here is best-effort: under
  // AUTH_BYPASS `req.auth` may be absent or thin, and a missing actor must
  // never block a librarian's delete (see `DeleteAlbumActor`).
  const result = await libraryService.deleteAlbumFromDB(albumId, {
    userId: req.auth?.id ?? req.auth?.sub ?? null,
    email: req.auth?.email ?? null,
    role: req.auth?.role ?? null,
  });

  if (result.outcome === 'not_found') {
    throw new WxycError('Album not found', 404);
  }

  if (result.outcome === 'lock_unavailable') {
    res.status(503).json({
      message: 'Could not delete: the release is being written to right now. Try again in a moment.',
      reason: 'lock_unavailable',
    });
    return;
  }

  if (result.outcome === 'has_flowsheet_plays') {
    const { playCount, directPlayCount, rotationLinkedPlayCount, legacyLinkedPlayCount } = result;
    // Only spell out the split when an indirect path contributed — the common
    // refusal reads as a plain play count, and the breakdown appears exactly
    // when it explains something the librarian can't otherwise see (plays that
    // name the rotation entry, or only the legacy release id, but not the
    // release).
    const parts = [`${directPlayCount} linked to the release`];
    if (rotationLinkedPlayCount > 0) {
      parts.push(`${rotationLinkedPlayCount} via its rotation entry`);
    }
    if (legacyLinkedPlayCount > 0) {
      parts.push(`${legacyLinkedPlayCount} awaiting linkage from the legacy release id`);
    }
    const breakdown = parts.length > 1 ? ` (${parts.join(', ')})` : '';
    res.status(409).json({
      message: `Cannot delete: release has ${playCount} flowsheet play${playCount === 1 ? '' : 's'} on record${breakdown}`,
      reason: 'flowsheet_references',
      play_count: playCount,
      direct_play_count: directPlayCount,
      rotation_linked_play_count: rotationLinkedPlayCount,
      legacy_linked_play_count: legacyLinkedPlayCount,
    });
    return;
  }

  res.status(204).end();
};

// ---------------------------------------------------------------------------
// Compilation-track (CTA) write path — BS#1964 / Phase 3.5 `/wxycdb` cutover.
//
// Backs api.yaml v1.28.0 (WXYC/wxyc-shared#291): GET lists a release's stored
// V/A per-track artists, POST additively writes an explicit client-confirmed
// list, and GET .../discogs-suggestions returns a release's tracklist as
// write-ready rows without writing. The `{id}` path param is the serial
// `library.id` (like the sibling `/library/:id` PATCH/missing/found routes),
// resolved to a Discogs release via `library_identity` for the suggestions
// read. BS keeps LOCAL wire types here (mirroring `NewAlbumRequest` /
// `UpdateAlbumRequest`) rather than importing `@wxyc/shared`, so this surface
// ships without a shared publish. Service logic: `library.service.ts`.
// ---------------------------------------------------------------------------

type CompilationTrackInputWire = {
  artist_name?: unknown;
  track_title?: unknown;
  track_position?: unknown;
};

type CompilationTracksWriteBody = {
  tracks?: CompilationTrackInputWire[];
};

// Column caps from `compilation_track_artist` (schema.ts): reject over-length
// input as a 400 rather than letting it reach the INSERT and trip PG 22001
// ("value too long") → 500. Mirrors `updateAlbum`'s `MAX_ALBUM_TEXT_LENGTH`.
const CTA_ARTIST_NAME_MAX = 255;
const CTA_TRACK_TITLE_MAX = 255;
const CTA_TRACK_POSITION_MAX = 20;

// Upper bound on tracks per additive write. A real V/A tracklist is well under
// this (Discogs box sets top out in the low hundreds); the cap keeps a single
// request from building an unbounded multi-row INSERT. Reject as 400 rather
// than truncating, so the client sees that its list was too large.
const CTA_MAX_TRACKS = 500;

/** Normalize an optional nullable free-text field: absent/blank/whitespace → null. */
const normalizeOptionalCtaText = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
};

type CompilationTrackValidationResult =
  { ok: true; tracks: libraryService.CompilationTrackInputRow[] } | { ok: false; message: string };

/**
 * Validate + normalize a `CompilationTracksWriteRequest` body (pure, so it's
 * unit-testable without a DB). `artist_name` is required and non-blank
 * (api.yaml `minLength: 1`); `track_title` / `track_position` are optional and
 * nullable, with blank/whitespace coerced to null so the `track_title IS NULL`
 * partial unique index behaves. All three are length-capped to their columns,
 * and the list itself is capped at `CTA_MAX_TRACKS` entries.
 */
export function validateCompilationTracksBody(body: CompilationTracksWriteBody): CompilationTrackValidationResult {
  if (!body || !Array.isArray(body.tracks) || body.tracks.length === 0) {
    return { ok: false, message: 'tracks must be a non-empty array' };
  }
  if (body.tracks.length > CTA_MAX_TRACKS) {
    return { ok: false, message: `tracks must not exceed ${CTA_MAX_TRACKS} entries` };
  }
  const tracks: libraryService.CompilationTrackInputRow[] = [];
  for (let i = 0; i < body.tracks.length; i++) {
    const t = body.tracks[i];
    if (t === null || typeof t !== 'object') {
      return { ok: false, message: `tracks[${i}] must be an object` };
    }
    const artistRaw = t.artist_name;
    if (typeof artistRaw !== 'string' || artistRaw.trim() === '') {
      return { ok: false, message: `tracks[${i}].artist_name is required and must be a non-empty string` };
    }
    const artist_name = artistRaw.trim();
    if (artist_name.length > CTA_ARTIST_NAME_MAX) {
      return { ok: false, message: `tracks[${i}].artist_name exceeds ${CTA_ARTIST_NAME_MAX} characters` };
    }
    const track_title = normalizeOptionalCtaText(t.track_title);
    if (track_title !== null && track_title.length > CTA_TRACK_TITLE_MAX) {
      return { ok: false, message: `tracks[${i}].track_title exceeds ${CTA_TRACK_TITLE_MAX} characters` };
    }
    const track_position = normalizeOptionalCtaText(t.track_position);
    if (track_position !== null && track_position.length > CTA_TRACK_POSITION_MAX) {
      return { ok: false, message: `tracks[${i}].track_position exceeds ${CTA_TRACK_POSITION_MAX} characters` };
    }
    tracks.push({ artist_name, track_title, track_position });
  }
  return { ok: true, tracks };
}

/** GET /library/:id/compilation-tracks — list a release's stored CTA rows. */
export const getCompilationTracks: RequestHandler<{ id: string }> = async (req, res) => {
  const libraryId = parseAlbumId(req.params.id);
  if (!(await libraryService.libraryRowExists(libraryId))) {
    throw new WxycError('Library release not found', 404);
  }
  const tracks = await libraryService.getCompilationTracks(libraryId);
  res.status(200).json({ library_id: libraryId, tracks });
};

/**
 * POST /library/:id/compilation-tracks — additive write of an explicit,
 * client-confirmed CTA list. Body is validated (400) before the library-row
 * existence gate (404). Existing rows matched on the CTA uniqueness keys are
 * skipped, never mutated (D6). Reports `inserted` vs `skipped` and returns the
 * release's full stored set after the write.
 */
export const writeCompilationTracks: RequestHandler<{ id: string }, unknown, CompilationTracksWriteBody> = async (
  req,
  res
) => {
  const libraryId = parseAlbumId(req.params.id);
  const validation = validateCompilationTracksBody(req.body);
  if (!validation.ok) {
    throw new WxycError(validation.message, 400);
  }
  if (!(await libraryService.libraryRowExists(libraryId))) {
    throw new WxycError('Library release not found', 404);
  }
  const result = await libraryService.writeCompilationTracks(libraryId, validation.tracks);
  res.status(200).json({
    library_id: libraryId,
    inserted: result.inserted,
    skipped: result.skipped,
    tracks: result.tracks,
  });
};

/**
 * GET /library/:id/compilation-tracks/discogs-suggestions — autopopulate
 * source: the linked Discogs release's tracklist as write-ready
 * `CompilationTrackInput` rows, without writing. `discogs_release_id: null` +
 * empty `tracks` means "no upstream release resolved → manual entry".
 */
export const getCompilationTrackDiscogsSuggestions: RequestHandler<{ id: string }> = async (req, res) => {
  const libraryId = parseAlbumId(req.params.id);
  if (!(await libraryService.libraryRowExists(libraryId))) {
    throw new WxycError('Library release not found', 404);
  }
  const { discogs_release_id, tracks } = await libraryService.getCompilationTrackSuggestions(libraryId);
  res.status(200).json({ library_id: libraryId, discogs_release_id, tracks });
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

/**
 * GET /library/query — query-builder catalog search (Catalog Track Search
 * project, WXYC/projects/30).
 *
 * Canonical caller: dj-site's "modern" experience catalog panel
 * (`useSearchLibraryQueryQuery` / `useSearchLibraryQueryInfiniteQuery`,
 * `lib/features/catalog/api.ts`), gated client-side behind dj-site's
 * `NEXT_PUBLIC_CATALOG_TRACK_SEARCH_UI_ENABLED` flag. Distinct from the
 * legacy `GET /library/` search this coexists with — see that handler's
 * docstring and `library.route.ts`'s header comment for how the two split
 * by UI generation.
 *
 * Auth: `requirePermissions({ catalog: ['read'] })` — DJ role or above.
 *
 * Query semantics: `q` is parsed by `search-parser.service.ts`
 * (`parseSearchQuery` + `CATALOG_PARSER_CONFIG`) into field-scoped
 * conditions (`artist:`, `album:`, `label:`, bare `all`-field terms,
 * negation, AND/OR) rather than the plain artist/title split `GET
 * /library/` and `GET /library/search` use. Offset-paginated
 * (`page`/`limit`, default limit 50, max 100 — see `DEFAULT_LIMIT` /
 * `MAX_LIMIT` above); sortable by `artist` | `album` | `plays` | `date` in
 * either `order`; filterable by `on_streaming`, `missing`,
 * `genres`/`genre`, `formats`/`format`, and `rotation_bins`.
 *
 * Ranking/filter semantics live in `librarySearchService.searchLibrary`
 * (`library-search.service.ts`): a plain-text, non-negated, ≤6-condition
 * query of at least `MIN_CASCADE_QUERY_LENGTH` (4) characters
 * (`passesCascadeGate`) reaches the same tsvector + trigram + CTA/LML
 * cascade the other two endpoints use; anything else (field-scoped,
 * negated, or too short) is a pure SQL filter/sort with no cascade.
 * `CATALOG_TRACK_SEARCH_CTA_ENABLED` / `CATALOG_TRACK_SEARCH_DISCOGS_ENABLED`
 * gate the cascade's fallback stages; `CATALOG_SEARCH_ALIAS_ENABLED` gates
 * alias-aware matching via `artist_search_alias`.
 *
 * Response shape: `{ results: AlbumSearchResultRow[], total, page,
 * totalPages }` — an offset-paginated page with a richer per-row shape than
 * `GET /library/` (adds `label`, `rotation_bin`, `plays`,
 * `discogsUnavailable`, etc.). Contrast `GET /library/`'s bare array and
 * `GET /library/search`'s `{ success, results, total, query }` envelope.
 */
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
// GET /library/catalog/compilation-tracks — CTA bulk export (BS#1965)
// ---------------------------------------------------------------------------

/**
 * Sibling of {@link exportCatalog} for the Backend-sourced library.db producer
 * (discogs-etl#351): stream every compilation_track_artist row as gzipped NDJSON
 * (one CatalogCompilationTrackRow per line) so the producer can build library.db's
 * `compilation_track_artist` table over HTTP. Same freshness (the
 * `conditionalGet(getCatalogLastModifiedAt)` middleware short-circuits to 304 on
 * an unchanged `library_watermark`), same pre-gzipped per-watermark cache, and
 * the same Accept-Encoding negotiation as the library export — this handler is a
 * memcpy on the hot path.
 */
export const exportCompilationTracks: RequestHandler = async (req, res) => {
  const gzipped = await catalogExportService.getCompilationTracksExportGzip();
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
