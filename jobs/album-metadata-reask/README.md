# album-metadata-reask

One-shot job that re-asks LML for `album_metadata` rows whose stored Discogs release disagrees with the catalog card's current LML pin (`pin_mismatch`), or still serves a pin that the pin review removed (`pin_removed`). It is step 3 of the `album_metadata` remediation; the plan, decisions and slices are on the tracker, [WXYC/Backend-Service#3137](https://github.com/WXYC/Backend-Service/issues/3137).

## Status

In progress. The entrypoint still logs a `not_implemented` error line and exits 1; it reads and writes nothing. Do not run it.

Landed so far:

- The package scaffold ([#3140](https://github.com/WXYC/Backend-Service/issues/3140)).
- `cohort.ts` ([#3142](https://github.com/WXYC/Backend-Service/issues/3142)): the read-only cohort counts and enumeration; see its docblock. Built as `dist/cohort.cjs` for `tests/integration/album-metadata-reask.spec.js`.

## Build and deploy

- `"job-type": "one-shot"`: no schedule.
- `deploy-base.yml` builds and pushes the image on any push to `main` that changes this directory or `Dockerfile.album-metadata-reask`. Until the run loop lands, that image only exits 1.
- Local build: `npm run build --workspace=jobs/album-metadata-reask`. Typecheck: `npm run typecheck --workspace=jobs/album-metadata-reask` (also a CI step, since the root typecheck skips `jobs/**`).

## Provenance

The package layout, `tsup.config.ts`, `tsconfig.json` and the Dockerfile are copied from `jobs/album-metadata-bio-fill` (decision 6 on #3137: copy, extract when a third job needs it). `logger.ts` is the per-job logger copy every job carries; consolidating them is [#615](https://github.com/WXYC/Backend-Service/issues/615).
