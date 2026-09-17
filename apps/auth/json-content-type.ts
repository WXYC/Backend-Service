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
 * Deliberately mirrors ONLY better-call's PARSE gate (`jsonContentTypeRegex`),
 * not its separate `allowedMediaTypes` ADMISSION gate (the substring test
 * `normalizedContentTypeBase.includes("application/json")` that
 * better-auth's router configures globally — see
 * `node_modules/better-auth/dist/api/index.mjs`,
 * `allowedMediaTypes: ["application/json"]`). That second gate decides
 * whether better-call 415s a request outright and is independent of whether
 * it goes on to parse the body as JSON. The parse gate is what governs
 * whether better-call actually POPULATES the body it (and every consumer
 * downstream of `express.json()`, including the account-audit middleware)
 * acts on — that's the surface that determines audit fidelity, so that's
 * the one this predicate mirrors.
 *
 * The two gates are NOT the same shape, though, and the parse regex is a
 * SUPERSET of the admission substring test rather than identical to it:
 * `application/vnd.api+json`, `application/hal+json`, and
 * `application/ld+json` all MATCH this predicate (so `express.json()` parses
 * them) but FAIL better-call's admission test —
 * `"application/vnd.api+json".includes("application/json")` is `false`, the
 * literal substring never appears — so better-call 415s them anyway, after
 * Express has already parsed a body it's about to reject. That IS a real
 * widening for those three types (previously left unparsed by
 * `express.json()`'s exact-match default), not a no-op, but a harmless one:
 * the request is rejected either way, and the account-audit middleware
 * still records the rejection (`outcome: 415`, `subject_user_id` NULL —
 * gated to 2xx outcomes on public mounts, same as any other 415). See
 * `tests/unit/auth/json-content-type.test.ts`'s "Express now parses but
 * better-call rejects" block and the Finding-4 round-trip in
 * `tests/unit/auth/audit-content-type-parity.test.ts` for the empirical
 * proof. Mirroring the admission gate instead of (or in addition to) the
 * parse gate would not close this gap — it's inherent to the two gates
 * disagreeing on a handful of types — and risks the opposite failure:
 * silently declining to parse something better-call would still go on to
 * accept and act on.
 *
 * A content type that fails the parse regex too (e.g. `text/plain`) is left
 * unparsed by `express.json()`, exactly as before the fix; it still reaches
 * better-call's own `allowedMediaTypes` check on the SAME raw body
 * (better-call re-reads the untouched stream itself — see `canReadRawBody`
 * in `better-call/dist/adapters/node/request.mjs`) and 415s unaffected, so
 * this widening cannot admit anything below the parse-regex line.
 *
 * `allowedMediaTypes` is also not a safety net for every consumer of this
 * predicate — only requests that reach better-auth's router go through it
 * at all. `/auth/wxyc/station-signup` (public, creates an account),
 * `/auth/wxyc/complete-onboarding` (public, sets a password from an invite
 * token), `/auth/wxyc/lookup-email`, `/auth/check-request-ban`,
 * `/auth/admin/provision-user`, the six `/auth/admin/station-signup/*` ops,
 * and three non-production test endpoints are hand-written Express routes
 * in `apps/auth` that read `req.body` directly and never reach better-call
 * — for those, this predicate is the ONLY content-type gate. The safety
 * argument for them is different and load-bearing: every type this
 * predicate admits still starts with `application/`, so a cross-origin POST
 * to any of them still triggers a CORS preflight (a non-simple
 * `Content-Type` per the Fetch/CORS spec), and the browser only sends the
 * real request if that preflight is answered with matching CORS headers —
 * which `app.ts`'s CORS config fails closed on absent an allowed origin
 * (BS#1107). `text/plain` — the one `Content-Type` that CAN escape preflight
 * as part of a "simple request" — correctly stays outside this predicate's
 * surface, unparsed, exactly as before. This constrains any FUTURE widening
 * of this predicate: admitting a type that doesn't start with `application/`
 * (or that's otherwise preflight-exempt) would forfeit this property and
 * needs its own CSRF analysis — it can't lean on this paragraph.
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
