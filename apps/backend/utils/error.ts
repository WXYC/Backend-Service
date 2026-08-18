import type { ApiErrorResponse } from '@wxyc/shared';

/**
 * Optional machine-readable discriminant for a `WxycError`. `code` is a
 * stable string a client can switch on without parsing English `message`
 * prose; `details` carries structured context alongside it (e.g. the
 * conflicting value). Both are opt-in — omitting them keeps the response
 * shape exactly `{ message }`, so this is purely additive: existing
 * `throw new WxycError(message, statusCode)` call sites are unaffected.
 *
 * DERIVED from `wxyc-shared/api.yaml`'s `ApiErrorResponse` rather than
 * restated, so a spec change (a `details` value-type narrowing, a new
 * optional field) reaches this file as a type error instead of silently
 * drifting. That SSOT is `$ref`'d across the spec and generated into the
 * TypeScript/Python/Swift/Kotlin client models, so a generated consumer
 * decodes an enriched WxycError response the same way it decodes every
 * other endpoint's error body.
 */
export type WxycErrorOptions = Pick<ApiErrorResponse, 'code' | 'details'>;

export default class WxycError extends Error {
  statusCode: number;
  readonly code?: ApiErrorResponse['code'];
  readonly details?: ApiErrorResponse['details'];

  constructor(message: string, statusCode: number = 500, opts?: WxycErrorOptions) {
    super(message);
    this.name = 'WxycError';
    this.statusCode = statusCode;
    this.code = opts?.code;
    this.details = opts?.details;
  }

  /**
   * The wire body for this error. Owning the projection here rather than in
   * `errorHandler` keeps the shape with the error that defines it, gives the
   * BS#2198 `reason`→`code` consolidation a single site to migrate, and
   * leaves room for `LmlClientError` to satisfy the same contract later.
   *
   * Conditional spreads rather than always-present keys: a `WxycError` with
   * neither `code` nor `details` serializes to exactly `{ message }`,
   * byte-for-byte what this handler has always returned — pinned by the "no
   * extra keys" test in `errorHandler.test.ts`. `details` nests under its own
   * key rather than spreading flat, per the schema's `details: {type: object}`.
   */
  toApiErrorResponse(): ApiErrorResponse {
    return {
      message: this.message,
      ...(this.code !== undefined && { code: this.code }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}
