/**
 * BS#2558: the ONE predicate `apps/auth/app.ts` hands to `express.json({ type: ... })`
 * so Express's JSON body parser accepts the same media-type surface better-call
 * actually parses as JSON.
 *
 * `express.json()`'s default `type` option (`'application/json'`) matches the
 * Content-Type header EXACTLY (via `type-is`). better-call's own JSON gate
 * (`node_modules/better-call/dist/utils.mjs`'s `jsonContentTypeRegex`) is an
 * UNANCHORED, case-insensitive regex tested against the raw header — it also
 * matches `application/jsonx`, `application/json-patch+json`,
 * `application/json5`, and anything else starting `application/` and ending
 * in (optionally prefixed) `json`. A request in that gap was fully parsed and
 * acted on by better-auth while `express.json()` silently declined to parse
 * it, leaving `req.body` undefined for every OTHER Express consumer on the
 * request — including the account-audit middleware
 * (`account-audit-middleware.ts`), which resolves `subject_user_id` from
 * `req.body` on 18 mounts (`audit-coverage.ts`'s `FLAT_MOUNTS` +
 * `ADMIN_ACTIONS`). The fix widens Express's gate to match better-call's,
 * verbatim, so the two parsers agree on what counts as a JSON body.
 *
 * Deliberately mirrors ONLY better-call's PARSE gate, not its separate
 * `allowedMediaTypes` ADMISSION gate (the substring test
 * `normalizedContentTypeBase.includes("application/json")` that
 * better-auth's router configures globally — see
 * `node_modules/better-auth/dist/api/index.mjs`,
 * `allowedMediaTypes: ["application/json"]`). That second gate decides
 * whether better-call 415s a request outright and is independent of whether
 * it goes on to parse the body as JSON — mirroring the PARSE gate here is
 * what keeps `req.body` in sync between the two layers. A content type that
 * fails this regex (e.g. `text/plain`) is left unparsed by `express.json()`,
 * exactly as before the fix; it still reaches better-call's own
 * `allowedMediaTypes` check on the SAME raw body (better-call re-reads the
 * untouched stream itself — see `canReadRawBody` in
 * `better-call/dist/adapters/node/request.mjs`) and 415s unaffected, so this
 * widening cannot admit anything better-call would reject.
 *
 * See WXYC/Backend-Service#2558 and
 * `tests/unit/auth/json-content-type.test.ts` /
 * `tests/unit/auth/audit-content-type-parity.test.ts` for the regression
 * coverage, including a real (unmocked) round-trip through better-call's own
 * `createRouter`/`toNodeHandler`.
 */
import type { IncomingMessage } from 'http';

/** Verbatim copy of better-call's `jsonContentTypeRegex` (`node_modules/better-call/dist/utils.mjs`). */
export const BETTER_CALL_JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * `express.json()`'s `type` option accepts `(req: http.IncomingMessage) => any`
 * (`@types/body-parser`) — typed against `IncomingMessage`, not Express's own
 * `Request`, to match that signature exactly rather than unsoundly narrowing
 * it (body-parser's `type` predicate must accept whatever request it is
 * handed).
 */
export const isBetterCallJsonRequest = (req: IncomingMessage): boolean => {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && BETTER_CALL_JSON_CONTENT_TYPE.test(contentType);
};
