import { Request, RequestHandler, Response } from 'express';
import * as Sentry from '@sentry/node';
import {
  Album,
  Artist,
  db,
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  NewRotationRelease,
  RotationBin,
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
import { INT2_MAX, INT4_MAX } from '../utils/constants.js';

// `genres.id` and `genre_artist_crossreference.artist_genre_code` are Postgres
// int4 columns. A query value outside that range parses fine as a JS integer
// (passing `Number.isInteger`) but blows up downstream as an unhandled
// "value out of range for type integer" Postgres error — SQLSTATE 22003, which
// is not a `WxycError` and so answers a generic 500 plus a Sentry capture.
// `INT4_MAX` lives in `utils/constants.ts` and is imported, not re-declared --
// `flowsheet.controller.ts` (BS#1800) hit this first on `start_id`/`end_id`
// and owned the only copy until the BS#2149 review found this file had grown
// a silently-drifting second one.

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
  // BS#2410: `label` is no longer required on its own — see the either-or
  // guard in `addAlbum` and `resolveNewAlbumLabel` below. `label_id` admits
  // `null` (the `selected?.id ?? null` wire shape) and treats it as absent;
  // the member is typed `| null` for the same reason `UpdateAlbumRequest`'s
  // is — so the null the client actually sends is in the type rather than
  // arriving as an untyped surprise.
  label?: string;
  label_id?: number | null;
  genre_id: number;
  format_id: number;
  disc_quantity?: number;
  // BS#2410 (rotation-import plan D2): the release call code, operator-chosen
  // rather than server-assigned. Both optional; omitting them reproduces the
  // pre-2410 behavior exactly (MAX+1 for the artist, NULL volume letters).
  code_number?: number;
  code_volume_letters?: string;
};

// `library.code_volume_letters` is `varchar(4)`. Reject over-length input as a
// 400 rather than letting it reach the INSERT and trip PG 22001 ("value too
// long") -> 500, the same treatment `MAX_ALBUM_TEXT_LENGTH` gives the
// `varchar(128)` text columns on the PATCH path.
const MAX_CODE_VOLUME_LETTERS_LENGTH = 4;

/**
 * Validate an operator-supplied `code_number` for `POST /library` (BS#2410).
 *
 * Bounded at `INT2_MAX` because `library.code_number` is a Postgres
 * `smallint`: unbounded, a plausible-looking 40000 passes `Number.isInteger`
 * and reaches PG as SQLSTATE 22003 -> 500 where this codebase's convention is
 * a boundary 400.
 *
 * Deliberately NOT collision-checked. `libraryService.albumCodeNumberTaken`
 * exists and `updateAlbum` calls it for exactly the collision a client-chosen
 * number can create, so its absence here reads as an oversight unless said
 * out loud: WXYC has a single librarian, so the two-operator race does not
 * exist, and an application-side 409 would block the deliberate re-use of a
 * lost record's slot (rotation-import plan D2). Uniqueness becomes the
 * database's job on BS#2033, whose constraint carries the 23505 -> 409
 * obligation recorded in `jobs/library-call-number-dedup/README.md`.
 */
const validateCodeNumber = (code_number: unknown): number => {
  if (typeof code_number !== 'number' || !Number.isInteger(code_number) || code_number < 1 || code_number > INT2_MAX) {
    throw new WxycError(`code_number must be an integer between 1 and ${INT2_MAX}`, 400);
  }
  return code_number;
};

/**
 * Validate an operator-supplied `code_volume_letters` for `POST /library`
 * (BS#2410).
 *
 * Not `validateTextField`, deliberately: that helper rejects a blank value and
 * this column is nullable. An import form that submits an empty volume-letters
 * box means "no volume letters", so `''` (and whitespace) resolves to
 * `undefined` — i.e. NULL — rather than a 400 or a stored empty string.
 * `jobs/library-call-number-dedup` keys its shelf slot on
 * `upper(coalesce(code_volume_letters, ''))`, so NULL and `''` address the
 * same slot either way; storing NULL keeps one spelling of it.
 *
 * The bound counts code points, not UTF-16 units, for the reason spelled out
 * at `validateTextField`: `varchar(4)` is a CHARACTER limit, so a bare
 * `.length` over-rejects astral input Postgres would store happily.
 */
const validateCodeVolumeLetters = (code_volume_letters: unknown): string | undefined => {
  if (typeof code_volume_letters !== 'string') {
    throw new WxycError('code_volume_letters must be a string', 400);
  }
  const trimmed = code_volume_letters.trim();
  if (codePointLength(trimmed) > MAX_CODE_VOLUME_LETTERS_LENGTH) {
    throw new WxycError(`code_volume_letters must be ${MAX_CODE_VOLUME_LETTERS_LENGTH} characters or fewer`, 400);
  }
  return trimmed || undefined;
};

/**
 * Resolve the `(label_id, label)` pair `POST /library` writes, given a body
 * carrying label text, a `label_id`, or both (BS#2410, rotation-import plan
 * D5).
 *
 * `library.label` is denormalized alongside the `labels` FK, so both halves
 * have to come out of this together. With a `label_id` the name is re-fetched
 * server-side rather than trusted from the body — the same rationale as
 * `addAlbum`'s canonical `artist_name` re-fetch — and `createLabel` is
 * skipped, so the import screen carrying a rotation row's `label_id` cannot
 * mint a near-duplicate labels row. A `label_id` that resolves to nothing is a
 * 400 with the wording `updateAlbum` already uses, not the PG 23503 -> 500 it
 * would otherwise become.
 *
 * Explicit label text still wins for the denormalized column when both are
 * sent — the same precedence `updateAlbum` applies in
 * `trimmedLabel ?? labelRow.label_name`, but spelled `||` rather than `??`
 * because this path still admits `''` (PATCH rejects it outright), and an
 * empty label must not beat the name just resolved from the FK.
 *
 * The label-text-only branch is byte-for-byte the pre-BS#2410 path, including
 * its treatment of `''` — which the widened required-set guard still admits,
 * and which still skips the upsert rather than minting an empty `labels` row.
 * Tightening that is `PATCH /library/:id`'s "clear the label by sending
 * label_id: null" rule and is not this ticket's to change.
 *
 * **`label_id: null` means absent here, not "clear the label."** The gate is
 * `!= null`, not `!== undefined`: `{ label_id: selected?.id ?? null }` is what
 * dj-site#1161's Import-to-Library combo-box emits when the operator types a
 * new label name instead of picking an existing row, and an `=== undefined`
 * test takes the has-a-label_id branch on it and 400s `Number.isInteger(null)`
 * — the defect `1cebb1da` (BS#2164) fixed on `addRotation`. `null` cannot mean
 * "clear" on a create, because there is nothing yet to clear; giving it the
 * PATCH meaning would leave POST and PATCH permanently disagreeing about one
 * field name. The required-set guard in `addAlbum` uses the same `!= null`, so
 * a `null` with no label text draws the "Missing Parameters" 400 rather than
 * the malformed-integer one.
 */
const resolveNewAlbumLabel = async (
  // Narrowed to the two fields this function actually reads (BS#2474): both
  // `addAlbum`'s `NewAlbumRequest` and `POST /library/filings`'s
  // `FilingReleaseBody` carry them, and widening the parameter to their
  // common shape is what lets both call sites share this resolver.
  body: { label?: string; label_id?: number | null },
  // `tx` (BS#2474): `createLabel`'s upsert is a real write, so the composite
  // must run this resolver INSIDE its transaction — on the bare pool, a
  // later-stage rollback would strand the freshly minted `labels` row while
  // everything else vanishes, breaking the endpoint's all-or-nothing
  // contract with exactly the near-duplicate-labels outcome the `label_id`
  // path above exists to prevent. `addAlbum` keeps calling without one.
  tx?: libraryService.DbTransaction
): Promise<{ label_id: number | undefined; label: string | undefined }> => {
  if (body.label_id != null) {
    if (!Number.isInteger(body.label_id) || body.label_id < 1) {
      throw new WxycError('label_id must be a positive integer', 400);
    }
    const labelRow = await labelsService.getLabelById(body.label_id, tx);
    if (!labelRow) {
      throw new WxycError('label_id does not reference an existing label', 400);
    }
    return { label_id: labelRow.id, label: body.label || labelRow.label_name };
  }

  if (!body.label) {
    return { label_id: undefined, label: body.label };
  }

  const resolvedLabel = await labelsService.createLabel(body.label, undefined, tx);
  return { label_id: resolvedLabel.id, label: body.label };
};

//Check if artist exists.
//Add new album to library
export const addAlbum: RequestHandler = async (req: Request<object, object, NewAlbumRequest>, res) => {
  const { body } = req;
  if (
    body.album_title === undefined ||
    // BS#2410 / plan D5: `label_id` satisfies the label requirement on its
    // own. This guard ran before any label resolution and rejected every
    // label-less body outright, so widening it here — not adding a branch
    // further down — is what lets a `label_id`-only import through at all.
    // `!= null` because an explicit `label_id: null` is absent, not supplied
    // (see `resolveNewAlbumLabel`): both sites have to agree, or a label-less
    // `{ label_id: null }` clears this guard and then 400s further down naming
    // `label_id` rather than the label it is actually missing.
    (body.label === undefined && body.label_id == null) ||
    body.genre_id === undefined ||
    body.format_id === undefined ||
    (body.artist_name === undefined && body.artist_id === undefined)
  ) {
    throw new WxycError(
      'Missing Parameters: album_title, label or label_id, genre_id, format_id, artist_name, or artist_id',
      400
    );
  }
  // '' satisfies the NOT NULL constraint but is never a valid title — reject
  // before it lands in the catalog (PR #1154 review issue 8).
  if (typeof body.album_title !== 'string' || body.album_title.trim() === '') {
    throw new WxycError('album_title must be a non-empty string', 400);
  }

  // BS#2410: validate the operator-supplied call code before any of the
  // artist/label resolution below, so a bad value costs no queries and can't
  // strand an orphan `labels` row on the failure path (#1550's rationale,
  // applied to the POST side).
  const code_volume_letters =
    body.code_volume_letters === undefined ? undefined : validateCodeVolumeLetters(body.code_volume_letters);
  const supplied_code_number = body.code_number === undefined ? undefined : validateCodeNumber(body.code_number);

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

  // Resolve label text to label_id via upsert, or label_id to the
  // denormalized name (BS#2410 / plan D5).
  const { label_id, label } = await resolveNewAlbumLabel(body);

  const new_album: NewAlbum = {
    artist_id: artist_id,
    artist_name: canonical_artist_name,
    genre_id: body.genre_id,
    format_id: body.format_id,
    album_title: body.album_title,
    label: label,
    label_id: label_id,
    // BS#2410: an omitted code_number still takes MAX+1 for the artist, which
    // is byte-for-byte the pre-2410 behavior.
    code_number: supplied_code_number ?? (await libraryService.generateAlbumCodeNumber(artist_id)),
    code_volume_letters: code_volume_letters,
    alternate_artist_name: body.alternate_artist_name,
    disc_quantity: body.disc_quantity,
  };

  const inserted_album: Album = await libraryService.insertAlbum(new_album);

  const enriched_album = await enrichNewAlbum(
    inserted_album,
    body.alternate_artist_name || body.artist_name || '',
    canonical_artist_name,
    body.album_title
  );

  res.status(201).json(enriched_album);
};

/**
 * `addAlbum`'s post-insert LML enrichment (streaming + artwork + telemetry +
 * fire-and-forget canonical entity), extracted so `POST /library/filings`'s
 * release arm runs the SAME pipeline the standalone add runs — a record
 * filed through the composite must not silently come out poorer (no
 * `on_streaming`, no `artwork_url`, no canonical entity) than the identical
 * record filed through `POST /library` (BS#2474). The row is already
 * committed when this runs — the composite calls it strictly AFTER its
 * transaction commits, never inside it (these are network hops) — and every
 * branch is best-effort: enrichment failure never fails the insert.
 *
 * Returns the album to respond with: `updateOnStreaming`'s refreshed row
 * when the streaming verdict persisted, with `artwork_url` patched on when
 * the artwork write landed.
 */
