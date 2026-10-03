import { db, RotationBin, RotationRelease } from '@wxyc/database';
import type { FilingArtist, FilingArtistBody } from '../controllers/library.controller.js';
import WxycError from '../utils/error.js';
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
 * The validated plan `createLibraryFiling` resolves before this function
 * runs: either the fields to create a new artist under, or the already-
 * catalogued artist it referenced. Conflict pre-checks and their 409 mapping
 * stay in the controller — see its doc comment.
 */
export type LibraryFilingPlan =
  | { kind: 'create'; artist_name: string; alphabetical_name: string; code_letters: string; code_number: number }
  | { kind: 'existing'; artist: FilingArtist };

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
 *
 * Extracted from `createLibraryFiling` (BS#2793) so slice 11 (filing an
 * intake item) can run this same transaction as one step of its own, larger
 * composite — `outerTx`, given, is run against directly instead of opening a
 * nested transaction that wouldn't share the caller's rollback.
 */
export async function fileLibraryRelease(
  input: {
    filingPlan: LibraryFilingPlan;
    release: FilingReleaseBody;
    release_genre_id: number;
    release_format_id: number;
    album_title: string;
    code_volume_letters?: string;
    supplied_code_number?: number;
    rotationBody?: { rotation_bin: RotationBin; card_id?: number; urls?: string[] };
  },
  outerTx?: libraryService.DbTransaction
) {
  const {
    filingPlan,
    release,
    release_genre_id,
    release_format_id,
    album_title,
    code_volume_letters,
    supplied_code_number,
    rotationBody,
  } = input;

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
