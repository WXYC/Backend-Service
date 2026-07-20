/**
 * Thin re-export shim — the tubafrenzy HTTP mirror client moved to the shared
 * `@wxyc/legacy-mirror` package (BS#1707) so the `jobs/legacy-mirror-reconcile`
 * cron can re-drive orphaned rows through byte-identical payload mapping.
 *
 * This path is preserved deliberately: `flowsheet.mirror.ts` still imports from
 * `./http.mirror.js`, and the collaborator unit tests mock this module path
 * (`jest.mock('.../legacy/http.mirror')`). Re-exporting here keeps both working
 * without touching a single import site. New code should import from
 * `@wxyc/legacy-mirror` directly.
 */
export * from '@wxyc/legacy-mirror';