async function enrichNewAlbum(
  insertedAlbum: Album,
  displayArtistName: string,
  canonicalArtistName: string | null,
  albumTitle: string
): Promise<Album> {
  if (!isLmlConfigured()) return insertedAlbum;

  let album = insertedAlbum;
  const [streamingResult, artworkResult] = await Promise.allSettled([
    checkStreamingAvailability(displayArtistName, albumTitle, { caller: 'library-add-album-streaming' }),
    // BS#1294 (1c): pre-read the just-inserted row's discogs_unavailable
    // flag. On the fresh-insert path this is always false (the row was
    // just created with the schema default — BS#1281 / plan §3), so the
    // gate is a no-op here. Wired for consistency with the other three
    // lookupMetadata callers, and for the day addAlbum gains a dedup/
    // upsert path that could re-touch an already-flagged row.
    lmlLookupCoordinator.lookup(displayArtistName, albumTitle, undefined, {
      caller: 'library-add-album',
      warm_cache: true,
      requireSearchType: 'direct',
      discogsUnavailable: album.discogs_unavailable,
    }),
  ]);

  if (streamingResult.status === 'fulfilled' && streamingResult.value.on_streaming !== null) {
    try {
      album = await libraryService.updateOnStreaming(album.id, streamingResult.value.on_streaming);
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
        distinctId: String(album.id),
        event: 'streaming_check_partial_error',
        properties: {
          album_id: album.id,
          artist: displayArtistName,
          title: albumTitle,
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
        await libraryService.updateArtworkUrl(album.id, artworkUrl);
        (album as Record<string, unknown>).artwork_url = artworkUrl;
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
  fireAndForgetCanonicalEntity(album.id, canonicalArtistName, albumTitle);

  return album;
}

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
  code_number?: number;
};

/**
 * Validate an operator-supplied artist `code_number` for `POST
 * /library/artists` (BS#2475). Bounded at `INT4_MAX`, not `INT2_MAX`: the
 * backing column is `genre_artist_crossreference.artist_genre_code`, a
 * Postgres `integer`, not `library.code_number`'s `smallint`.
 *
 * The floor is **0**, below the published `AddArtistRequest.code_number`
 * minimum of 1 (`wxyc-shared/api.yaml`), deliberately: the whole
 * Various-Artists surface is filed at `artist_genre_code = 0` — 68 rows in
 * the production clone (see `resolveArtistByCode` below, which accepts 0 for
 * the same reason) — and this endpoint accepted 0 unvalidated for its whole
 * life before BS#2475. The write path must not refuse a value the catalog
 * demonstrably holds and the read path resolves; the contract's floor is the
 * side that needs amending.
 */
const validateArtistCodeNumber = (code_number: unknown): number => {
  if (typeof code_number !== 'number' || !Number.isInteger(code_number) || code_number < 0 || code_number > INT4_MAX) {
    throw new WxycError(`code_number must be an integer between 0 and ${INT4_MAX}`, 400);
  }
  return code_number;
};

// `artists.code_letters` is `varchar(4)` (schema.ts). Same rationale as
// `MAX_CODE_VOLUME_LETTERS_LENGTH` above: reject over-length input as a named
// 400 instead of letting it reach the INSERT as PG 22001 -> an opaque 500
// plus a Sentry event for routine operator input.
const MAX_ARTIST_CODE_LETTERS_LENGTH = 4;

/**
 * Validate `code_letters` for the artist-create paths (`POST /library/artists`
 * and `POST /library/filings`' create arm) and return the NFC form every read
 * and write below must key on (see `addArtist`'s normalization comment).
 *
 * The bound counts code points of the NFC form — the composition that is
 * actually stored — not UTF-16 units of the raw input, per
 * `validateCodeVolumeLetters`'s rationale for the sibling `varchar(4)`
 * column. No trim and no case fold, deliberately: the artist card paths
 * only ever NFC-normalize (`insertArtistWithGenreCrossreference`), and
 * validation must not admit-by-rewriting a value the write path would then
 * store differently. Non-string input is caught here too — `.normalize` on
 * a non-string is a TypeError -> 500 otherwise.
 */
const validateArtistCodeLetters = (code_letters: unknown): string => {
  if (typeof code_letters !== 'string') {
    throw new WxycError('code_letters must be a string', 400);
  }
  const normalized = code_letters.normalize('NFC');
  if (codePointLength(normalized) > MAX_ARTIST_CODE_LETTERS_LENGTH) {
    throw new WxycError(`code_letters must be ${MAX_ARTIST_CODE_LETTERS_LENGTH} characters or fewer`, 400);
  }
  return normalized;
};

/**
 * Server-assigns the next `code_number` in the `(genre_id, code_letters)`
 * bucket via `generateArtistNumber` — the same generator behind the
 * `peekArtistNumber` preview route, NOT `generateAlbumCodeNumber`, which is
 * the unrelated per-artist release number.
 *
 * Bound-checked before any write: the generator returns bucket-MAX + 1, and
 * the supplied arm's ceiling is an *inclusive* `INT4_MAX`, so a bucket whose
 * top row sits at exactly `INT4_MAX` would otherwise assign a number the
 * `integer` crossreference column cannot hold and fail only at insert time
 * (SQLSTATE 22003). The 409 carries a `code` discriminant so a client can
 * tell "no number left to assign" from the pre-check's "that number is
 * taken".
 *
 * No collision check here: the caller's own `getArtistByCode` pre-check is
 * the collision detector, and re-invoking this helper on a pre-check hit is
 * the whole retry — see the recompute branch in `addArtist` below.
 */
const assignArtistCodeNumber = async (code_letters: string, genre_id: number): Promise<number> => {
  const code_number = await libraryService.generateArtistNumber(code_letters, genre_id);
  if (code_number > INT4_MAX) {
    throw new WxycError(
      `No assignable code_number left for those code letters in that genre: the next number would exceed ${INT4_MAX}. Supply an explicit unused code_number instead.`,
      409,
      { code: 'artist_code_number_exhausted' }
    );
  }
  return code_number;
};

export const addArtist: RequestHandler = async (req: Request<object, object, NewArtistRequest>, res) => {
  const { body } = req;
  if (body.artist_name === undefined || body.code_letters === undefined || body.genre_id === undefined) {
    throw new WxycError('Missing Request Parameters: artist_name, code_letters, or genre_id', 400);
  }

  // NFC once, up front, and every read below keys on it: the generator and
  // both code pre-checks match `artists.code_letters` byte-for-byte, but
  // `insertArtistWithGenreCrossreference` stores the NFC form (BS#1897). An
  // NFD-composed `code_letters` would otherwise read an empty bucket, assign
  // 1 into a shelf that already holds rows, and file the row — stored NFC —
  // into exactly the collision the pre-check exists to prevent. The
  // validator (BS#2474) folds the normalize in, adding the varchar(4) length
  // bound as a named 400.
  const code_letters = validateArtistCodeLetters(body.code_letters);

  // Omitted or JSON-`null` `code_number` (BS#2475): server-assigns it below.
  // `!= null` rather than a falsy check because `code_number: 0` is a real
  // filing (the V/A shelves — see `validateArtistCodeNumber` above) and must
  // take the supplied arm. Supplied: an MD's deliberate choice, validated but
  // never rewritten -- a collision on that arm is reported as a straight 409,
  // not silently recomputed.
  const supplied = body.code_number != null;
  let code_number = supplied
    ? validateArtistCodeNumber(body.code_number)
    : await assignArtistCodeNumber(code_letters, body.genre_id);

  // The code-triple check runs first and wins a collision on both axes: a
  // taken code blocks the write outright no matter what name accompanies it,
  // so it is reported over a name conflict the caller could otherwise route
  // around by picking a free code. Keeping it first makes that precedence a
  // byproduct of ordering rather than a runtime branch, so it can't drift out
  // of sync. `reason` gives this 409 the same positive discriminant as the
  // name-conflict branch below, so a client never has to infer "code
  // conflict" from the absence of a field.
  let existingArtist = await libraryService.getArtistByCode(code_letters, body.genre_id, code_number);
  // Server-assigned arm only: a pre-check hit means a concurrent create took
  // the generated number between generate and check, so recompute once
  // against the now-current MAX and re-check. The pre-check doubling as the
  // retry trigger is the whole retry: the BS#2475 precondition audit found
  // the unique constraint as filed impossible (it spans `artists` and
  // `genre_artist_crossreference`) and the ETL exposure real (`ensureArtist`'s
  // dedup miss would turn a unique index into a whole-run abort, the BS#2033
  // hazard class), so no index backs this triple and there is no 23505 to
  // catch — whatever conflict remains after one recompute is reported below.
  // Residual race accepted on the same single-librarian grounds as BS#2410's
  // release-side decision.
  if (existingArtist && !supplied) {
    code_number = await assignArtistCodeNumber(code_letters, body.genre_id);
    existingArtist = await libraryService.getArtistByCode(code_letters, body.genre_id, code_number);
  }
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
    code_letters,
  };

  const response: Artist = await libraryService.insertArtistWithGenreCrossreference(
    new_artist,
    body.genre_id,
    code_number
  );
  res.status(201).json({
    ...libraryService.serializeArtist(response),
    code_number,
    genre_id: body.genre_id,
  });
};

type SearchArtistsInGenreQuery = {
  genre_id?: string;
  q?: string;
  limit?: string;
};

/**
 * `GET /library/artists/search` — prefix-search catalogued artists.
 *
 * `genre_id` is optional (BS#2410). Given, it scopes the search to that
 * genre's memberships, exactly as before; omitted, the search is library-wide,
 * which is what the rotation import screen's duplicate-artist guard needs —
 * "is this artist already filed anywhere?" has no genre to ask it in. Either
 * way the response is one row per (artist, genre) membership, each carrying
 * its own genre.
 *
 * Permission tier stays `catalog: ['write']` (library.route.ts): dropping the
 * filter widens the query, not the audience.
 */
export const searchArtistsInGenre: RequestHandler = async (
  req: Request<object, object, object, SearchArtistsInGenreQuery>,
  res
) => {
  // Only an absent `genre_id` means "library-wide". A present-but-empty
  // `?genre_id=` is a client bug, not an omission — `Number('')` is 0, so it
  // keeps the 400 it has always had rather than silently widening the search.
  // A repeated key arrives as string[] and `Number()` makes it NaN, which the
  // same guard rejects.
  const genreId = req.query.genre_id === undefined ? null : Number(req.query.genre_id);
  if (genreId !== null && (!Number.isInteger(genreId) || genreId < 1)) {
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
  // Only reachable when a genre was given: with none there is no id to be
  // stale, and a 404 would report "genre not found" for a search that never
  // named one.
  if (genreId !== null && !(await libraryService.genreExists(genreId))) {
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
  limit?: string;
  offset?: string;
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
  // Blank folds into the range check rather than throwing the identical
  // message from its own branch: `Number('')` and `Number(' ')` are both 0,
  // which would sail through `Number.isInteger` as a legitimate zero now that
  // 0 is a valid `code_number`. Coercing blank to NaN first makes one
  // comparison cover both cases.
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < min || value > INT4_MAX) {
    throw new WxycError(`Invalid ${name}: must be an integer between ${min} and ${INT4_MAX}`, 400);
  }
  return value;
};

/**
 * `artists.code_letters` is a Postgres `varchar(4)` column (`shared/database/
 * src/schema.ts:439`) storing a trimmed, upper-case, ASCII value -- every one
 * of the 24,078 rows in the production clone matches that shape, with `/` the
 * only non-alphanumeric character in use (the `V/A` filing). Neither writer
 * enforces that shape, though: `insertArtistWithGenreCrossreference` (`library.service.ts`) only
 * NFC-normalizes -- no trim, no upper-case -- and the tubafrenzy `library-etl`
 * job writes `codeLetters ?? '??'` verbatim (`jobs/library-etl/job.ts:441`),
 * so a row filed non-canonically can already be sitting in the table.
 *
 * `.trim().toUpperCase()` is not a safe repair for that gap: it is neither
 * length- nor charset-preserving for non-ASCII input
 * (`'ß'.toUpperCase() === 'SS'`, `'ı'.toUpperCase() === 'I'`), so silently
 * folding an out-of-domain value could match a DIFFERENT real artist's shelf
 * code with no precondition that the input was canonical to begin with. (An
 * earlier version of this comment claimed normalizing "can never turn a real
 * hit into a miss" -- true only of the measured production snapshot, not of
 * every possible input, which is exactly the gap this validation closes.)
 *
 * Reject anything outside the column's real domain instead: ASCII letters,
 * digits, or `/`, 1-4 characters. A 5+ character value can never match a row
 * either (BS#2149 review finding 2) -- unvalidated, it used to fall through
 * to the 404 branch, whose own docs called that "safe to create an artist
 * under it," right up until the artist insert's `varchar(4)` column threw
 * SQLSTATE 22001 on the follow-up write and this route's sibling inherited a
 * generic 500 plus a Sentry event. Restricted to this input charset,
 * `.toUpperCase()` is always a deterministic, length- and charset-preserving
 * map (`a`-`z` -> `A`-`Z`; digits and `/` are fixed points), so the fold
 * hazard above cannot occur once this check has passed.
 */
const CANONICAL_CODE_LETTERS_PATTERN = /^[A-Za-z0-9/]{1,4}$/;

const validateCanonicalCodeLetters = (raw: string): string => {
  const trimmed = raw.trim();
  if (!CANONICAL_CODE_LETTERS_PATTERN.test(trimmed)) {
    throw new WxycError(
      "Invalid code_letters: must be 1-4 characters from A-Z, 0-9, or '/' (artists.code_letters is varchar(4))",
      400
    );
  }
  return trimmed.toUpperCase();
};

/**
 * Upper bound AND default for `?limit=` on the bucket browse — owned by the
 * service, since the cap is a property of the query rather than of this route.
 * Re-exported through the namespace import so the 400 message and the query
 * can never disagree about the number.
 */
const { ARTIST_CODE_BUCKET_MAX_LIMIT } = libraryService;

type ArtistCodePageWindow = { limit?: number; offset?: number };

/**
 * Parses `?limit=`/`?offset=` for `GET /library/artists/by-code`.
 *
 * Called for BOTH arms, before the dispatch on `code_number`, so that whether
 * a malformed page window is refused does not depend on an unrelated
 * parameter. Read only by the browse arm — the fully-specified lookup returns
 * every owner of one exact code, a list the triple itself bounds, so there is
 * nothing there to page. Validating it anyway is the cheaper half of the
 * trade: `?limit=abc` is a 400 either way, rather than a 400 when browsing and
 * a silent 200 when not.
 */
const parseArtistCodePageWindow = (query: ArtistByCodeQuery): ArtistCodePageWindow => {
  const limit = parseNonNegativeInt(query.limit);
  if (limit === null || (limit !== undefined && (limit < 1 || limit > ARTIST_CODE_BUCKET_MAX_LIMIT))) {
    throw new WxycError(
      `Invalid Parameter: limit must be an integer between 1 and ${ARTIST_CODE_BUCKET_MAX_LIMIT}`,
      400
    );
  }

  const offset = parseNonNegativeInt(query.offset);
  if (offset === null) {
    throw new WxycError('Invalid Parameter: offset must be a non-negative integer', 400);
  }

  return { limit, offset };
};

/**
 * The number-less arm of `GET /library/artists/by-code` (BS#2489): browse the
 * whole `(genre_id, code_letters)` bucket.
 *
 * Split out rather than inlined as an `if` arm because the two branches share
 * only their coordinates: this one parses a different parameter set, has its
 * own paging, and answers an empty result with a 200 where the fully-specified
 * branch answers a 404.
 */
async function browseArtistCodeBucket(
  page: ArtistCodePageWindow,
  codeLetters: string,
  genreId: number,
  res: Response
): Promise<void> {
  const members = await libraryService.browseArtistsInCodeBucket(codeLetters, genreId, page);

  // Same round-trip discipline as the fully-specified branch: a non-empty
  // bucket proves the genre exists, so `genreExists` is only probed to explain
  // an empty one -- and only to separate a stale genre dropdown from a genuinely
  // unused set of call letters, which is a 200 rather than a 404.
  if (members.length === 0 && !(await libraryService.genreExists(genreId))) {
    res.status(404).json({ message: 'Genre not found', reason: 'genre_not_found' });
    return;
  }

  res.status(200).json({
    // `code_number` is read from the ROW, not echoed from the request the way
    // the fully-specified branch echoes its parsed parameter. It varies across
    // a browse and is the whole point of the response; copying that `.map()`
    // would emit one number on every row and still typecheck.
    artists: members.map((member) => ({
      id: member.artist_id,
      artist_name: member.artist_name,
      code_letters: member.code_letters,
      code_number: member.code_number,
      genre_id: genreId,
    })),
  });
}

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
 * `artist_genre_code = 0` — 68 such rows in the production clone, 66 of them
 * `code_letters = 'V/A'` and the other two a `VA`-spelled "V/A" and an `UNK`
 * "Unknown", both in genre 6. Neither sibling route imposes a higher floor:
 * `addArtist` validates at the same 0 floor (`validateArtistCodeNumber`) and
 * `peekArtistNumber` uses
 * `Number.isFinite`. A `< 1` floor here made the one filing class that most
 * needs code-first resolution (compilations have no artist name to search by)
 * the one class this route could not answer.
 *
 * Two 404s, discriminated by `reason` rather than by prose the way `addArtist`
 * above discriminates its two 409s: `genre_not_found` means the client's genre
 * dropdown is stale, `code_not_assigned` means the code is free to create. A
 * client that has to string-match `message` to tell those apart cannot act on
 * either.
 *
 * BS#2489: `code_number` is OPTIONAL. Omit it and this browses the whole
 * `(genre_id, code_letters)` bucket instead — the blank-call-number path
 * `chooseLibraryCodeOrArtist.jsp` fell through to `multipleArtistsDisplay.jsp`
 * for, which the librarian uses to check an assigned number against the shelf
 * and to spot gaps in an occupied range. Extending this route rather than
 * adding a literal `/artists/browse` was deliberate: the two branches answer
 * the same question at two levels of specificity, and a new literal would have
 * to be ordered ahead of `GET /artists/:id` to avoid being swallowed.
 *
 * The browse's outcomes deliberately differ from the fully-specified branch's
 * in one place. An empty bucket under a known genre is a **200 with an empty
 * list**, not a `code_not_assigned` 404: the librarian browsing unused letters
 * is a normal outcome, and `code_not_assigned` asserts something about a code
 * the request never named. `genre_not_found` is unchanged and still a 404, so
 * a client can still tell a stale genre dropdown from an empty shelf — a
 * distinction dj-site#1506 relies on to keep an outage from reading as an
 * empty bucket.
 */
export const resolveArtistByCode: RequestHandler = async (
  req: Request<object, object, object, ArtistByCodeQuery>,
  res
) => {
  const { query } = req;
  // Name only the parameters actually missing. A fixed string listing both
  // would satisfy any "the error mentions code_letters" assertion even when the
  // handler refused on a different parameter, which is exactly the blind spot
  // the BS#2149 review found in this route's first test. `code_number` is not
  // in this list (BS#2489) — absent, it selects the browse.
  const missing = (['genre_id', 'code_letters'] as const).filter((name) => query[name] === undefined);
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

  // Validate against the column's real domain, then trim + upper-case -- see
  // `validateCanonicalCodeLetters` above for why a bare `.trim().toUpperCase()`
  // is not a safe normalization on its own. (The sibling write path,
  // `addArtist`, only NFC-normalizes -- no trim, no upper-case; widening its
  // pre-check to this fold is a separate change, deliberately not made here
  // because it alters an existing route's 409 behavior.)
  const codeLetters = validateCanonicalCodeLetters(query.code_letters);

  // Parsed for both arms — see `parseArtistCodePageWindow`. Placed after the
  // genre/letters validation so those refusals keep precedence and their
  // messages are unchanged.
  const page = parseArtistCodePageWindow(query);

  // Only an ABSENT `code_number` browses. A present-but-empty `?code_number=`
  // stays a 400, the same reading `searchArtistsInGenre` gives `?genre_id=`:
  // the client meant to send a number and sent nothing, which is a bug rather
  // than an omission, and `Number('')` is 0 — a legitimate V/A filing — so
  // silently browsing would also hide it.
  if (query.code_number === undefined) {
    await browseArtistCodeBucket(page, codeLetters, genreId, res);
    return;
  }

  // Lower bound 0, not 1 — see the V/A note in this function's doc comment.
  const codeNumber = parseCodeQueryInt(query.code_number, 'code_number', 0);

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
      code_letters: owner.code_letters,
      code_number: codeNumber,
      genre_id: genreId,
    })),
  });
};

