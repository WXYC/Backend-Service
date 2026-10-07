/**
 * The review gate's vocabulary (BS#2807, epic #2791): the basis a caller names when it inserts a library or rotation
 * row, and the refusal when the basis does not hold. The checks themselves live in `library.service.ts`'s
 * `insertAlbum` / `addToRotation`, which verify a basis inside their own transaction. A leaf module, so the controllers
 * and the filing service can name these without importing the service.
 *
 * - `intake`: `POST /intake/{id}/file`. The item has an accepted review (`mayFileItem`).
 * - `existing_release`: `POST /library/rotation` with an `album_id`. The library row exists; every library row either
 *   predates the cutover or came through intake filing, so re-rotating it is allowed.
 * - `pre_cutover`: every other caller, accepted only while the gate is off (`isGateOn`).
 * - `legacy_import` (BS#2810): `POST /library` with `from_rotation_id`. The rotation row is legacy (see
 *   `review-gate-legacy.ts`); accepted on either side of the cutover date.
 * - `legacy_move` (BS#2810): the typed-text arm of `POST /library/rotation` with `moved_from_rotation_id`. The source
 *   row is legacy and active, and the same transaction kills it; accepted on either side of the date.
 */
export type GateBasis =
  | { kind: 'intake'; intakeItemId: number }
  | { kind: 'existing_release'; albumId: number }
  | { kind: 'pre_cutover' }
  | { kind: 'legacy_import'; rotationId: number }
  | { kind: 'legacy_move'; fromRotationId: number };

/** What `POST /library/filings` and `fileLibraryRelease` take: it writes a library row AND a rotation row, so neither legacy basis (each licenses only one of them) nor `existing_release` (no new release) fits. */
export type NewReleaseGateBasis = Extract<GateBasis, { kind: 'intake' | 'pre_cutover' }>;

/** What `insertAlbum` takes: a new library row, so `existing_release` and `legacy_move` (a rotation row) are out. */
export type AlbumInsertGateBasis = NewReleaseGateBasis | Extract<GateBasis, { kind: 'legacy_import' }>;

/** What `addToRotation` takes: a rotation row, so `legacy_import` (a library row) is out. */
export type RotationInsertGateBasis =
  NewReleaseGateBasis | Extract<GateBasis, { kind: 'existing_release' | 'legacy_move' }>;

/** A gate basis did not hold. The routes answer it as the 409 `{ message, reason: 'review_required' }`. */
export class ReviewRequiredError extends Error {
  readonly reason = 'review_required' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ReviewRequiredError';
  }

  /** The contract's 409 body. */
  toBody() {
    return { message: this.message, reason: this.reason };
  }
}

/** A legacy basis did not hold: the rotation row is linked, not legacy, gone, or (for a move) no longer active. The routes answer it as the 409 `{ message, reason: 'rotation_not_eligible' }`. */
export class RotationNotEligibleError extends Error {
  readonly reason = 'rotation_not_eligible' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RotationNotEligibleError';
  }

  /** The contract's 409 body. */
  toBody() {
    return { message: this.message, reason: this.reason };
  }
}
