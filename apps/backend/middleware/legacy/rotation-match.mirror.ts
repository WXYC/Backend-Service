/**
 * Thin re-export shim — the active-rotation-match probe moved to the shared
 * `@wxyc/legacy-mirror` package (BS#1707) alongside the HTTP mirror client, so
 * the `jobs/legacy-mirror-reconcile` cron can classify re-driven rotation
 * tracks with the same `flowsheetEntryType=2` badge the live path assigns.
 *
 * Path preserved deliberately: `flowsheet.mirror.ts` still imports
 * `isActiveRotationMatch` from `./rotation-match.mirror.js`, and the loop-prevention
 * unit tests mock this module path. New code should import from
 * `@wxyc/legacy-mirror` directly.
 */
export * from '@wxyc/legacy-mirror';
