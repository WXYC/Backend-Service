# API server reference

Route-table detail and routing notes moved verbatim out of `CLAUDE.md`. `CLAUDE.md` keeps the short route table and middleware list.

## Route detail

### `/album-reviews`

Form-review archive reads (ADR 0011). Role-gated `album_reviews:read` (dj+), NOT anonymous auth — it serves the whole archive with no `social_consent` filter, so the gate is the safety argument. Explicit projection: returns the reviewer's name as `reviewer` (decision 14, `docs/pii.md`); never `social_consent_raw` or the ETL bookkeeping columns. The public `wxycReviews` attach stays nameless.

### `/library/rotation/thresholds`

The station-wide rotation thresholds (`RotationThresholds`): per-bin `window_days` (H/M/L/S) and `card_stale_days`, held in the single-row `rotation_thresholds` table (migration seeds 60/60/60/60/30 only where absent). `GET` is `catalog: read`, `PATCH` is `catalog: write`. `PATCH` is partial at both levels (`{}` and `{"window_days": {}}` are 200 no-ops), each day count an integer in 1..365, an explicit `null` or an unknown key at either level a 400 naming it; the response is always the whole record. The literal path must stay registered above both `GET` and `PATCH /rotation/:id` (pinned by `library-rotation-route-order.route.test.ts`). Validation lives in `apps/backend/utils/rotation-thresholds.ts`, the single `UPDATE` in `apps/backend/services/rotation-thresholds.service.ts`.

### `/digital-archive`

Presigned playback manifests into the auto-DJ Space (BS#2320, ADR 0014). Role-gated `digital_archive:listen` (dj+) AND flag-gated `DIGITAL_ARCHIVE_STREAMING_ENABLED`, checked before any DB read. 403 = off/below dj; 404 = permitted but nothing bound and servable — never a 200 with empty tracks.

### `/intake`

DJ album-review intake. Role-gated `reviews:read` (dj+) for reads; `reviews:write` (dj+) for checkout, release, accept and pass; `reviews:manage` (MD+) for log, patch, delete, request, cancel-request, accept-review and print; filing takes `reviews:manage` plus `catalog:write`; finalize takes `catalog:write`. Rules and per-route detail: [`docs/intake-and-reviews.md`](intake-and-reviews.md#intake)

### `/reviews`

In-app DJ reviews. Role-gated `reviews:write` (dj+) to create, edit, submit and delete; `reviews:read` for reads; `reviews:manage` for the manager paths. Rules and per-route detail: [`docs/intake-and-reviews.md`](intake-and-reviews.md#reviews)

### `/fcc-notes`

FCC notes on the record. `reviews:write` (dj+) to report, `reviews:read` to list a record's notes, `reviews:manage` to confirm and to list every unconfirmed note (`status=reported`); the reporter may delete their own reported note, a music director any. Rules and per-route detail: [`docs/intake-and-reviews.md`](intake-and-reviews.md#fcc-notes)

## `/flowsheet` and the V2 projection

**There is no `/v2/flowsheet` route, and CLAUDE.md's route table used to claim there was.** `app.ts` mounts no `/v2` router; `projectEntriesV2` (`utils/album-metadata-projection.ts`) is called by `getEntries`, the handler mounted at plain `GET /flowsheet`, so **the V2 discriminated-union shape ships on the V1 path**. Three source comments still name `/v2/flowsheet` as though it were mounted (`utils/album-metadata-projection.ts:5`, `services/flowsheet.service.ts:392`, `services/playlist-proxy.service.ts:451`) — read those as naming the projection, not a route. `api.wxyc.org/v2/flowsheet` returns 404 with an HTML `Cannot GET` body, and always has.

The prefix was planned and never mounted. Mounting it now would mean maintaining two paths to one projection for zero callers, so `@wxyc/shared` deleted the two `/v2/flowsheet*` declarations from `api.yaml` in [WXYC/wxyc-shared#372](https://github.com/WXYC/wxyc-shared/issues/372) / [PR #378](https://github.com/WXYC/wxyc-shared/pull/378) and moved the explanation into `GET /flowsheet`'s description. This table was the second place the error was written down; correcting both together is the point.

## Middleware notes

- ~~Legacy mirror middleware~~ — Removed in BS#2403. It synced flowsheet writes out to tubafrenzy over HTTP REST (`deleteEntry` via raw SQL over SSH) and back-stamped `shows.legacy_show_id` / `flowsheet.legacy_entry_id`. Retired after Milestone 1 (WXYC/wiki#93) took `wxyc.info/playlists/*` to 410. The **inbound** direction is deliberately still live: `POST /internal/flowsheet-webhook` remains routed. The rotation webhook (`POST /internal/rotation-webhook`) is retired: it had one sender, tubafrenzy's `/wxycdb`, which went dark on 2026-09-16, and the route now returns 404.

## Server timeout

Server timeout is 35 seconds globally — strictly greater than the LML client's 30 s `AbortController` (`@wxyc/lml-client`, `shared/lml-client/src/index.ts`) so a slow LML lookup's catch path can flush a 200-with-fallback response instead of racing the socket teardown to a CORS-less 502. SSE routes opt out via `res.setTimeout(0)`. Swagger API docs are served at `/api-docs` from `app.yaml` — Swagger-UI display only, **not** a codegen source; the cross-repo SSOT is `wxyc-shared/api.yaml` (see CLAUDE.md's Schema-first rule).
