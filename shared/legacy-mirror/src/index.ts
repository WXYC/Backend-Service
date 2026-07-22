/**
 * @wxyc/legacy-mirror — shared tubafrenzy legacy-mirror client (BS#1707).
 *
 * Single source of truth for the tubafrenzy mirror payload shape and the
 * outbound HTTP calls. Consumed by:
 *   - the Express app's live mirror middleware (`apps/backend/middleware/legacy/`,
 *     via thin re-export shims that preserve existing import sites), and
 *   - the `jobs/legacy-mirror-reconcile` cron, which re-drives show/entry rows
 *     whose one-shot `res.finish` mirror attempt was skipped.
 *
 * Extracted from `apps/backend/middleware/legacy/{http.mirror,rotation-match.mirror}.ts`
 * so both consumers share byte-identical payload mapping (a re-implementation
 * would drift). Kept out of `@wxyc/database` deliberately: this is an outbound
 * REST + Sentry client, not ORM/schema access.
 */
export * from './http-mirror.js';
export * from './rotation-match.js';
