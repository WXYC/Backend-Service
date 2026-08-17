/**
 * Optional machine-readable discriminant for a `WxycError`. `reason` is a
 * stable string a client can switch on without parsing English `message`
 * prose; `details` carries structured context alongside it (e.g. the
 * conflicting value). Both are opt-in — omitting them keeps the response
 * shape exactly `{ message }`, so this is purely additive: existing
 * `throw new WxycError(message, statusCode)` call sites are unaffected.
 */
export interface WxycErrorOptions {
  reason?: string;
  details?: Record<string, unknown>;
}

export default class WxycError extends Error {
  statusCode: number;
  readonly reason?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number = 500, opts?: WxycErrorOptions) {
    super(message);
    this.name = 'WxycError';
    this.statusCode = statusCode;
    this.reason = opts?.reason;
    this.details = opts?.details;
  }
}