// The only spelling of a path id we accept: bare decimal digits, no sign, no
// leading zero, no whitespace, no exponent, no radix prefix, no fraction.
// `Number()` happily accepts '1e21', '0x2a', ' 42 ', '42.0', '+42' and '007',
// each of which would alias a distinct URL onto one resource (and, for the
// first two, onto ids no `serial` column can hold).
const CANONICAL_ID_PATTERN = /^[1-9][0-9]*$/;

/**
 * Parse a positive int4 surrogate key out of a path parameter, or throw the
 * 400 that keeps a malformed URL from reaching Postgres.
 *
 * ONE implementation deliberately shared by `parseArtistId`/`parseAlbumId`:
 * the two were verbatim clones, and a hardening fix applied to one copy is a
 * hole left open in the other.
 */
const parseResourceId = (rawId: string, resource: string): number => {
  if (typeof rawId !== 'string' || !CANONICAL_ID_PATTERN.test(rawId)) {
    throw new WxycError(`Invalid ${resource} ID`, 400);
  }
  const id = Number(rawId);
  if (id > INT4_MAX) {
    throw new WxycError(`Invalid ${resource} ID`, 400);
  }
  return id;
};

const parseArtistId = (rawId: string): number => parseResourceId(rawId, 'artist');

/**
 * GET /library/artists/:id -- BS#2156 artist-card lookup: the field set
 * `/wxycdb`'s `artistCardModify.jsp` displays. Registered after the literal
 * `/artists/search` and `/artists/peek-code` routes -- see the route-ordering
 * comment in library.route.ts.
 */
export const getArtistCard: RequestHandler<{ id: string }> = async (req, res) => {
  const artistId = parseArtistId(req.params.id);
  const artist = await libraryService.getArtistCardById(artistId);
  if (!artist) {
    throw new WxycError('Artist not found', 404);
  }
  res.status(200).json(artist);
};

type UpdateArtistRequest = {
  alphabetical_name?: string;
  // `/wxycdb`'s `artistCardModify.jsp:41-64` posts five fields --
  // `ArtistAdminServlet.java:196-206` applies all five -- but only
  // `alphabetical_name` has a write path here. The other four are declared
  // (not just left unread) so `ARTIST_NO_COLUMN_FIELDS` below can reject a
  // client that sends one of them with a precise 400 instead of silently
  // dropping it. `artist_name` is declared `unknown`, not `string`: it once
  // had a write path on this endpoint, pulled before ship -- see
  // `ARTIST_NO_COLUMN_FIELD_OWNERS.artist_name` and the doc comment on
  // `updateArtistCard`.
  artist_name?: unknown;
  genre_id?: unknown;
  code_letters?: unknown;
  code_artist_number?: unknown;
};

const MAX_ARTIST_TEXT_LENGTH = 128;

const UPDATABLE_ARTIST_FIELDS = ['alphabetical_name'] as const;

const ARTIST_NO_COLUMN_FIELDS = ['artist_name', 'genre_id', 'code_letters', 'code_artist_number'] as const;

// Why each field has no write path on THIS ENDPOINT today -- verified
// against the full write surface, not asserted. `genre_id`/`code_letters`/
// `code_artist_number` have no write path anywhere: `genre_artist_crossreference`
// (the row that carries `genre_id` and `code_artist_number`, i.e.
// `artist_genre_code`) is only ever `.insert()`ed -- by `POST /library/artists`
// -- never `.update()`d, and `artists.code_letters` is likewise write-once.
// `artist_name` is different in kind: `updateArtistInDB` still accepts it
// (kept, not dead code -- the follow-up ticket below re-enables it by
// re-adding it to `UPDATABLE_ARTIST_FIELDS`), but this endpoint deliberately
// never passes it through. See the doc comment on `updateArtistCard`.
const ARTIST_NO_COLUMN_FIELD_OWNERS: Record<(typeof ARTIST_NO_COLUMN_FIELDS)[number], string> = {
  artist_name:
    "not editable while the catalog is tubafrenzy-canonical: jobs/library-etl is a live 30-minute cron whose ensureArtist matches by fold_artist_name and never UPDATEs artists, so a rename here would move the match key, get silently duplicated on the next ETL pass, and be reverted by that duplicate row's release upsert -- tracked as a follow-up ticket gated on library-etl becoming job-type: one-shot",
  genre_id:
    'no write path: genre_artist_crossreference.genre_id is set once by POST /library/artists and is never UPDATEd by any endpoint',
  code_letters:
    'no write path: artists.code_letters is set once by POST /library/artists and is never UPDATEd by any endpoint',
  code_artist_number:
    'no write path: genre_artist_crossreference.artist_genre_code is set once by POST /library/artists and is never UPDATEd by any endpoint',
};

const NO_ARTIST_FIELDS_MESSAGE = `Bad Request: provide at least one of ${UPDATABLE_ARTIST_FIELDS.join(', ')}`;

/**
 * PATCH /library/artists/:id -- allowlists exactly one of the five
 * `/wxycdb` `modifyArtist` form fields, `alphabetical_name` (BS#2156). The
 * other four JSP fields (`artist_name`, `genre_id`, `code_letters`,
 * `code_artist_number`) are REJECTED with a 400 naming why
 * (`ARTIST_NO_COLUMN_FIELD_OWNERS`), not silently dropped -- unlike the
 * `pickAddRotationFields` / `pickUpdateEntryFields` allowlist convention
 * elsewhere in this repo, which does drop silently. The difference: those
 * allowlists drop server-derived columns a client should never control;
 * these four are real edits a librarian can make on the legacy JSP, so
 * silently accepting-and-ignoring them would look like a successful edit
 * that wasn't.
 *
 * `artist_name` was allowlisted alongside `alphabetical_name` in an earlier
 * revision of this endpoint and was pulled before ship (review finding,
 * verified end to end): `artists`/`library` are still tubafrenzy-canonical,
 * and `jobs/library-etl` -- on a live 30-minute cron (its `package.json` has
 * no `job-type` key, and `deploy-base.yml` defaults that to `"cron"`; its
 * siblings `flowsheet-etl` and `rotation-etl` were both flipped to
 * `"job-type": "one-shot"` and this one was not) -- `ensureArtist`s by
 * finding-or-inserting on `fold_artist_name` and never UPDATEs `artists`. A
 * rename here moves the match key out from under that probe: the next ETL
 * pass misses, inserts a duplicate artist that lands the SAME shelf code
 * without violating anything (`genre_artist_crossreference` is unique only
 * on `(artist_id, genre_id)`), and that duplicate's release upsert repoints
 * the library row and reverts the name (`LEGACY_SOURCED_LIBRARY_COLUMNS`
 * carries both `artist_id` and `artist_name`) -- silently, no crash.
 * `alphabetical_name` is safe: it is not part of the ETL's match key and the
 * ETL never updates `artists` at all. Re-enabling `artist_name` renaming is
 * its own ticket, blocked on `library-etl` becoming `job-type: one-shot`.
 */
export const updateArtistCard: RequestHandler<{ id: string }, unknown, UpdateArtistRequest> = async (req, res) => {
  const artistId = parseArtistId(req.params.id);

  // `app.ts` mounts a bare `express.json()`, and body-parser 2.x leaves
  // `req.body` UNDEFINED for a body-less or non-JSON-typed request — Express 5
  // no longer defaults it to `{}`. Dereferencing it below would be a
  // TypeError, i.e. a 500 on the single most likely smoke-test request
  // (`curl -X PATCH` with no body). Normalize to `{}` and reject a non-object
  // JSON document (`"x"`, `[]`, `3`) so the shape checks that follow hold.
  const body: UpdateArtistRequest = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    // Names the actual failure. Answering "provide at least one of
    // alphabetical_name" to `curl -X PATCH -d '[]'` points the caller at the
    // wrong problem: the body is not a JSON object at all, so which fields it
    // should have carried is not yet the question.
    throw new WxycError('Bad Request: body must be a JSON object', 400);
  }

  // Reject a client that sends a field this endpoint cannot write, rather
  // than silently dropping it (BS#2156 review). Precedes the has-any-field
  // check below, matching the ROTATION_NO_COLUMN_FIELDS ordering PATCH
  // /library/rotation/:id uses (WXYC/Backend-Service#2165).
  const rejectedFields = ARTIST_NO_COLUMN_FIELDS.filter((field) => field in body);
  if (rejectedFields.length > 0) {
    const detail = rejectedFields.map((field) => `${field} (${ARTIST_NO_COLUMN_FIELD_OWNERS[field]})`).join(', ');
    throw new WxycError(`Bad Request: no write path exists for ${detail}`, 400);
  }

  // Request-shape 400s precede the existence 404, matching updateAlbum. The
  // reverse order answers 404 for an unknown artist and 500 for a real one on
  // the very same malformed request.
  if (!UPDATABLE_ARTIST_FIELDS.some((field) => field in body)) {
    throw new WxycError(NO_ARTIST_FIELDS_MESSAGE, 400);
  }

  // Resolve the artist before any side effects -- same ordering rationale as
  // updateAlbum's existence-before-write fix (issue 10 there).
  const existing = await libraryService.getArtistCardById(artistId);
  if (!existing) {
    throw new WxycError('Artist not found', 404);
  }

  const updates: libraryService.UpdateArtistRow = {};
  if (body.alphabetical_name !== undefined) {
    if (typeof body.alphabetical_name !== 'string') {
      throw new WxycError('alphabetical_name must be a non-empty string', 400);
    }
    // Normalize to NFC BEFORE trimming/measuring, matching what
    // `updateArtistInDB` stores (BS#1897) -- NFC is NOT length-non-increasing
    // (e.g. `'क़'.normalize('NFC')` is 2 UTF-16 units). Measuring the raw
    // `trim()`ed input let a 128-char string of composition-exclusion
    // codepoints pass this 400, reach Postgres at a longer NFC length, and
    // trip SQLSTATE 22001 ("value too long") -> 500 where the documented
    // answer is 400 (review finding N2). Normalize first, measure second,
    // store the normalized value, so the length checked here is the length
    // that actually reaches the column.
    const trimmed = body.alphabetical_name.normalize('NFC').trim();
    if (trimmed === '') {
      throw new WxycError('alphabetical_name must be a non-empty string', 400);
    }
    // Code points, not UTF-16 units -- `codePointLength`, not `.length`.
    // Postgres measures `varchar(128)` in characters, so a bare `.length`
    // counts every astral character (emoji, CJK Ext-B) twice and rejects
    // values PG would store happily. This file already carries
    // `codePointLength` for exactly that reason; measuring the wrong unit here
    // undercut the reject-over-truncate choice it was written to protect.
    if (codePointLength(trimmed) > MAX_ARTIST_TEXT_LENGTH) {
      throw new WxycError(`alphabetical_name must be ${MAX_ARTIST_TEXT_LENGTH} characters or fewer`, 400);
    }
    updates.alphabetical_name = trimmed;
  }

  // Short-circuit a no-op edit. `updateArtistInDB` always SETs
  // `last_modified = NOW()`, which fires `touch_library_watermark_from_artists`
  // (migration 0105, `FOR EACH STATEMENT` on `artists`) and advances the
  // catalog conditional-GET watermark -- forcing every iOS / dj-site poller to
  // re-download the full catalog for a write that changed nothing. That is the
  // same cost `updateAlbum`'s `effectiveChange` guard exists to avoid (#1555);
  // this path reaches it through a coarser, statement-level trigger on the
  // parent table. A librarian hitting Save on an unchanged card, or a dj-site
  // form resubmitting the same value, is the common case.
  const effectiveChange = (Object.keys(updates) as Array<keyof libraryService.UpdateArtistRow>).some(
    (key) => updates[key] !== existing[key as keyof typeof existing]
  );
  if (!effectiveChange) {
    res.status(200).json(existing);
    return;
  }

  const updated = await libraryService.updateArtistInDB(artistId, updates);
  if (!updated) {
    throw new WxycError('Artist not found', 404);
  }
  // Answer with the same card shape `GET /library/artists/:id` serves rather
  // than the bare `artists` RETURNING row, so a client that PATCHes and a
  // client that re-GETs the same URL see one field set (`artist_id`, not `id`).
  const refreshed = await libraryService.getArtistCardById(artistId);
  if (!refreshed) {
    throw new WxycError('Artist not found', 404);
  }
  res.status(200).json(refreshed);
};

/**
 * GET /library/artists/:id/releases -- BS#2156: the release table on
 * `/wxycdb`'s artist card (`getLibraryReleasesForArtist`).
 *
 * Offset-paginated (`page`/`limit`) in the shape `GET /library/query` uses --
 * reuses that endpoint's `DEFAULT_LIMIT`/`MAX_LIMIT` (50/100, declared below;
 * module-level consts are in scope regardless of declaration order) rather
 * than a second pair of identical constants under a new name. Unbounded,
 * this hands any `catalog:read` DJ every row an artist has — 3,107 of them
 * for artist 1087 ('Various Artists'), ~0.5-1 MB of JSON per repeatable
 * request.
 */
export const getArtistReleases: RequestHandler<
  { id: string },
  unknown,
  unknown,
  { page?: string; limit?: string }
> = async (req, res) => {
  const artistId = parseArtistId(req.params.id);

  // Shared with the two cross-reference listings (`parsePageParams`, declared
  // below); this endpoint's own inline copy accepted `?limit=7abc` as 7 and
  // `?page=99999999999999999999` as 1e20, which reached Postgres as an
  // `OFFSET` of `5e+21` and answered 500 instead of the documented 400.
  const { page, limit } = parsePageParams(req.query, DEFAULT_LIMIT, MAX_LIMIT);

  // Same existence predicate GET/PATCH /library/artists/:id use
  // (`getArtistCardById`'s INNER JOIN to `genre_artist_crossreference`), not
  // the plain `artists` lookup `getArtistNameById` did before -- an artist
  // row with no crossreference must 404 the same way here it already does on
  // the card and the PATCH, not silently 200 with an empty release page. Also
  // sidesteps the `!name` falsy-check trap: a legacy empty-string
  // `artist_name` would read as "missing" under that check even though the
  // row exists.
  if (!(await libraryService.getArtistCardById(artistId))) {
    throw new WxycError('Artist not found', 404);
  }
  const [releases, total] = await Promise.all([
    libraryService.getReleasesForArtist(artistId, page, limit),
    libraryService.countReleasesForArtist(artistId),
  ]);
  res.status(200).json({ artist_id: artistId, releases, total, page, totalPages: Math.ceil(total / limit) });
};

