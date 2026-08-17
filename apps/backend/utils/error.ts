/**
 * Optional machine-readable discriminant for a `WxycError`. `code` is a
 * stable string a client can switch on without parsing English `message`
 * prose; `details` carries structured context alongside it (e.g. the
 * conflicting value). Both are opt-in — omitting them keeps the response
 * shape exactly `{ message }`, so this is purely additive: existing
 * `throw new WxycError(message, statusCode)` call sites are unaffected.
 *
 * Field names and shape mirror `wxyc-shared/api.yaml`'s `ApiErrorResponse`
 * (`message` required, `code` and `details` optional, `details` an object)
 * — the cross-repo SSOT `$ref`'d across the spec and generated into
 * TypeScript/Python/Swift/Kotlin client models. This type conforms to that
 * schema rather than inventing its own, so a generated consumer decodes an
 * enriched WxycError response the same way it decodes every other endpoint's
 * error body.
 */
export interface WxycErrorOptions {
  code?: string;
  details?: Record<string, unknown>;
}

export default class WxycError extends Error {
  statusCode: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number = 500, opts?: WxycErrorOptions) {
    super(message);
    this.name = 'WxycError';
    this.statusCode = statusCode;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}
