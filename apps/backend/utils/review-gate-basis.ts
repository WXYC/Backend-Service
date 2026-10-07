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
 */
export type GateBasis =
  { kind: 'intake'; intakeItemId: number } | { kind: 'existing_release'; albumId: number } | { kind: 'pre_cutover' };

/** The bases that can stand behind a NEW release: `existing_release` names a row that is already there, so `insertAlbum` and `POST /library/filings` never take it. */
export type NewReleaseGateBasis = Exclude<GateBasis, { kind: 'existing_release' }>;

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