/**
 * GET /library/artists/:id/next-release-number — previews the release
 * `code_number` a `POST /library` would assign this artist, so the classic
 * add-release form can prepopulate an EDITABLE field with the authoritative
 * value instead of a client-side `max+1`. That client guess is unreliable
 * because `/artists/:id/releases` is paginated, and a wrong-but-valid call
 * number written onto a physical card is the expensive outcome this endpoint
 * exists to prevent.
 *
 * The value is `generateAlbumCodeNumber(artist_id)` — the SAME server-side
 * generator `addAlbum` and `createLibraryFiling` fall back to when `code_number`
 * is omitted (MAX(code_number)+1 for the artist, 1 when none) — so the preview
 * and the eventual write agree by construction. Pure read, no side effects.
 *
 * Mirrors the `/artists/peek-code` sibling: an internal `{ next_code_number }`
 * shape with no wxyc-shared contract schema, gated at `catalog: ['write']`
 * because both back the create flow. Existence is resolved through
 * `getArtistCardById`, the same 404 predicate GET/PATCH `/artists/:id` and
 * `/artists/:id/releases` use — so an unknown id (or an artist row with no
 * `genre_artist_crossreference`) 404s rather than previewing 1 as if the artist
 * existed with no releases. A malformed id is the named 400 from
 * `parseArtistId`, never a 500.
 */
export const peekArtistReleaseNumber: RequestHandler<{ id: string }> = async (req, res) => {
  const artistId = parseArtistId(req.params.id);
  if (!(await libraryService.getArtistCardById(artistId))) {
    throw new WxycError('Artist not found', 404);
  }
  const next_code_number = await libraryService.generateAlbumCodeNumber(artistId);
  res.status(200).json({ next_code_number });
};

/**
 * Page bounds for the two cross-reference collections.
 *
 * NOT `DEFAULT_LIMIT`/`MAX_LIMIT` (50/100), which the catalog-search endpoints
 * share. Those cap an open-ended catalog; these cap two frozen legacy tables
 * that hold 78 and 22 rows on prod (WXYC/wiki#89's 2026-08-11 measurement),
 * with `artist_crossreference` rising to at most 119 once
 * `scripts/audit/bs_2117_crossref_backfill.sql` has loaded the resolvable
 * pairs. A 100-row ceiling would make the artist collection permanently
 * un-fetchable in one request for the sake of a cap that never binds, so the
 * default is set above the whole frozen set and the maximum a few multiples
 * beyond it. The cap still exists rather than the endpoint serving the table
 * whole: `jobs/library-etl` keeps upserting into both on a 30-minute cron
 * until the tubafrenzy cutover, and the freeze is a decision, not something
 * the query can enforce.
 */
const CROSSREFERENCE_DEFAULT_LIMIT = 200;
const CROSSREFERENCE_MAX_LIMIT = 500;

type CrossReferenceQueryParams = { page?: string; limit?: string };

/**
 * Parse `?page=`/`?limit=` for an offset-paginated listing, against the
 * caller's own bounds. Shared by `getArtistReleases` and the two
 * cross-reference listings; `searchLibraryQueryEndpoint` keeps its inline copy
 * because it parses a wider parameter set in one pass.
 *
 * A repeated key is a 400 rather than a silent coercion: Express's `simple`
 * query parser yields `string[]` and `parseInt(['1','2'])` stringifies to
 * `'1,2'` and returns `1` (#1553).
 *
 * **Strict spelling, via `parseNonNegativeInt` rather than `parseInt`.** The
 * inline copies this replaced truncated instead of rejecting — `?limit=7abc`
 * was 7 and `?page=2.9` was 2 — so a caller got a silently different window
 * from the one it asked for, on a parameter `app.yaml` declares as
 * `type: integer`.
 *
 * **`page * limit` is bounded, and that is the bug fix rather than a
 * nicety.** Neither inline copy had a ceiling on `page`, so
 * `?page=99999999999999999999` parsed to `1e20`, and `page * limit` reached
 * the driver as the string `"5e+22"`, which Postgres rejects with `bigint out
 * of range` — a 500 plus a Sentry event for input the spec says is a 400.
 * `parseNonNegativeInt`'s `Number.isSafeInteger` check already rejects that
 * literal; the product check below closes the remaining band where each factor
 * is individually safe but the offset is not (e.g. `page` at
 * `MAX_SAFE_INTEGER / 2` with `limit` 500).
 */
const parsePageParams = (
  query: { page?: unknown; limit?: unknown },
  defaultLimit: number,
  maxLimit: number
): { page: number; limit: number } => {
  if (query.page !== undefined && typeof query.page !== 'string') {
    throw new WxycError('page must be a single string value', 400);
  }
  const parsedPage = parseNonNegativeInt(query.page);
  if (parsedPage === null) {
    throw new WxycError('page must be a non-negative integer', 400);
  }
  const page = parsedPage ?? 0;

  if (query.limit !== undefined && typeof query.limit !== 'string') {
    throw new WxycError('limit must be a single string value', 400);
  }
  const parsedLimit = parseNonNegativeInt(query.limit);
  if (parsedLimit === null) {
    throw new WxycError('limit must be a positive integer', 400);
  }
  const limit = parsedLimit ?? defaultLimit;
  if (limit < 1) {
    throw new WxycError('limit must be a positive integer', 400);
  }
  if (limit > maxLimit) {
    throw new WxycError(`limit must not exceed ${maxLimit}`, 400);
  }

  if (!Number.isSafeInteger(page * limit)) {
    throw new WxycError(`page must not exceed ${Math.floor(Number.MAX_SAFE_INTEGER / limit)} at limit ${limit}`, 400);
  }

  return { page, limit };
};

/**
 * GET /library/crossreferences/artists — the whole `artist_crossreference`
 * collection, successor to `/wxycdb`'s `xrefsToLibraryCodes.jsp`.
 *
 * Read-only by decision, not by omission: WXYC/wiki#89 D5 freezes this set at
 * the tubafrenzy cutover, so there is no POST/PATCH/DELETE sibling and adding
 * one would unfreeze it. An empty collection is a 200 with `total: 0`, which
 * is what the JSP's "There are no Library Code Cross-References" state
 * renders from — not a 404, since the collection exists and is empty.
 */
export const listArtistCrossReferences: RequestHandler<object, unknown, unknown, CrossReferenceQueryParams> = async (
  req,
  res
) => {
  const { page, limit } = parsePageParams(req.query, CROSSREFERENCE_DEFAULT_LIMIT, CROSSREFERENCE_MAX_LIMIT);
  const [results, total] = await Promise.all([
    libraryService.getArtistCrossReferences(page, limit),
    libraryService.countArtistCrossReferences(),
  ]);
  res.status(200).json({ results, total, page, totalPages: Math.ceil(total / limit) });
};

/**
 * GET /library/crossreferences/releases — the whole
 * `artist_library_crossreference` collection, successor to `/wxycdb`'s
 * `xrefsToLibraryReleases.jsp`. Read-only for the same reason as its sibling
 * above; D5 drops this set rather than freezing it, which is a still stronger
 * argument against a write path.
 */
export const listReleaseCrossReferences: RequestHandler<object, unknown, unknown, CrossReferenceQueryParams> = async (
  req,
  res
) => {
  const { page, limit } = parsePageParams(req.query, CROSSREFERENCE_DEFAULT_LIMIT, CROSSREFERENCE_MAX_LIMIT);
  const [results, total] = await Promise.all([
    libraryService.getReleaseCrossReferences(page, limit),
    libraryService.countReleaseCrossReferences(),
  ]);
  res.status(200).json({ results, total, page, totalPages: Math.ceil(total / limit) });
};

/**
 * Validate one optional free-text body field: must be a string, must not be
 * blank after trimming, must fit the column. Returns the trimmed value.
 *
 * The three `rotation` snapshot columns and `updateAlbum`'s `album_title`
 * all sit on `varchar(128)` and all want the identical trim / non-empty /
 * max-length shape; over-length input is rejected as a 400 here rather than
 * reaching the UPDATE and tripping PG 22001 ("value too long") → 500.
 * Callers pass their own limit so a future wider column doesn't have to
 * fork the helper.
 */
const validateTextField = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WxycError(`${field} must be a non-empty string`, 400);
  }
  const trimmed = value.trim();
  // Code points, not UTF-16 units — `codePointLength`, not `.length`. Postgres
  // measures `varchar(n)` in characters, so a bare `.length` counts every
  // astral character (emoji, CJK Ext-B) twice and rejects values PG would
  // store happily. `addRotation` already measures these same three columns
  // that way; using `.length` here made a 128-code-point `album_title`
  // creatable via POST and un-editable via PATCH — a row you cannot fix a
  // typo in without first shortening a legal title.
  if (codePointLength(trimmed) > maxLength) {
    throw new WxycError(`${field} must be ${maxLength} characters or fewer`, 400);
  }
  return trimmed;
};

const ROTATION_STATUSES = ['active', 'killed', 'all'] as const;

/**
 * `?status=` (BS#2473) — default `active`, byte-compatible with every
 * pre-#2473 caller. See `getRotationFromDB` for the non-partition semantics.
 */
export const getRotation: RequestHandler = async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !ROTATION_STATUSES.includes(status as (typeof ROTATION_STATUSES)[number])) {
    throw new WxycError(`Invalid Parameter: status must be one of ${ROTATION_STATUSES.join(', ')}`, 400);
  }
  const rotation = await libraryService.getRotationFromDB(status as libraryService.RotationStatus | undefined);
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
 * Optional `?status=active|killed|all` (BS#2504) narrows the backlog, and for
 * `killed` reorders it most-recently-killed first — the librarian's weekly
 * worklist, which add-date order scatters through the cohort and the 500-row
 * cap then truncates. The vocabulary is `getRotation`'s above and the values
 * are validated against the same `ROTATION_STATUSES` list, so the two
 * endpoints cannot drift apart on spelling; the **default differs on purpose**
 * (`all` here, `active` there) because this endpoint shipped unfiltered and
 * dj-site's Awaiting Cataloging facet reads it unparameterised. `undefined` is
 * forwarded as `undefined` — the default is the query's, not this handler's.
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

  // Same guard and same message as `getRotation` above. A repeated key arrives
  // as string[], which `.includes` rejects — a 400 rather than an unhandled
  // value reaching the query.
  const { status } = req.query;
  if (status !== undefined && !ROTATION_STATUSES.includes(status as (typeof ROTATION_STATUSES)[number])) {
    throw new WxycError(`Invalid Parameter: status must be one of ${ROTATION_STATUSES.join(', ')}`, 400);
  }

  const rotation = await libraryService.getUncataloguedRotationFromDB({
    limit,
    offset,
    status: status as libraryService.RotationStatus | undefined,
  });
  res.status(200).json(rotation);
};

/** Positive-int `id` path param for the `/rotation/cards/:id` write endpoints (BS#2472). */
const parseCardId = (rawId: string): number => parseResourceId(rawId, 'rotation card');

/**
 * `GET /library/rotation/cards` (BS#2472). ROUTE REGISTRATION ORDER IS
 * LOAD-BEARING, same trap as `getUncataloguedRotation` above — this literal
 * must stay registered ahead of `GET /rotation/:id` or Express hands it "cards"
 * as an id. Pinned by `library-rotation-route-order.route.test.ts`.
 */
export const getRotationCards: RequestHandler = async (_req, res) => {
  const cards = await libraryService.listRotationCardsFromDB();
  res.status(200).json(cards);
};

export type AddRotationCardRequest = { bin: string; name?: string };

/** `POST /library/rotation/cards` (BS#2472) — `number` is server-assigned (bin's max + 1). */
export const addRotationCard: RequestHandler<object, unknown, AddRotationCardRequest> = async (req, res) => {
  // Same body-parser 2.x hazard `updateArtistCard` normalizes above: Express
  // 5 leaves `req.body` UNDEFINED for a body-less or non-JSON-typed request,
  // so dereferencing it unguarded turns the likeliest smoke-test request
  // (`curl -X POST` with no body) into a TypeError 500 instead of a 400.
  const body: Partial<AddRotationCardRequest> = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new WxycError('Bad Request: body must be a JSON object', 400);
  }
  const parsedBin = parseRotationBin(body.bin);
  if (parsedBin.kind !== 'bin') {
    throw new WxycError(`Invalid bin ${JSON.stringify(body.bin)}. Expected one of: ${ROTATION_BINS.join(', ')}.`, 400);
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new WxycError('Invalid Parameter: name must be a string', 400);
  }

  const card = await libraryService.addRotationCard(parsedBin.bin, body.name);
  res.status(200).json(card);
};

export type UpdateRotationCardRequest = { name: string | null };

/** `PATCH /library/rotation/cards/:id` (BS#2472) — rename only. */
export const renameRotationCard: RequestHandler<{ id: string }, unknown, UpdateRotationCardRequest> = async (
  req,
  res
) => {
  const cardId = parseCardId(req.params.id);
  // Same `req.body ?? {}` normalization as `addRotationCard` above — a
  // body-less PATCH must be the 400 one line down, not a destructure
  // TypeError 500.
  const body: Partial<UpdateRotationCardRequest> = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new WxycError('Bad Request: body must be a JSON object', 400);
  }
  const { name } = body;
  if (name === undefined || (name !== null && typeof name !== 'string')) {
    throw new WxycError('Missing Parameters: name', 400);
  }

  const card = await libraryService.renameRotationCard(cardId, name);
  if (!card) {
    throw new WxycError('Rotation card not found', 404);
  }
  res.status(200).json(card);
};

/**
 * `DELETE /library/rotation/cards/:id` (BS#2472). 409 (conjunctive) unless
 * the card is both the highest-numbered card in its bin and has zero active
 * rotation rows — see `libraryService.deleteRotationCardFromDB`.
 */
export const deleteRotationCard: RequestHandler<{ id: string }> = async (req, res) => {
  const cardId = parseCardId(req.params.id);
  const result = await libraryService.deleteRotationCardFromDB(cardId);

  switch (result.outcome) {
    case 'not_found':
      throw new WxycError('Rotation card not found', 404);
    // Reason strings are contract-pinned (wxyc-shared #460); the error body
    // is exactly `{message, reason}` — a per-card count belongs to the cards
    // LIST response, not this 409, so the count rides only in the prose.
    case 'not_last_in_bin':
      res.status(409).json({
        message: 'Cannot delete: a higher-numbered card exists in this bin. Bins shrink only from the top.',
        reason: 'card_not_highest_in_bin',
      });
      return;
    case 'has_active_rows':
      res.status(409).json({
        message: `Cannot delete: ${result.activeCount} active rotation row${result.activeCount === 1 ? '' : 's'} still assigned to this card`,
        reason: 'card_has_active_rotations',
      });
      return;
    case 'deleted':
      res.status(204).end();
      return;
    default: {
      const unhandled: never = result;
      throw new WxycError(`Unhandled rotation card delete outcome: ${JSON.stringify(unhandled)}`, 500);
    }
  }
};

/**
 * `GET /library/rotation/:id` (BS#2410) — the single-row rotation read.
 *
 * Serves dj-site#1161's Import-to-Library screen: the summary table it
 * renders, and the pre-submit staleness re-read that refuses cleanly when the
 * row was catalogued while the form was open (plan D8). No existing read path
 * answers this — `GET /library/rotation` is a DISTINCT-ON-collapsed dropdown
 * shape keyed on the library join, and `GET /library/rotation/uncatalogued`
 * filters `album_id IS NULL` behind a 500-row cap against a ~3.8k backlog, so
 * "absent from that page" conflates *linked* with *past the window*. This
 * endpoint answers for linked and unlinked rows alike.
 *
 * `catalog: ['read']`, matching its read siblings rather than the
 * `catalog: ['write']` PATCH that shares its path.
 *
 * **Referent note, deliberate.** `format_id`/`label_id` in the response are
 * the rotation row's own pre-catalog fields, never the linked library
 * release's — the opposite of what `label_id` means on the sibling
 * `GET /library/rotation`, whose rows come from the `library` join. See
 * `libraryService.getRotationRowFromDB` for why, and why there is no COALESCE
 * here even though the adjacent endpoint's query is full of them.
 *
 * ROUTE REGISTRATION ORDER IS LOAD-BEARING, and more so than for its PATCH
 * sibling: this route shares BOTH method and segment count with a literal
 * (`GET /rotation/uncatalogued`), so registering it earlier really would
 * swallow the queue endpoint. It is the second such family on this router,
 * not the first — `GET /artists/:id` (BS#2156) stands in exactly this
 * relation to `GET /artists/search`, `GET /artists/peek-code` and
 * `GET /artists/by-code`. Pinned by both
 * `tests/unit/routes/library-rotation-uncatalogued.route.test.ts` and
 * `tests/unit/routes/library-rotation-route-order.route.test.ts`, which
 * asserts the ordering over both families.
 */
