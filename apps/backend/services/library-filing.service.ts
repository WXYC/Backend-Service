import * as Sentry from '@sentry/node';
import { checkStreamingAvailability, isLmlConfigured } from '@wxyc/lml-client';
import { Album, db, parseRotationBin, RotationBin, RotationRelease, ROTATION_BINS } from '@wxyc/database';
import { INT2_MAX, INT4_MAX } from '../utils/constants.js';
import WxycError from '../utils/error.js';
import { getPostHogClient } from '../utils/posthog.js';
import { lmlLookupCoordinator } from './lml/index.js';
import { filterSpacerGif } from './metadata/metadata.service.js';
import * as labelsService from './labels.service.js';
import * as libraryService from './library.service.js';

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
export const resolveNewAlbumLabel = async (
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

// `POST /library/filings` (BS#2474; wxyc-shared `LibraryFilingRequest`).
// `release` is `AlbumCreateFields` (every `addAlbum` field except the artist
// reference pair). `rotation`, given, is the release's initial rotation
// entry — no `album_id` on it, since that FK is this same release. Moved
// here from the controller (BS#2793) alongside `fileLibraryRelease`, the
// other caller that needs it.
export type FilingReleaseBody = {
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

export type FilingRotationBody = {
  rotation_bin?: string;
  card_id?: number | null;
  urls?: unknown;
};

export type LibraryFilingRequestBody = {
  artist?: FilingArtistBody;
  release?: FilingReleaseBody;
  rotation?: FilingRotationBody;
};

/**
 * The plan `planLibraryFiling` resolves before `fileLibraryRelease` runs:
 * either the fields to create a new artist under, or the already-catalogued
 * artist it referenced. The conflict pre-checks that produce it live in
 * `planLibraryFiling`, and `mapLibraryFilingError` maps the transaction's
 * own failures onto the route's 409/400.
 */
export type LibraryFilingPlan =
  | { kind: 'create'; artist_name: string; alphabetical_name: string; code_letters: string; code_number: number }
  | { kind: 'existing'; artist: FilingArtist };

/**
 * The request's release fields as `planLibraryFiling` hands them on: the
 * three required fields are typed as present (`album_title` is checked to be
 * a non-blank string; `genre_id` and `format_id` are only checked to be
 * defined), `code_volume_letters` and `supplied_code_number` (the operator's
 * `code_number`) have been through `validateCodeVolumeLetters` /
 * `validateCodeNumber`, and every other `FilingReleaseBody` field is the
 * request's value, unchecked. The object is built by spreading the raw
 * release body, so it can also carry keys the type does not name.
 */
export type ValidatedFilingRelease = Omit<FilingReleaseBody, 'code_number'> & {
  album_title: string;
  genre_id: number;
  format_id: number;
  supplied_code_number?: number;
};

/** The request's rotation entry as `planLibraryFiling` hands it on: `rotation_bin` is the canonical enum value (via `parseRotationBin`) and `urls` has been through `parseRotationUrls`, and `card_id`, when present, is checked to be a positive integer. */
export type ValidatedFilingRotation = { rotation_bin: RotationBin; card_id?: number; urls?: string[] };

/** Everything `fileLibraryRelease` and `completeLibraryFiling` read, as produced by `planLibraryFiling`; see the field types for what each part has been checked for. */
export type ValidatedFilingInput = {
  filingPlan: LibraryFilingPlan;
  release: ValidatedFilingRelease;
  rotation?: ValidatedFilingRotation;
};

/** The 409 body `wxyc-shared`'s `LibraryFilingConflictError` declares. */
export type LibraryFilingConflictError = {
  message: string;
  reason: 'artist_code_conflict' | 'artist_name_conflict' | 'rotation_card_bin_mismatch';
  artist?: FilingArtist;
  code?: string;
};

/**
 * The composite write for `POST /library/filings` (BS#2474): artist
 * (create-or-reference), release, and an optional rotation entry, in ONE
 * transaction — a mid-chain failure rolls back everything already written
 * this request, including an artist the create arm just inserted and a
 * `labels` row the release's label text minted. Composed from the same
 * writes `addArtist`/`addAlbum`/`addRotation` use
 * (`insertArtistWithGenreCrossreference` / `resolveNewAlbumLabel` /
 * `insertAlbum` / `addToRotation`), each threaded onto this function's own
 * `tx` (see `DbTransaction`'s doc comment for why a nested bare
 * `db.transaction()` inside those functions would NOT roll back with it).
 * The reads inside the transaction ride the same `tx` — a bare `db` read
 * there borrows a SECOND pool connection while this one sits reserved, and
 * enough concurrent filings would each hold a connection while waiting on a
 * read none of them can be granted (`addToRotation`'s identity-read comment
 * has the mechanics). Everything with no write to protect — the conflict
 * pre-checks — runs BEFORE the transaction, in `planLibraryFiling`, on the
 * plain pool.
 *
 * Extracted from `createLibraryFiling` (BS#2793) so slice 11 (filing an
 * intake item) can run this same transaction as one step of its own, larger
 * composite — `outerTx`, given, is run against directly instead of opening a
 * nested transaction that wouldn't share the caller's rollback.
 */
export async function fileLibraryRelease(input: ValidatedFilingInput, outerTx?: libraryService.DbTransaction) {
  const { filingPlan, release, rotation: rotationBody } = input;
  const { genre_id: release_genre_id, format_id: release_format_id, album_title } = release;
  const { code_volume_letters, supplied_code_number } = release;

  const run = async (tx: libraryService.DbTransaction) => {
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
      supplied_code_number ?? (await libraryService.generateAlbumCodeNumber(artistRow.id, release_genre_id, tx));
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
  };

  return outerTx ? run(outerTx) : db.transaction(run);
}

// `POST /library/filings` (BS#2474; wxyc-shared `LibraryFilingRequest`).
// `artist` is discriminated by `kind`: `create` carries the exact
// `POST /library/artists` fields, `existing` names an already-catalogued
// row.
export type FilingArtistBody = ({ kind: 'create' } & NewArtistRequest) | { kind: 'existing'; artist_id: unknown };

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
export type FilingArtist = {
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

/** Unicode-code-point length, matching OpenAPI `maxLength` semantics (a UTF-16 `.length` over-counts astral characters). */
export function codePointLength(value: string): number {
  return [...value].length;
}

/** `true` only for a string with at least one non-whitespace character. */
export function isNonBlankString(value: unknown): value is string {
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
 * rotation snapshot fields' `codePointLength` convention in the controller). Entries are stored
 * trimmed and otherwise verbatim.
 */
export function parseRotationUrls(value: unknown): string[] {
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
export const validateCodeNumber = (code_number: unknown): number => {
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
export const validateCodeVolumeLetters = (code_volume_letters: unknown): string | undefined => {
  if (typeof code_volume_letters !== 'string') {
    throw new WxycError('code_volume_letters must be a string', 400);
  }
  const trimmed = code_volume_letters.trim();
  if (codePointLength(trimmed) > MAX_CODE_VOLUME_LETTERS_LENGTH) {
    throw new WxycError(`code_volume_letters must be ${MAX_CODE_VOLUME_LETTERS_LENGTH} characters or fewer`, 400);
  }
  return trimmed || undefined;
};

export type NewArtistRequest = {
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
 * the production clone (see `resolveArtistByCode` in the library controller, which accepts 0 for
 * the same reason) — and this endpoint accepted 0 unvalidated for its whole
 * life before BS#2475. The write path must not refuse a value the catalog
 * demonstrably holds and the read path resolves; the contract's floor is the
 * side that needs amending.
 */
export const validateArtistCodeNumber = (code_number: unknown): number => {
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
 * and write in the create path must key on (see the normalization comment in `addArtist`, in the library controller).
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
export const validateArtistCodeLetters = (code_letters: unknown): string => {
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
 * the whole retry — see the recompute branch in `planLibraryFiling` and in `addArtist`, in the library controller.
 */
export const assignArtistCodeNumber = async (code_letters: string, genre_id: number): Promise<number> => {
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
export async function enrichNewAlbum(
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
export function fireAndForgetCanonicalEntity(libraryId: number, artistName: string | null, albumTitle: string): void {
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

/**
 * Everything `POST /library/filings` does before it opens its transaction
 * (BS#2474; extracted from `createLibraryFiling`, BS#2819): request
 * validation, then artist resolution and the conflict pre-checks, all on the
 * plain pool. Returns the validated input `fileLibraryRelease` runs, or the
 * `LibraryFilingConflictError` body a pre-check answers 409 with; every other
 * failure throws `WxycError(…, 400)`.
 *
 * Conflict pre-checks mirror `addArtist`'s exact sequence and residual-race
 * posture. The `kind: 'existing'` arm resolves the referenced artist's
 * crossreference IN `release.genre_id` specifically, not the lowest-genre
 * collapse `GET /library/artists/:id` answers with: the release is filed
 * under that genre, so the artist code echoed back must be the code for
 * that shelf. An artist with no membership in the release's genre is a 400
 * (the create arm's mirror guard is the `artist.genre_id === release.genre_id`
 * equality check), as is a dangling `artist_id` — the contract declares no
 * 404 on this route.
 *
 * Code-number exhaustion — `assignArtistCodeNumber`'s 409, which the
 * standalone endpoint emits as `{message, code}` — is answered as
 * `reason: 'artist_code_conflict'` (its remedy is the same: pick/supply
 * another code) with the standalone's `code: 'artist_code_number_exhausted'`
 * alongside as the finer discriminant, because `reason` is required by the
 * contract and its enum has no exhaustion member. It is the one
 * `artist_code_conflict` 409 with no `artist` to name.
 */
export async function planLibraryFiling(
  body: LibraryFilingRequestBody
): Promise<{ kind: 'ok'; input: ValidatedFilingInput } | { kind: 'conflict'; body: LibraryFilingConflictError }> {
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

  let rotationBody: ValidatedFilingRotation | undefined;
  // != null: clients that serialize "no rotation" as an explicit null get the
  // omitted-rotation filing, not a TypeError from the property reads below.
  if (body.rotation != null) {
    const rot = body.rotation;
    // BS#2203: parse once and forward the canonical bin, so `fileLibraryRelease`
    // receives a `RotationBin` the enum column can store, never a raw cast.
    const parsedBin = parseRotationBin(rot.rotation_bin);
    if (parsedBin.kind !== 'bin') {
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
      rotation_bin: parsedBin.bin,
      card_id: rot.card_id ?? undefined,
      urls: rot.urls !== undefined ? parseRotationUrls(rot.urls) : undefined,
    };
  }

  // Artist resolution and conflict pre-checks: plain-pool reads BEFORE the
  // transaction, `addArtist`'s exact sequence and precedence (code conflict
  // wins over name conflict; the server-assigned arm recomputes once on a
  // pre-check hit). Residual races carry `addArtist`'s documented
  // single-librarian acceptance.
  let filingPlan: LibraryFilingPlan;
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
        return {
          kind: 'conflict',
          body: {
            message: 'Artist code already exists for that genre and code letters.',
            reason: 'artist_code_conflict',
            artist: {
              id: existing.artist_id,
              artist_name: existing.artist_name,
              code_letters: existing.code_letters,
              code_artist_number: code_number,
              genre_id: artistBody.genre_id,
            } satisfies FilingArtist,
          },
        };
      }
    } catch (err) {
      // See the doc block: exhaustion is a real conflict but the contract's
      // `reason` enum has no member for it, so it rides the code-conflict
      // reason (same remedy) with the standalone endpoint's `code` kept as
      // the precise discriminant.
      if (err instanceof WxycError && err.code === 'artist_code_number_exhausted') {
        return {
          kind: 'conflict',
          body: { message: err.message, reason: 'artist_code_conflict', code: err.code },
        };
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
      return {
        kind: 'conflict',
        body: {
          message: 'Artist name already exists in that genre.',
          reason: 'artist_name_conflict',
          artist: artistCardToFilingArtist(conflicting),
        },
      };
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

  return {
    kind: 'ok',
    input: {
      filingPlan,
      release: {
        ...release,
        album_title,
        genre_id: release_genre_id,
        format_id: release_format_id,
        code_volume_letters,
        supplied_code_number,
      },
      rotation: rotationBody,
    },
  };
}

/**
 * The post-commit tail of `POST /library/filings`: the SAME LML enrichment
 * `POST /library` runs (`enrichNewAlbum`: streaming + artwork + canonical
 * entity) and the LML reconcile of any rotation urls — after the transaction
 * commits, never inside it, because those are network hops. Returns the
 * response body.
 */
export async function completeLibraryFiling(
  result: Awaited<ReturnType<typeof fileLibraryRelease>>,
  input: ValidatedFilingInput
) {
  const { release, rotation: rotationBody } = input;

  // Post-commit, never in-transaction: the same enrichment the standalone
  // add runs, so a record filed here carries the same on_streaming /
  // artwork_url / canonical entity it would get from `POST /library`.
  const enrichedRelease = await enrichNewAlbum(
    result.release,
    release.alternate_artist_name || result.artist.artist_name,
    result.artist.artist_name,
    release.album_title
  );

  // BS#2491: a filing always produces a catalogued release, so any provided
  // urls were written release-scoped into `library_urls` inside the
  // transaction (`fileLibraryRelease`). Reconcile them to LML after the
  // commit — fail-open, and outside the transaction so no row lock is held
  // across the hop.
  if (rotationBody?.urls && rotationBody.urls.length > 0) {
    await libraryService.reconcileLibraryUrlsToLml(rotationBody.urls);
  }

  return { ...result, release: enrichedRelease };
}

/**
 * Maps a failure from `fileLibraryRelease` / `completeLibraryFiling` onto the
 * route's declared responses: returns the 409 body for a rotation-card/bin
 * mismatch, throws the 400 for a dangling `card_id`, rethrows anything else.
 */
export function mapLibraryFilingError(err: unknown): LibraryFilingConflictError {
  if (err instanceof libraryService.RotationCardBinMismatchError) {
    return { message: err.message, reason: 'rotation_card_bin_mismatch' };
  }
  // `resolveRotationCardId`'s dangling-card 404 (see its `code` comment):
  // this route's contract declares no 404, so the dangling reference is
  // remapped onto the declared validation 400, message and `code` intact.
  if (err instanceof WxycError && err.code === 'rotation_card_not_found') {
    throw new WxycError(err.message, 400, { code: err.code });
  }
  throw err;
}