export const getRotationRow: RequestHandler<{ id: string }> = async (req, res) => {
  const rotationId = parseResourceId(req.params.id, 'rotation');

  // Already narrowed — `getRotationRowFromDB` SELECTs
  // `UNCATALOGUED_ROTATION_PROJECTION`, exactly as the queue read does, so
  // there is no full `rotation` row here to run back through
  // `toRotationRowSummary`. That helper is for the write paths, which hold a
  // bare `.returning()` row; both routes end at the same key set because the
  // projection and the helper are derived from one declaration.
  const row = await libraryService.getRotationRowFromDB(rotationId);
  if (!row) {
    throw new WxycError('Rotation entry not found', 404);
  }

  res.status(200).json(row);
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
 * **`format_id` and `label_id` (BS#2409's columns, accepted here by BS#2410)
 * follow the same conditional rule, not a looser one.** They are pre-catalog
 * fields — `libraryService.ROTATION_PRECATALOG_FIELDS` is the list, and the
 * PATCH surface enforces the same `album_id IS NULL` precondition on them.
 * Picking them on a linked add would write a rotation-side copy of values the
 * library row already owns, which is the drift the trio's rule exists to
 * prevent; the format authority for a linked row is `library.format_id`.
 *
 * EDITING that trio after the fact is a different write path: `updateRotation`
 * (BS#2113) on `PATCH /library/rotation/:id` owns post-creation edits, and
 * `add_date` is post-creation-only in that same sense — it stays off this
 * allowlist because `POST` mints a fresh row, not because the column is
 * unwritable. (An earlier revision of this comment said the whole snapshot
 * group "must never be client-supplied through this endpoint"; BS#2109 shipped
 * exactly that for the uncatalogued case, so the rule is now conditional on
 * `album_id`, not absolute.)
 *
 * `rotation` has been Backend-canonical since WXYC/wiki#88 Phase 3:
 * `jobs/rotation-etl` is unscheduled (`"job-type": "one-shot"`, no
 * `cron-schedule`) and refuses to run without
 * `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`, so tubafrenzy is no longer "the
 * legitimate source" for anything here.
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
  'album_id' | 'rotation_bin' | 'artist_name' | 'album_title' | 'record_label' | 'format_id' | 'label_id' | 'card_id'
>;

export function pickAddRotationFields(body: Partial<NewRotationRelease>): AddRotationAllowlist {
  const picked = {} as AddRotationAllowlist;
  if (body.album_id != null) picked.album_id = body.album_id;
  if (body.rotation_bin != null) picked.rotation_bin = body.rotation_bin;
  // BS#2472: which physical card the row is filed under. Unconditional —
  // unlike the snapshot trio and the pre-catalog FKs below, a card
  // assignment is the rotation row's own state on linked and unlinked rows
  // alike, so `album_id` does not gate it. Absent (or `null`, the
  // `selected?.id ?? null` client shape) means "the service defaults to the
  // bin's newest card"; the service also owns existence and bin-agreement
  // validation (`resolveRotationCardId`).
  if (body.card_id != null) picked.card_id = body.card_id;
  if (body.album_id == null) {
    if (body.artist_name != null) picked.artist_name = body.artist_name;
    if (body.album_title != null) picked.album_title = body.album_title;
    if (body.record_label != null) picked.record_label = body.record_label;
    // BS#2410's pre-catalog FKs sit on THIS branch only, exactly like the
    // trio above. On a linked add the format and label are the library row's
    // to state, and a rotation-side copy would drift from it the same way a
    // client-supplied `record_label` would.
    if (body.format_id != null) picked.format_id = body.format_id;
    if (body.label_id != null) picked.label_id = body.label_id;
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

/**
 * The denormalized display snapshot. A rotation row carries these three ONLY
 * when it has no `album_id`; on a library-linked row they must stay NULL. See
 * `updateRotation` (BS#2113) for why writing them on a catalogued row is
 * rejected rather than accepted-and-ignored, and `addRotation` (BS#2109) for
 * the creation-time half of the same rule.
 */

/** Unicode-code-point length — see `ROTATION_SNAPSHOT_MAX_LENGTH` above. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** `true` only for a string with at least one non-whitespace character. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// The request-side bounds RotationCreateFields.urls declares (wxyc-shared
// 1.55.0). Declared there at publish time because oasdiff treats adding
// request-side bounds later as breaking — which makes them permanent
// promises this server must actually keep, not trust from the contract.
const ROTATION_URLS_MAX_ITEMS = 20;
const ROTATION_URL_MAX_LENGTH = 2048;

/**
 * `urls[]` on both rotation write arms (BS#2473) — POST's initial set and
 * PATCH's wholesale replacement. The whole array is validated before any of
 * it is written, so a bad entry can't leave a partially-written set.
 *
 * Deliberately NOT URL-parsed. The contract (`RotationCreateFields.urls`)
 * stores plain strings, not `format: uri` — MDs paste bare domains, so a
 * value carries no scheme guarantee, and the read side pairs that with "a
 * renderer must not bind one into an href without checking it". Rejecting a
 * scheme-less value here would make the input the schema tells clients to
 * expect unstorable. What IS enforced is exactly the contract's declared
 * bounds: at most 20 entries, each a non-blank string of at most 2048
 * characters (code points, matching OpenAPI `maxLength` semantics and the
 * snapshot fields' `codePointLength` convention above). Entries are stored
 * trimmed and otherwise verbatim.
 */
function parseRotationUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WxycError('Invalid Parameter: urls must be an array of strings', 400);
  }
  if (value.length > ROTATION_URLS_MAX_ITEMS) {
    throw new WxycError(`Invalid Parameter: urls accepts at most ${ROTATION_URLS_MAX_ITEMS} entries`, 400);
  }
  return value.map((entry) => {
    if (!isNonBlankString(entry)) {
      throw new WxycError(`Invalid Parameter: urls entries must be non-blank strings: ${JSON.stringify(entry)}`, 400);
    }
    const trimmed = entry.trim();
    if (codePointLength(trimmed) > ROTATION_URL_MAX_LENGTH) {
      throw new WxycError(`Invalid Parameter: urls entries must be at most ${ROTATION_URL_MAX_LENGTH} characters`, 400);
    }
    return trimmed;
  });
}

/**
 * The two pre-catalog FKs `rotation` gained in BS#2409, and how to prove a
 * client-supplied id actually resolves (BS#2410).
 *
 * `rotation.format_id → format(id)` and `rotation.label_id → labels(id)` are
 * real foreign keys, so a stale or guessed id reaches Postgres as a 23503 and
 * surfaces as an opaque 500 plus a Sentry event naming no field. Both rotation
 * write paths therefore check existence before the write, and both reuse the
 * wording `updateAlbum` already 400s with for exactly these two references —
 * verbatim, so a client that learned the string from one endpoint recognizes
 * it from the other.
 *
 * The tuple is the single declaration of the pair: both write-path loops
 * iterate it, and `ROTATION_PRECATALOG_FK_CHECKS` is typed `Record` over it,
 * so a third pre-catalog FK is added once and the missing check is a compile
 * error rather than a field that quietly skips validation on both paths.
 */
const ROTATION_PRECATALOG_FK_FIELDS = ['format_id', 'label_id'] as const;

type RotationPrecatalogFk = (typeof ROTATION_PRECATALOG_FK_FIELDS)[number];

const ROTATION_PRECATALOG_FK_CHECKS: Record<
  RotationPrecatalogFk,
  { exists: (id: number) => Promise<unknown>; danglingMessage: string }
> = {
  format_id: {
    exists: (id: number) => libraryService.getFormatById(id),
    danglingMessage: 'format_id does not reference an existing format',
  },
  label_id: {
    exists: (id: number) => labelsService.getLabelById(id),
    danglingMessage: 'label_id does not reference an existing label',
  },
};

/**
 * Shape-check then existence-check one pre-catalog FK, or throw the 400.
 *
 * `nullable` distinguishes the two write paths rather than being cosmetic:
 * on `POST /library/rotation` an explicit `null` means "absent" (the
 * `selected?.id ?? null` client shape, which `pickAddRotationFields` drops),
 * while on `PATCH /library/rotation/:id` it means "clear the column" — the
 * same `null`-vs-absent distinction `kill_date` carries there. A cleared
 * reference has nothing to look up, so it skips the round trip.
 */
async function assertRotationPrecatalogFk(
  field: RotationPrecatalogFk,
  value: unknown,
  { nullable }: { nullable: boolean }
): Promise<void> {
  if (nullable && value === null) return;

  const suffix = nullable ? ' or null' : ', or omitted';
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new WxycError(`Invalid Parameter: ${field} must be a positive integer${suffix}`, 400);
  }

  const check = ROTATION_PRECATALOG_FK_CHECKS[field];
  if (!(await check.exists(value as number))) {
    throw new WxycError(check.danglingMessage, 400);
  }
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
 *
 * **Card filing (BS#2472):** `card_id` may accompany the add on both the
 * catalogued and uncatalogued paths; absent (or `null`), the service files
 * the row on the bin's newest card, so legacy writers that predate cards
 * keep filing correctly. Existence (404) and bin agreement (the named 409
 * below) live in `resolveRotationCardId` at the service layer.
 */
// BS#2473: `urls` rides the request body alongside the `NewRotationRelease`
// columns but isn't one of them (`rotation_urls` is a child table) — widened
// here rather than on `NewRotationRelease` itself, which mirrors the real
// `rotation` table and must not grow a non-column field.
type AddRotationRequestBody = NewRotationRelease & { urls?: unknown };

export const addRotation: RequestHandler<object, unknown, AddRotationRequestBody> = async (req, res) => {
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

  // BS#2472: an explicit card assignment may ride the add. Shape-guarded
  // like `album_id` above (`null` means "absent", the `selected?.id ?? null`
  // client shape); existence and bin agreement are the service's to assert —
  // 404 for a dangling id, `RotationCardBinMismatchError` (the 409 below)
  // for a card filed in a different bin than `rotation_bin`.
  if (body.card_id != null && !(Number.isInteger(body.card_id) && body.card_id > 0)) {
    throw new WxycError(
      "Invalid Parameter: card_id must be a positive integer, or omitted to file on the bin's newest card",
      400
    );
  }

  if (!hasAlbumId) {
    // Only guarded on the uncatalogued path: with an `album_id` present the
    // trio is deliberately dropped by `pickAddRotationFields`, so a long
    // value there is never written and must not fail an otherwise-valid add.
    for (const field of libraryService.ROTATION_SNAPSHOT_COLUMNS) {
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

    // Same branch, same reason as the length guard above: with an `album_id`
    // present `pickAddRotationFields` drops both FKs, so validating them there
    // would 400 a valid add over a value that is never written. `null` is
    // "absent" on this endpoint, so it is skipped rather than cleared.
    for (const field of ROTATION_PRECATALOG_FK_FIELDS) {
      if (body[field] == null) continue;
      await assertRotationPrecatalogFk(field, body[field], { nullable: false });
    }
  }

  // BS#2473: the row's initial URL set, on both arms. Validated up front so
  // a bad entry never reaches the insert transaction.
  const urls = body.urls !== undefined ? parseRotationUrls(body.urls) : undefined;

  const picked = pickAddRotationFields(body);
  let rotationRelease: RotationRelease;
  try {
    rotationRelease = await libraryService.addToRotation(picked, urls);
  } catch (err) {
    if (err instanceof libraryService.RotationCardBinMismatchError) {
      // The named-reason 409 convention (`addArtist`, `deleteRotationCard`);
      // `rotation_card_bin_mismatch` is the exact `LibraryFilingConflictReason`
      // string the shared contract defines for this invariant.
      res.status(409).json({ message: err.message, reason: 'rotation_card_bin_mismatch' });
      return;
    }
    throw err;
  }

  // BS#2491: the catalogued arm also wrote the urls release-scoped into
  // `library_urls` (inside `addToRotation`'s transaction). Reconcile them to
  // LML after that write commits — fail-open, and outside any transaction so
  // no row lock is held across the network hop. The uncatalogued arm writes no
  // library_urls, so it doesn't reconcile.
  if (hasAlbumId && urls && urls.length > 0) {
    await libraryService.reconcileLibraryUrlsToLml(urls);
  }

  res.status(201).json(rotationRelease);
};

// `POST /library/filings` (BS#2474; wxyc-shared `LibraryFilingRequest`).
// `artist` is discriminated by `kind`: `create` carries the exact
// `POST /library/artists` fields, `existing` names an already-catalogued
// row. `release` is `AlbumCreateFields` (every `addAlbum` field except the
// artist reference pair). `rotation`, given, is the release's initial
// rotation entry — no `album_id` on it, since that FK is this same release.
type FilingArtistBody = ({ kind: 'create' } & NewArtistRequest) | { kind: 'existing'; artist_id: unknown };

type FilingReleaseBody = {
  album_title?: string;
  label?: string;
  label_id?: number | null;
  genre_id?: number;
  format_id?: number;
  code_number?: number;
  code_volume_letters?: string;
  alternate_artist_name?: string;
  disc_quantity?: number;
};

type FilingRotationBody = {
  rotation_bin?: string;
  card_id?: number | null;
  urls?: unknown;
};

type LibraryFilingRequestBody = {
  artist?: FilingArtistBody;
  release?: FilingReleaseBody;
  rotation?: FilingRotationBody;
};

/**
 * The `Artist` shape `wxyc-shared/api.yaml` declares — the composite's 200
 * `artist` block AND the 409 `LibraryFilingConflictError.artist` payload
 * both `$ref` it, so every artist this endpoint puts on the wire must carry
 * this exact field set. NOT `ArtistCodeOwner` (`addArtist`'s own 409 shape):
 * that projection has no `id`, `code_artist_number` or `genre_id`, and the
 * contract's prescribed remedy for a name conflict — resubmit with
 * `kind: 'existing'` and the returned `artist.id` — reads fields it lacks.
 * The strictly-typed generated clients (Swift/Kotlin) fail to decode the
 * 409 at all when any required `Artist` member is missing.
 */
type FilingArtist = {
  id: number;
  artist_name: string;
  code_letters: string;
  code_artist_number: number;
  genre_id: number;
};

const artistCardToFilingArtist = (row: libraryService.ArtistCardRow): FilingArtist => ({
  id: row.artist_id,
  artist_name: row.artist_name,
  code_letters: row.code_letters,
  code_artist_number: row.code_artist_number,
  genre_id: row.genre_id,
});

/**
 * `POST /library/filings` (BS#2474): artist (create-or-reference), release,
 * and an optional rotation entry, in ONE `db.transaction` — a mid-chain
 * failure rolls back everything already written this request, including an
 * artist the create arm just inserted and a `labels` row the release's
 * label text minted. Composed from the same writes
 * `addArtist`/`addAlbum`/`addRotation` use
 * (`insertArtistWithGenreCrossreference` / `resolveNewAlbumLabel` /
 * `insertAlbum` / `addToRotation`), each threaded onto this function's own
 * `tx` (see `DbTransaction`'s doc comment for why a nested bare
 * `db.transaction()` inside those functions would NOT roll back with it).
 * The reads inside the transaction ride the same `tx` — a bare `db` read
 * there borrows a SECOND pool connection while this one sits reserved, and
 * enough concurrent filings would each hold a connection while waiting on a
 * read none of them can be granted (`addToRotation`'s identity-read comment
 * has the mechanics). Everything with no write to protect — the conflict
 * pre-checks, mirroring `addArtist`'s exact sequence and residual-race
 * posture — runs BEFORE the transaction on the plain pool.
 *
 * The `kind: 'existing'` arm resolves the referenced artist's
 * crossreference IN `release.genre_id` specifically, not the lowest-genre
 * collapse `GET /library/artists/:id` answers with: the release is filed
 * under that genre, so the artist code echoed back must be the code for
 * that shelf — a multi-genre artist's lowest membership can carry a
 * different genre's call number. An artist with no membership in the
 * release's genre is a 400 (the create arm's mirror guard is the
 * `artist.genre_id === release.genre_id` equality check), as is a dangling
 * `artist_id` — the contract declares no 404 on this route.
 *
 * After the transaction commits, the release runs the SAME LML enrichment
 * pipeline `POST /library` runs (`enrichNewAlbum`: streaming + artwork +
 * canonical entity) — after, never inside, because those are network hops
 * and the transaction must not stay open across them.
 *
 * The 409s all conform to `LibraryFilingConflictError` (`message` +
 * `reason`, `artist` on the two artist reasons). Code-number exhaustion —
 * `assignArtistCodeNumber`'s 409, which the standalone endpoint emits as
 * `{message, code}` — is answered here as `reason: 'artist_code_conflict'`
 * (its remedy is the same: pick/supply another code) with the standalone's
 * `code: 'artist_code_number_exhausted'` alongside as the finer
 * discriminant, because `reason` is required by the contract and its enum
 * has no exhaustion member. It is the one `artist_code_conflict` 409 with
 * no `artist` to name.
 */
export const createLibraryFiling: RequestHandler<object, unknown, LibraryFilingRequestBody> = async (req, res) => {
  const { body } = req;

  if (!body.artist || typeof body.artist !== 'object') {
    throw new WxycError('Missing Parameters: artist', 400);
  }
  if (body.artist.kind !== 'create' && body.artist.kind !== 'existing') {
    throw new WxycError("Invalid Parameter: artist.kind must be 'create' or 'existing'", 400);
  }
  if (body.artist.kind === 'create') {
    const a = body.artist;
    if (a.artist_name === undefined || a.code_letters === undefined || a.genre_id === undefined) {
      throw new WxycError('Missing Parameters: artist.artist_name, artist.code_letters, or artist.genre_id', 400);
    }
  } else if (!Number.isInteger(body.artist.artist_id) || (body.artist.artist_id as number) <= 0) {
    throw new WxycError('Invalid Parameter: artist.artist_id must be a positive integer', 400);
  }
  const artistBody = body.artist;

  if (!body.release || typeof body.release !== 'object') {
    throw new WxycError('Missing Parameters: release', 400);
  }
  const release = body.release;
  if (
    release.album_title === undefined ||
    (release.label === undefined && release.label_id == null) ||
    release.genre_id === undefined ||
    release.format_id === undefined
  ) {
    throw new WxycError(
      'Missing Parameters: release.album_title, release.label or release.label_id, release.genre_id, or release.format_id',
      400
    );
  }
  if (typeof release.album_title !== 'string' || release.album_title.trim() === '') {
    throw new WxycError('release.album_title must be a non-empty string', 400);
  }
  // The create arm files the artist's crossreference in `artist.genre_id`
  // and the release in `release.genre_id`. Diverging, the release's genre
  // would hold no artist code to resolve its shelf position against — the
  // same misfiling the existing arm's genre-scoped resolution below rejects
  // — so the composite requires the two to agree.
  if (artistBody.kind === 'create' && artistBody.genre_id !== release.genre_id) {
    throw new WxycError(
      'artist.genre_id must equal release.genre_id: the release is shelved under the artist code the create arm files in that genre',
      400
    );
  }
  const album_title = release.album_title;
  const release_genre_id = release.genre_id;
  const release_format_id = release.format_id;
  const code_volume_letters =
    release.code_volume_letters === undefined ? undefined : validateCodeVolumeLetters(release.code_volume_letters);
  const supplied_code_number = release.code_number === undefined ? undefined : validateCodeNumber(release.code_number);

  let rotationBody: { rotation_bin: RotationBin; card_id?: number; urls?: string[] } | undefined;
  // != null: clients that serialize "no rotation" as an explicit null get the
  // omitted-rotation filing, not a TypeError from the property reads below.
  if (body.rotation != null) {
    const rot = body.rotation;
    if (rot.rotation_bin == null || parseRotationBin(rot.rotation_bin).kind !== 'bin') {
      throw new WxycError(
        `Invalid rotation.rotation_bin ${JSON.stringify(rot.rotation_bin)}. Expected one of: ${ROTATION_BINS.join(', ')}.`,
        400
      );
    }
    if (rot.card_id != null && !(Number.isInteger(rot.card_id) && rot.card_id > 0)) {
      throw new WxycError(
        "Invalid Parameter: rotation.card_id must be a positive integer, or omitted to file on the bin's newest card",
        400
      );
    }
    rotationBody = {
      rotation_bin: rot.rotation_bin as RotationBin,
      card_id: rot.card_id ?? undefined,
      urls: rot.urls !== undefined ? parseRotationUrls(rot.urls) : undefined,
    };
  }

  // Artist resolution and conflict pre-checks: plain-pool reads BEFORE the
  // transaction, `addArtist`'s exact sequence and precedence (code conflict
  // wins over name conflict; the server-assigned arm recomputes once on a
  // pre-check hit). Residual races carry `addArtist`'s documented
  // single-librarian acceptance.
  let filingPlan:
    | { kind: 'create'; artist_name: string; alphabetical_name: string; code_letters: string; code_number: number }
    | { kind: 'existing'; artist: FilingArtist };
  if (artistBody.kind === 'create') {
    const code_letters = validateArtistCodeLetters(artistBody.code_letters);
    const supplied = artistBody.code_number != null;
    let code_number: number;
    try {
      code_number = supplied
        ? validateArtistCodeNumber(artistBody.code_number)
        : await assignArtistCodeNumber(code_letters, artistBody.genre_id);
      let existing = await libraryService.getArtistByCode(code_letters, artistBody.genre_id, code_number);
      if (existing && !supplied) {
        code_number = await assignArtistCodeNumber(code_letters, artistBody.genre_id);
        existing = await libraryService.getArtistByCode(code_letters, artistBody.genre_id, code_number);
      }
      if (existing) {
        // The conflicting artist demonstrably holds exactly the checked
        // `(code_letters, genre_id, code_number)` triple, so the contract
        // `Artist` payload is assembled from the probe itself — no second
        // lookup can disagree with it.
        res.status(409).json({
          message: 'Artist code already exists for that genre and code letters.',
          reason: 'artist_code_conflict',
          artist: {
            id: existing.artist_id,
            artist_name: existing.artist_name,
            code_letters: existing.code_letters,
            code_artist_number: code_number,
            genre_id: artistBody.genre_id,
          } satisfies FilingArtist,
        });
        return;
      }
    } catch (err) {
      // See the doc block: exhaustion is a real conflict but the contract's
      // `reason` enum has no member for it, so it rides the code-conflict
      // reason (same remedy) with the standalone endpoint's `code` kept as
      // the precise discriminant.
      if (err instanceof WxycError && err.code === 'artist_code_number_exhausted') {
        res.status(409).json({ message: err.message, reason: 'artist_code_conflict', code: err.code });
        return;
      }
      throw err;
    }
    const conflictingId = await libraryService.artistIdFromName(artistBody.artist_name, artistBody.genre_id);
    // Genre-scoped card lookup, not `getArtistById`: the fold-match above is
    // scoped to `artist.genre_id`, and the contract payload needs that
    // membership's own call number. A miss means the row was deleted between
    // the two queries, so the name is free again — proceed, as `addArtist`
    // does.
    const conflicting = conflictingId
      ? await libraryService.getArtistCardByIdInGenre(conflictingId, artistBody.genre_id)
      : null;
    if (conflicting) {
      res.status(409).json({
        message: 'Artist name already exists in that genre.',
        reason: 'artist_name_conflict',
        artist: artistCardToFilingArtist(conflicting),
      });
      return;
    }
    filingPlan = {
      kind: 'create',
      artist_name: artistBody.artist_name,
      alphabetical_name: artistBody.alphabetical_name ?? artistBody.artist_name,
      code_letters,
      code_number,
    };
  } else {
    const referenced = await libraryService.getArtistCardByIdInGenre(artistBody.artist_id as number, release_genre_id);
    if (!referenced) {
      // Both misses are 400s — the contract assigns a dangling
      // `artist.artist_id` to 400 and declares no 404 on this route — but
      // the remedies differ, so the messages distinguish them.
      const artistExists = await libraryService.getArtistById(artistBody.artist_id as number);
      throw artistExists
        ? new WxycError(
            'artist.artist_id references an artist with no artist code in release.genre_id: file the artist in that genre first, or file the release under a genre the artist is already coded in',
            400
          )
        : new WxycError('artist.artist_id does not reference an existing artist', 400);
    }
    filingPlan = { kind: 'existing', artist: artistCardToFilingArtist(referenced) };
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Inside the transaction so a later-stage rollback also takes back a
      // `labels` row minted from fresh label text (see `resolveNewAlbumLabel`'s
      // `tx` comment).
      const { label_id, label } = await resolveNewAlbumLabel(release, tx);

      let artistRow: FilingArtist;
      if (filingPlan.kind === 'create') {
        const artist = await libraryService.insertArtistWithGenreCrossreference(
          {
            artist_name: filingPlan.artist_name,
            alphabetical_name: filingPlan.alphabetical_name,
            code_letters: filingPlan.code_letters,
          },
          release_genre_id,
          filingPlan.code_number,
          tx
        );
        artistRow = {
          id: artist.id,
          artist_name: artist.artist_name,
          code_letters: artist.code_letters,
          code_artist_number: filingPlan.code_number,
          genre_id: release_genre_id,
        };
      } else {
        artistRow = filingPlan.artist;
      }

      const release_code_number =
        supplied_code_number ?? (await libraryService.generateAlbumCodeNumber(artistRow.id, tx));
      const releaseRow = await libraryService.insertAlbum(
        {
          artist_id: artistRow.id,
          artist_name: artistRow.artist_name,
          genre_id: release_genre_id,
          format_id: release_format_id,
          album_title,
          label,
          label_id,
          code_number: release_code_number,
          code_volume_letters,
          alternate_artist_name: release.alternate_artist_name,
          disc_quantity: release.disc_quantity,
        },
        tx
      );

      let rotationRow: RotationRelease | undefined;
      if (rotationBody) {
        rotationRow = await libraryService.addToRotation(
          { rotation_bin: rotationBody.rotation_bin, album_id: releaseRow.id, card_id: rotationBody.card_id },
          rotationBody.urls,
          tx
        );
      }

      return { artist: artistRow, release: releaseRow, rotation: rotationRow };
    });

    // Post-commit, never in-transaction: the same enrichment the standalone
    // add runs, so a record filed here carries the same on_streaming /
    // artwork_url / canonical entity it would get from `POST /library`.
    const enrichedRelease = await enrichNewAlbum(
      result.release,
      release.alternate_artist_name || result.artist.artist_name,
      result.artist.artist_name,
      album_title
    );

    // BS#2491: a filing always produces a catalogued release, so any provided
    // urls were written release-scoped into `library_urls` inside the
    // transaction above. Reconcile them to LML after the commit — fail-open,
    // and outside the transaction so no row lock is held across the hop.
    if (rotationBody?.urls && rotationBody.urls.length > 0) {
      await libraryService.reconcileLibraryUrlsToLml(rotationBody.urls);
    }

    res.status(200).json({ ...result, release: enrichedRelease });
  } catch (err) {
    if (err instanceof libraryService.RotationCardBinMismatchError) {
      res.status(409).json({ message: err.message, reason: 'rotation_card_bin_mismatch' });
      return;
    }
    // `resolveRotationCardId`'s dangling-card 404 (see its `code` comment):
    // this route's contract declares no 404, so the dangling reference is
    // remapped onto the declared validation 400, message and `code` intact.
    if (err instanceof WxycError && err.code === 'rotation_card_not_found') {
      throw new WxycError(err.message, 400, { code: err.code });
    }
    throw err;
  }
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
 *
 * BS#2410 (plan D7) added the JSP's third step to that transaction: the
 * rotation row's own flowsheet plays are repointed at the new release. The
 * response shape is unchanged — the count of resolved plays is observability
 * only, projected onto the active span rather than serialized.
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
      // BS#2410 (plan D7): how many of this rotation row's flowsheet plays the
      // link resolved. Deliberately NOT on the wire — dj-site has nothing to
      // render from it and the published shape is pinned to the rotation
      // projection — but an import's blast radius should be reconstructable
      // from tracing rather than by querying the flowsheet after the fact.
      // Own try/catch for the same reason the streaming-check projection has
      // one: the write is already committed, so a telemetry failure must not
      // turn a successful link into a 500.
      try {
        Sentry.getActiveSpan()?.setAttributes({
          'rotation_link.flowsheet_rows_linked': result.flowsheetRowsLinked,
        });
      } catch (e) {
        console.warn('Failed to project rotation-link telemetry onto span:', (e as Error).message);
      }
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

  const updatedRotation = await libraryService.killRotationInDB(body.rotation_id, body.kill_date);
  if (updatedRotation !== undefined) {
    res.status(200).json(updatedRotation);
  } else {
    throw new WxycError('Rotation entry not found', 400);
  }
};

export type RotationUpdateRequest = {
  artist_name?: string;
  album_title?: string;
  record_label?: string;
  add_date?: string; //Accepts ISO8601 formatted dates YYYY-MM-DD
  kill_date?: string | null; //Accepts ISO8601 formatted dates YYYY-MM-DD, or null to clear
  // BS#2409's pre-catalog FKs, editable here since BS#2410. Nullable: an
  // explicit `null` clears the reference, the same null-vs-absent distinction
  // `kill_date` above carries.
  format_id?: unknown;
  label_id?: unknown;
  // BS#2473: the within-bin move (validated against the row's OWN bin, not
  // a client-supplied one — see `libraryService.updateRotation`) and the
  // wholesale URL replacement. `card_id: null` uncards the row; `urls`
  // replaces the whole set, `[]` clears it.
  card_id?: unknown;
  urls?: unknown;
  // The JSP editor (tubafrenzy's `rotationReleaseModify.jsp`) also carries
  // these three fields, but none has a column on `rotation` —
  // alphabetical_name lives on `artists.alphabetical_name`
  // (WXYC/Backend-Service#2156), format_size on the `library` -> `format`
  // join (WXYC/dj-site#1169), and the JSP's free-text `format` is `format_id`
  // on this endpoint. Declared here (not just left unread) so
  // `ROTATION_NO_COLUMN_FIELDS` below can reject a client that sends them
  // with a precise 400 instead of silently writing less than it asked for.
  alphabetical_name?: unknown;
  format?: unknown;
  format_size?: unknown;
};

const ROTATION_UPDATABLE_FIELDS = [
  'artist_name',
  'album_title',
  'record_label',
  'add_date',
  'kill_date',
  'format_id',
  'label_id',
  'card_id',
] as const;

// `format` STAYS rejected even though BS#2410 made the format editable here.
// The wire field is `format_id`, so removing the rejection would not enable
// anything — it would only turn a JSP-shaped client's `format: "CD"` from a
// precise 400 into a silent 200-no-write, which is the exact failure this
// list exists to prevent. Its owner text is retargeted at `format_id` below.
const ROTATION_NO_COLUMN_FIELDS = ['alphabetical_name', 'format', 'format_size'] as const;

// Why each field has no `rotation` column, phrased so the remedy is correct
// for BOTH a catalogued row (`album_id` present) and an uncatalogued one.
//
// `alphabetical_name` is the subtle case. `getRotationFromDB` projects
// `COALESCE(artists.alphabetical_name, rotation.artist_name)`, so on a
// catalogued row the value is the `artists` row's and #2156 is the fix,
// but on an uncatalogued row there IS no `artists` row and the value falls
// through to `rotation.artist_name` — a column this very endpoint writes.
// Pointing such a caller at #2156 would send them to edit a row that does
// not exist.
const ROTATION_NO_COLUMN_FIELD_OWNERS: Record<(typeof ROTATION_NO_COLUMN_FIELDS)[number], string> = {
  alphabetical_name:
    "derived, not stored: a catalogued row takes it from artists.alphabetical_name (edit via PATCH /library/artists/:id, WXYC/Backend-Service#2156); an uncatalogued row falls back to this row's own artist_name, so send artist_name instead",
  format:
    "the rotation row does carry a format since WXYC/Backend-Service#2409, but as an id: send format_id (an integer referencing format(id)) rather than the free-text name; the linked release's own format is owned by the release PATCH surface (WXYC/dj-site#1169)",
  format_size: 'owned by the release PATCH surface (WXYC/dj-site#1169)',
};

/**
 * Field-specific remedy text for the linked-row 409 (BS#2113 review finding 2,
 * widened to the pre-catalog set by BS#2410).
 *
 * Four of the five have a working remedy on `PATCH /library/:id` —
 * `album_title`, `label` (for `record_label`), and `format_id`/`label_id`
 * under their own names. `artist_name` does not: `library.artist_name` only
 * ever changes by re-pointing `artist_id` at a different, already-existing
 * `artists` row (which reattributes the release, not renames anyone), and no
 * endpoint exposes a direct rename. Telling a caller to "edit the library
 * release" for an `artist_name` rejection would send them looking for a field
 * that isn't there.
 *
 * Keyed on `ROTATION_PRECATALOG_FIELDS`, not `ROTATION_SNAPSHOT_COLUMNS`:
 * the two lists govern different invariants (see the service's declaration),
 * and this 409 is the pre-catalog one.
 */
const ROTATION_SNAPSHOT_LIBRARY_FIELD: Partial<
  Record<(typeof libraryService.ROTATION_PRECATALOG_FIELDS)[number], string>
> = {
  album_title: 'album_title',
  record_label: 'label',
  format_id: 'format_id',
  label_id: 'label_id',
};

function buildLinkedSnapshotConflictMessage(
  precatalogFields: ReadonlyArray<(typeof libraryService.ROTATION_PRECATALOG_FIELDS)[number]>,
  albumId: number
): string {
  const editableViaLibrary = precatalogFields
    .map((field) => ROTATION_SNAPSHOT_LIBRARY_FIELD[field])
    .filter((field): field is string => field !== undefined);
  const rejectsArtistName = precatalogFields.includes('artist_name');

  const remedies: string[] = [];
  if (editableViaLibrary.length > 0) {
    remedies.push(`edit ${editableViaLibrary.join(', ')} via PATCH /library/${albumId} instead`);
  }
  if (rejectsArtistName) {
    remedies.push(
      'artist_name has no remedy here: library.artist_name is derived from the linked artists row via ' +
        'artist_id, and no endpoint currently supports renaming an artist or setting free-text artist_name ' +
        'on a catalogued release'
    );
  }

  return (
    `Conflict: ${precatalogFields.join(', ')} cannot be set on a rotation row linked to a library release ` +
    `(album_id ${albumId}) — these are pre-catalog fields, and once the row is linked the library release is ` +
    `the authority for all of them: the rotation list read takes artist, title, label and format from the ` +
    `library join, so the write would be invisible there, and a non-NULL snapshot on a linked row misroutes ` +
    `the flowsheet rotation badge. ${remedies.join('; ')}.`
  );
}

/**
 * PATCH /library/rotation/:id (BS#2113, widened by BS#2410): field-level edit
 * for the seven `rotation` columns the tubafrenzy JSP editor
 * (`rotationReleaseModify.jsp`) exposes that this endpoint can write — the
 * BS#2113 five plus `format_id`/`label_id`. The alphabetical name, format,
 * and format-size fields on that same screen stay rejected
 * (`ROTATION_NO_COLUMN_FIELDS`) rather than silently dropped: the first two
 * have no `rotation` column at all, and the JSP's free-text `format` is
 * `format_id` here, so accepting the name would be a 200-no-write.
 *
 * True partial semantics — only fields present in the body are validated
 * and written — mirroring `updateAlbum`. Delegates to the same
 * `libraryService.updateRotation()` writer `killRotation` (`PATCH
 * /library/rotation`) uses, so the two routes can't drift on how they set
 * `kill_date`.
 *
 * The `artist_name`/`album_title`/`record_label` snapshot trio is rejected
 * with a 409 on a row that HAS an `album_id`, for two independent reasons:
 *
 *   1. It would be a write nobody can read. `getRotationFromDB` projects
 *      `COALESCE(artists.artist_name, rotation.artist_name)`,
 *      `COALESCE(library.album_title, rotation.album_title)` and
 *      `COALESCE(library.label, rotation.record_label)` — on a linked row
 *      the library join always wins. The UPDATE would land in the column
 *      and be echoed back by `.returning()`, then be invisible on the only
 *      rotation read path: exactly the "silently writing less than it asked
 *      for" failure `ROTATION_NO_COLUMN_FIELDS` above exists to prevent.
 *   2. It would break a load-bearing invariant. "A library-LINKED rotation
 *      row carries NULL denormalized names" is documented verbatim in
 *      `flowsheet.service.ts` (the rotation-badge read path) and restated in
 *      the mirror's `rotation-match.ts` (removed in BS#2403); BS#2080's arm-(b) /
 *      arm-(c) partition rests on it and neither arm filters
 *      `album_id IS NULL`. A snapshot on a linked row makes arm (b) match
 *      any hand-typed flowsheet entry with the same (artist, album), so one
 *      rotation row badges two different releases — on the BS read path and
 *      via `isActiveRotationMatch` on the tubafrenzy mirror write path
 *      (removed by BS#2403; the read-path badge in flowsheet.service.ts remains).
 *
 * **BS#2410 extends that 409 from the trio to the whole pre-catalog set**, so
 * the rejected list is `libraryService.ROTATION_PRECATALOG_FIELDS` (trio +
 * `format_id` + `label_id`), not `ROTATION_SNAPSHOT_COLUMNS`. Reason 1 carries
 * over — `getRotationFromDB` publishes `library.label_id` and the `format`
 * join's `format_name` on a linked row, so a rotation-side FK write is just as
 * invisible there. Reason 2 does not: the flowsheet badge partitions on the
 * denormalized NAMES, not on the FKs. The FKs are refused anyway because the
 * library release is the authority for them once the row is linked — the same
 * drift rule `pickAddRotationFields` applies at creation time.
 *
 * The 409's remedy is field-specific, not a blanket "edit the library
 * release" — `PATCH /library/:id` genuinely covers `album_title` (its own
 * `album_title` field) and `record_label` (its `label` field), but has no
 * `artist_name` field at all: `library.artist_name` is derived from the
 * linked `artists` row via `artist_id`, and no endpoint today lets a caller
 * rename an artist or set free-text `artist_name` on a catalogued release.
 * An earlier revision pointed every rejection at `PATCH /library/:id`
 * uniformly, which was a real remedy for two of the three fields and a dead
 * end for the third; `buildLinkedSnapshotConflictMessage` below says so
 * rather than repeating the blanket claim.
 *
 * Sibling PR WXYC/Backend-Service#2164 (issue BS#2109) forbids the same trio
 * on `POST /library/rotation` at creation time, on the same grounds — it
 * picks the snapshot columns onto the insert allowlist only when the client
 * supplied no `album_id`. `add_date` and `kill_date` stay
 * editable on a catalogued row: `getRotationFromDB` reads both straight off
 * `rotation`, with no library-join shadow.
 *
 * The linked/unlinked precondition on the trio is enforced as a
 * compare-and-set inside `libraryService.updateRotation`, not from a read
 * taken here first: `rotation` is a live ingest target (the tubafrenzy
 * rotation webhook writes it continuously), so a row this handler read as
 * unlinked can be linked by the time the write lands. The service carries
 * `album_id IS NULL` into the UPDATE's own WHERE and reports a zero-row
 * result as a conflict — this handler never makes the linked/unlinked call
 * itself.
 */
export const updateRotation: RequestHandler<{ id: string }, unknown, RotationUpdateRequest> = async (req, res) => {
  const rotationId = parseResourceId(req.params.id, 'rotation');

  const { body } = req;

  const rejectedFields = ROTATION_NO_COLUMN_FIELDS.filter((field) => field in body);
  if (rejectedFields.length > 0) {
    // `field — reason`, not `field (see reason)`. The reasons are phrases and
    // sentences, not place names, so the "(see …)" frame produced unreadable
    // output ("alphabetical_name (see derived, not stored: …)") and nested
    // parens for the two entries that already carry their own.
    const detail = rejectedFields.map((field) => `${field} — ${ROTATION_NO_COLUMN_FIELD_OWNERS[field]}`).join('; ');
    throw new WxycError(`Bad Request: no rotation column exists for ${detail}`, 400);
  }

  // `urls` isn't a `rotation` column, so it can't join `ROTATION_UPDATABLE_FIELDS`
  // (that list also drives the pre-catalog 409's field-name projection above),
  // but a urls-only PATCH is a legal request — checked separately.
  if (!ROTATION_UPDATABLE_FIELDS.some((field) => field in body) && !('urls' in body)) {
    throw new WxycError(`Bad Request: provide at least one of ${ROTATION_UPDATABLE_FIELDS.join(', ')}, urls`, 400);
  }

  const updates: libraryService.UpdateRotationRow = {};

  for (const field of libraryService.ROTATION_SNAPSHOT_COLUMNS) {
    if (body[field] !== undefined) {
      updates[field] = validateTextField(body[field], field, ROTATION_SNAPSHOT_MAX_LENGTH);
    }
  }

  if (body.add_date !== undefined) {
    if (typeof body.add_date !== 'string' || !libraryService.isISODate(body.add_date)) {
      throw new WxycError('Bad Request, Incorrect Date Format: add_date should be of form YYYY-MM-DD', 400);
    }
    updates.add_date = body.add_date;
  }

  if (body.kill_date !== undefined) {
    if (body.kill_date !== null && (typeof body.kill_date !== 'string' || !libraryService.isISODate(body.kill_date))) {
      throw new WxycError('Bad Request, Incorrect Date Format: kill_date should be of form YYYY-MM-DD', 400);
    }
    updates.kill_date = body.kill_date;
  }

  // BS#2410's pre-catalog FKs. Deliberately NOT folded into the snapshot loop
  // above: that loop is keyed on `ROTATION_SNAPSHOT_COLUMNS` and runs
  // `validateTextField`, which would 400 every `format_id: 3` with "must be a
  // string". Integer + existence instead, so a stale id is a named 400 rather
  // than a PG 23503 → 500.
  for (const field of ROTATION_PRECATALOG_FK_FIELDS) {
    if (body[field] === undefined) continue;
    await assertRotationPrecatalogFk(field, body[field], { nullable: true });
    updates[field] = body[field] as number | null;
  }

  // BS#2473: `card_id` — a positive integer to move the row, or `null` to
  // uncard it. Shape-only here; existence and the row's-own-bin invariant
  // are the service's to assert (`resolveRotationCardId`, reused verbatim).
  if (body.card_id !== undefined) {
    if (body.card_id !== null && !(Number.isInteger(body.card_id) && (body.card_id as number) > 0)) {
      throw new WxycError('Invalid Parameter: card_id must be a positive integer, or null to uncard the row', 400);
    }
    updates.card_id = body.card_id as number | null;
  }

  if (body.urls !== undefined) {
    updates.urls = parseRotationUrls(body.urls);
  }

  // BS#2113 review finding 4: the linked/unlinked precondition lives in the
  // service's own compare-and-set UPDATE, not in a read taken here — see
  // `libraryService.updateRotation` for why.
  let outcome: libraryService.UpdateRotationOutcome;
  try {
    outcome = await libraryService.updateRotation(rotationId, updates);
  } catch (err) {
    if (err instanceof libraryService.RotationCardBinMismatchError) {
      res.status(409).json({ message: err.message, reason: 'rotation_card_bin_mismatch' });
      return;
    }
    throw err;
  }

  if (outcome.outcome === 'not_found') {
    throw new WxycError('Rotation entry not found', 404);
  }

  if (outcome.outcome === 'linked_conflict') {
    // The PRE-CATALOG list, not the snapshot trio: the service guards all five
    // on `album_id IS NULL`, so naming only the trio here would produce a 409
    // that lists none of the fields the caller actually sent when the sent
    // field was `format_id` or `label_id`.
    const precatalogFields = libraryService.ROTATION_PRECATALOG_FIELDS.filter((field) => body[field] !== undefined);
    throw new WxycError(buildLinkedSnapshotConflictMessage(precatalogFields, outcome.albumId), 409);
  }

  // Projected, not the bare `.returning()` row: `rotation` also carries
  // `legacy_rotation_id`, `legacy_library_release_id`, `discogs_release_id`,
  // `discogs_release_id_source`, `lml_identity_id` and the two attempt-at
  // markers, none of which any rotation read publishes -- and wxyc-shared#354
  // transcribes whatever this returns into a published contract.
  res.status(200).json(libraryService.toRotationRowSummary(outcome.rotation));
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

/**
 * Discogs autopopulate URL/id parse outcome. A discriminated union so the
 * handler maps each failure to a distinct named 4xx (the `code` is the
 * machine-readable `WxycError` discriminant the bench switches on).
 */
type DiscogsReleaseIdParse =
  | { ok: true; releaseId: number }
  | { ok: false; code: 'missing_url' | 'invalid_url' | 'not_release_url' | 'master_url'; message: string };

/**
 * Extract a Discogs release id from an operator-pasted release URL or a bare
 * numeric id, for the add-to-rotation bench's "Autopopulate with Discogs link".
 *
 * Accepted:
 *   - `https://www.discogs.com/release/{id}` and any `/{slug}/release/{id}`
 *     variant — any number of leading path segments, with the scheme, `www`,
 *     a `-{slug}` suffix on the id, query, and fragment all optional.
 *   - a bare positive integer, taken as the release id directly.
 *
 * MASTER LINKS ARE REJECTED (`master_url`), not resolved to their main
 * release. LML resolves a specific *release* id and exposes no
 * master→main-release lookup, so a master link (`discogs.com/master/{id}`)
 * cannot be prefilled — the operator must paste a specific release link. This
 * is the documented choice for the "reject or resolve main release" fork.
 *
 * The master check runs before the release check so a pathological path
 * carrying both segments rejects rather than silently resolving; a slug that
 * merely contains the word "master" (e.g. `/Grandmaster-Flash/release/{id}`)
 * is unaffected because the pattern anchors on `/master/` as a whole segment.
 */
export function parseDiscogsReleaseIdInput(raw: string): DiscogsReleaseIdParse {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, code: 'missing_url', message: 'A Discogs release URL or id is required' };
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    return Number.isSafeInteger(id) && id > 0
      ? { ok: true, releaseId: id }
      : { ok: false, code: 'invalid_url', message: 'Not a valid Discogs release id' };
  }

  let parsed: URL;
  try {
    // Accept scheme-less input (`www.discogs.com/release/123`) by defaulting
    // to https; a real scheme is left intact.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, code: 'invalid_url', message: 'Not a valid Discogs release URL' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'discogs.com' && !host.endsWith('.discogs.com')) {
    return { ok: false, code: 'invalid_url', message: 'Not a Discogs URL' };
  }

  if (/\/master\/\d+/.test(parsed.pathname)) {
    return {
      ok: false,
      code: 'master_url',
      message: 'Discogs master links cannot be autopopulated; paste a specific release link',
    };
  }

  const match = parsed.pathname.match(/\/release\/(\d+)/);
  if (!match) {
    return { ok: false, code: 'not_release_url', message: 'Not a Discogs release URL' };
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0
    ? { ok: true, releaseId: id }
    : { ok: false, code: 'invalid_url', message: 'Not a valid Discogs release id' };
}

/**
 * `GET /library/releases/discogs-prefill?url=` — resolve a Discogs release URL
 * (or bare id) to the bench's prefill fields via LML.
 *
 * Failure is always a named 4xx, never a 500: an unparseable / non-release /
 * master URL is a 400 carrying the parse `code`; a valid release id LML has
 * no record of is a 404 (`release_not_found`). A hard LML failure (timeout,
 * 5xx, unconfigured) bubbles as its `LmlClientError` upstream status because
 * the operator asked to resolve a specific link.
 */
export const getDiscogsReleasePrefill: RequestHandler = async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== 'string') {
    // Absent, or repeated (`?url=a&url=b` parses to an array): the endpoint
    // needs exactly one URL string.
    throw new WxycError('A single "url" query parameter is required', 400, { code: 'missing_url' });
  }

  const parsed = parseDiscogsReleaseIdInput(raw);
  if (!parsed.ok) {
    throw new WxycError(parsed.message, 400, { code: parsed.code });
  }

  const prefill = await libraryService.resolveDiscogsReleasePrefill(parsed.releaseId);
  if (prefill === null) {
    throw new WxycError('Discogs has no release for that link', 404, { code: 'release_not_found' });
  }

  res.status(200).json(prefill);
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

  // BS#2212: `parseAlbumId`, not `parseInt`. This branch is the front door for
  // dj-site's own permalinks and it had none of the discipline the legacy
  // branch above documents: `parseInt('65880xyz')` is 65880, so a truncated or
  // corrupted link resolved to a real, DIFFERENT release and returned it with
  // a 200, and `parseInt('abc')` is NaN, which postgres-js serialized as the
  // literal "NaN" for Postgres to reject with 22P02 -- a client-input 400
  // arriving as a server-fault 500, counted against 5xx alerting and captured
  // by Sentry. `parseResourceId` is the same guard every other `/library/:id`
  // route on this router uses; its `typeof rawId !== 'string'` check also
  // rejects the repeated-param case Express hands over as `string[]`.
  const album = await libraryService.getAlbumFromDB(parseAlbumId(query.album_id));
  // 404 on a miss, matching the legacy branch. This used to be a 200 carrying
  // an empty body, which satisfied neither the declared response schema nor
  // any consumer: dj-site's two readers collapse `isError || !data` into one
  // error card, and wxyc-dj-ios decodes into a non-optional `AlbumInfo`, so an
  // empty body already threw into its catch-and-degrade path.
  if (album === undefined) {
    throw new WxycError('No catalog album for that album_id', 404);
  }
  res.status(200).json(album);
};

const parseAlbumId = (rawId: string): number => parseResourceId(rawId, 'album');

// BS#2491: `PUT /library/:id/urls` (contract `AlbumUrlsUpdate`). The request
// body is modeled locally — the controller layer hand-validates bodies rather
// than importing the generated request type (same posture as
// `AddRotationRequestBody`) — and is `{ urls: string[] }`.
type AlbumUrlsUpdateBody = { urls?: unknown };

/**
 * `PUT /library/:id/urls` (BS#2491, definitive-release-links epic): set a
 * release's definitive streaming/reference links, replace-wholesale, then
 * reconcile them to LML's identity resolver (fail-open). Returns the re-read
 * album detail (the contract's `AlbumDetail`).
 *
 * Links are stored release-scoped (`library_urls`), independent of any
 * rotation stint — the rotation-add/filings arms capture the same set when a
 * catalogued release enters rotation, but this endpoint edits them without one.
 */
export const setAlbumUrls: RequestHandler<{ id: string }, unknown, AlbumUrlsUpdateBody> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);
  // Same bounds and verbatim-store discipline the rotation urls arm enforces
  // (≤20 entries, each a non-blank string of ≤2048 chars), reused so the two
  // url write surfaces cannot diverge. `urls` is required by the contract; an
  // absent body fails the array check as a 400.
  const urls = parseRotationUrls(req.body.urls);

  // The release must exist: replace-wholesale's DELETE plus an empty (or
  // fully-unreconciled) set would otherwise write nothing and 200 for a
  // non-existent id, so this existence check is what turns a bad id into a 404.
  if (!(await libraryService.libraryRowExists(albumId))) {
    throw new WxycError('No catalog album for that id', 404);
  }

  const album = await libraryService.setLibraryUrls(albumId, urls);
  if (album === undefined) {
    // The release was deleted between the existence check and the re-read.
    throw new WxycError('No catalog album for that id', 404);
  }
  res.status(200).json(album);
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
  // BS#2564: the PATCH half of BS#2410's release call-code fields. Reuses
  // `validateCodeNumber`/`validateCodeVolumeLetters` verbatim (defined above
  // for `addAlbum`), so the two write surfaces can't disagree on bounds.
  // `code_volume_letters` additionally accepts an explicit `null` here (a
  // create has no prior value to clear, so `addAlbum` never needed this) —
  // see the clearing block below.
  code_number?: number;
  code_volume_letters?: string | null;
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
  'code_number',
  'code_volume_letters',
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
    updates.album_title = validateTextField(body.album_title, 'album_title', MAX_ALBUM_TEXT_LENGTH);
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

  // BS#2564: reuses `addAlbum`'s validators verbatim. `code_volume_letters`'s
  // empty-string-means-NULL rule (see `validateCodeVolumeLetters`) has to be
  // coalesced explicitly here — the validator's `undefined` return means
  // "no volume letters" on a create, where the column simply isn't SET, but
  // on a PATCH an omitted `updates.code_volume_letters` means "leave the
  // stored value alone" (`updateAlbumInDB` only SETs keys `!== undefined`),
  // so clearing the field requires writing `null` explicitly. `null` is
  // handled ahead of `validateCodeVolumeLetters`, which only accepts a
  // string — the column is nullable and GET already emits this field as
  // `nullable: true`, so a client round-tripping a GET body into a PATCH
  // must be able to send back the `null` it just received.
  //
  // Hence the two different presence tests, which is the handler's standing
  // convention rather than an oversight: `'X' in body` marks a field whose
  // explicit null is a meaningful "clear it" (`alternate_artist_name`,
  // `label_id`, `discogsUnavailableNote`), and `body.X !== undefined` marks
  // one that has no null to express. `code_number` is `notNull`, so it stays
  // on the latter.
  if (body.code_number !== undefined) {
    updates.code_number = validateCodeNumber(body.code_number);
  }
  if ('code_volume_letters' in body) {
    updates.code_volume_letters =
      body.code_volume_letters === null ? null : (validateCodeVolumeLetters(body.code_volume_letters) ?? null);
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
      // number in the new artist's sequence. A code_number that DIFFERS from
      // the stored one is the operator deliberately choosing the destination
      // shelf, so it is written verbatim, uncollision-checked, same as every
      // other code_number write on this endpoint and on POST /library;
      // regenerating over it would silently discard that choice (BS#2564).
      //
      // The test is "differs", not "present", and the distinction is
      // load-bearing: a code_number that merely echoes the stored value
      // expresses no intent about the call number at all. dj-site's album
      // editor resubmits the whole record on Save (the same client shape the
      // #1555 short-circuit below exists for) and every read response carries
      // code_number, so a GET → PATCH round-trip hands this handler the
      // stored value whether or not the operator touched the field — the very
      // round-tripping that forces this endpoint to accept an explicit
      // `code_volume_letters: null` a few lines above. An echo is therefore
      // indistinguishable from "keep what's there", which is exactly what a
      // move did before this PR, so it falls through to the regenerate rather
      // than filing two releases into one (artist, code_number) slot. That
      // matters more than usual here: there is no application-level collision
      // check on this path and no DB uniqueness constraint yet (BS#2033), so
      // this regenerate is the only thing standing between a full-record
      // resubmit and a silent duplicate shelf slot.
      const clientChoseDestinationCodeNumber =
        body.code_number !== undefined && body.code_number !== existing.code_number;
      if (
        !clientChoseDestinationCodeNumber &&
        (await libraryService.albumCodeNumberTaken(body.artist_id, existing.code_number, albumId))
      ) {
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

  // Short-circuit a no-op edit: updateAlbumInDB SETs the submitted columns,
  // which fires the touch_library_watermark trigger and advances the catalog
  // conditional-GET watermark — forcing every iOS / dj-site poller to
  // re-download the full catalog for a write that changed nothing (#1555).
  // The trigger keys on those exported columns appearing in the SET list at
  // all, not on their values changing; `last_modified` is also always SET but
  // is outside the narrowed list (migration 0142) and cannot fire it alone. A
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
 * the issue's decision record for why. BS#2565 (D1) removed the 409 refusal
 * D10 used to raise when the release carried `flowsheet` plays, so the
 * delete now proceeds regardless of how many plays the release carries or
 * how they reach it. What actually happens to those plays — blanked via
 * `flowsheet.album_id` directly, blanked transitively via
 * `flowsheet.rotation_id` → `rotation.album_id`, or, for a play the
 * tubafrenzy webhook wrote that `jobs/legacy-linkage-resolve` had not yet
 * turned into an `album_id`, stranded rather than unlinked once the release
 * is gone — is reasoned about in `libraryService.deleteAlbumFromDB`'s
 * docstring, not reported here (see below for why, and for where it belongs
 * instead).
 * Still refuses with 409 when the release has a bound `digital_asset` row
 * (rip evidence / S3-backed files `jobs/digital-archive-bind` wrote): that FK
 * has no `onDelete` at all, so letting the delete reach it would either raise
 * a raw 500 or need the row destroyed to proceed, and audio-archive metadata
 * is exactly the kind of hand-entered, irreplaceable data this endpoint
 * otherwise snapshots rather than destroys.
 * `bins`, `library_identity`, `library_identity_source`, and
 * `artist_library_crossreference` are resolved explicitly inside the same
 * transaction as the delete (see `libraryService.deleteAlbumFromDB` for why
 * the fourth one is there — schema.ts and the live constraint disagree),
 * `album_popularity.representative_library_id` is nulled there for want of
 * any FK, and the release's `legacy_release_id` is recorded in
 * `library_delete_denylist` so `jobs/library-etl` cannot resurrect it; every
 * other dependent is either captured by `captureCatalogDeleteSnapshot` (see
 * that docstring in `schema.ts` for the exhaustive list) or left to its own
 * FK. Gated to `catalog:['write']`, the same bar as `updateAlbum`/`addAlbum`
 * — not the lighter `catalog:read` bar `markMissing`/`markFound` use, since
 * this is irreversible.
 *
 * A successful delete is a bodiless `204`. The release's flowsheet play
 * counts are NOT reported here: by the time this returns, the librarian has
 * already read the confirmation screen and pressed the button, so a count in
 * this response arrives too late to inform anything. The counts belong on a
 * pre-delete read, which this endpoint deliberately does not try to be.
 *
 * The `409` body is non-standard for this service (`{message, reason,
 * assets}` for the digital-asset refusal, rather than the error handler's
 * shape) because the specifics are the whole point of the refusal: the
 * librarian needs to know what the delete would have damaged, and how.
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

  if (result.outcome === 'has_digital_assets') {
    const { assets } = result;
    res.status(409).json({
      message: `Cannot delete: release has ${assets.length} digital asset${assets.length === 1 ? '' : 's'} on record (ids: ${assets.map((a) => a.id).join(', ')})`,
      reason: 'digital_asset_references',
      asset_count: assets.length,
      assets: assets.map((a) => ({
        id: a.id,
        provenance: a.provenance,
        disc_number: a.discNumber,
        status: a.status,
      })),
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
// Also reused by `getArtistReleases` (BS#2156) above -- module-level consts
// are in scope regardless of declaration order, and the two endpoints share
// this exact page-size convention rather than needing their own.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * How many un-warmed rows of one `/library/query` page may be sent to LML for
 * artwork.
 *
 * `enrichWithArtwork` fans out with an uncapped `Promise.allSettled` over every
 * un-cached row it is handed, and `library-enrich-artwork` is a class-2 caller
 * — it shares the process-wide `defaultLimiter` (5 concurrent, 50/min, 5s
 * bounded queue wait, circuit breaker) with `library-add-album`,
 * `library-track-search`, `library-canonical-entity`, and `request-line`. An
 * uncapped page is therefore not merely slow: at `MAX_LIMIT` it asks for twice
 * the limiter's entire per-minute budget in one burst, sheds most of itself as
 * `shed_limiter_saturated`, and each shed counts as a breaker failure — so a
 * catalog search can trip the breaker OPEN and fast-fail adding an album or a
 * request-line lookup. Class-2 sharing this limiter is deliberate (BS#994/#995
 * — a long-held permit back-pressures concurrent interactive lookups); the cap
 * is what keeps this endpoint inside that intent.
 *
 * `GET /library/` is not the precedent it looks like: `fuzzySearchLibrary`
 * defaults to `n = 5`, so the sibling warm is inherently small, and its one
 * caller that asks for more is a single submit rather than a debounced
 * keystroke feeding an infinite scroll.
 *
 * 5 matches the limiter's concurrency, so one page costs at most one full
 * permit-set and never queues behind itself. Repeated views of the same page
 * warm it further, a slice at a time — and BS#2522's negative marker is what
 * makes that progress monotonic, by retiring rows LML has definitively answered
 * so a later view's budget moves on to the next ones instead of re-buying the
 * same five refusals.
 */
export const ARTWORK_WARM_MAX_ROWS = 5;

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
 *
 * Artwork: rows carry `artwork_url` (`library.artwork_url`, `null` until LML
 * has resolved one), and enrichment runs fire-and-forget after the response
 * exactly as it does on `GET /library/` — see the call site below.
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

  // `searchForAlbum`'s fire-and-forget artwork warm (BS#1828), on this endpoint
  // too: off the response path so a slow/rate-limited LML is never
  // catalog-search latency, with the detached `updateArtworkUrl` cache-through
  // landing an un-warmed release's `artwork_url` on the NEXT read. Nothing else
  // on this path fills the column, so without it the projection above only ever
  // carries artwork a release happened to pick up via `GET /library/`.
  //
  // Started AFTER `res.json()`, where the sibling starts it before: this one
  // mutates `row.artwork_url` in place, and responding first makes "enriched
  // values never reach this response" hold by statement order rather than by
  // the enrichment's first await landing after serialization.
  //
  // Bounded twice, because this endpoint is a browse surface where the sibling
  // is not (see ARTWORK_WARM_MAX_ROWS):
  //   - Only on a real text query. A `q`-less page is a browse — the Missing
  //     Releases screen pulls `MAX_LIMIT` rows this way — and warming it means
  //     warming the whole catalog a page at a time.
  //   - Only `ARTWORK_WARM_MAX_ROWS` lookups, via `maxLookups` rather than a
  //     slice here. The whole un-warmed page goes in and the service applies the
  //     cap after dropping rows it has already definitively failed to resolve
  //     (BS#2522), so the budget always buys lookups that can still teach us
  //     something. Slicing first would hand the same permanently-unresolvable
  //     head rows over on every search and never reach the rows behind them.
  //
  // Rows are passed by reference, so the cache-through still writes through to
  // the same objects `enrichWithArtwork` would have selected itself.
  //
  // It collects per-row failures internally; this `.catch` only keeps a
  // whole-promise rejection from becoming an unhandledRejection.
  const unwarmed = q.trim() ? results.filter((row) => row.artwork_url == null) : [];
  if (unwarmed.length > 0) {
    libraryService.enrichWithArtwork(unwarmed, { maxLookups: ARTWORK_WARM_MAX_ROWS }).catch((err) => {
      console.warn('[Library] Catalog-query artwork enrichment failed:', err);
    });
  }
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
