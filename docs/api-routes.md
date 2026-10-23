# API server reference

Route-table detail and routing notes moved verbatim out of `CLAUDE.md`. `CLAUDE.md` keeps the short route table and middleware list.

## Route detail

### `/album-reviews`

Form-review archive reads (ADR 0011). Role-gated `album_reviews:read` (dj+), NOT anonymous auth — it serves the whole archive with no `social_consent` filter, so the gate is the safety argument. Explicit projection: returns the reviewer's name as `reviewer` (decision 14, `docs/pii.md`); never `social_consent_raw` or the ETL bookkeeping columns. The public `wxycReviews` attach stays nameless. A row `jobs/album-reviews-import` has copied into `reviews` (BS#3132) is left out while that imported review exists and listed again if it is deleted; [ADR 0011](adr/0011-album-review-submissions-separate-archive.md) sets out exactly when. The gate, columns and consent posture are unchanged.

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

### `/labels/{id}`

Label admin (BS#3289). `GET` (`catalog:read`) returns the label with `references` (`library`, `rotation`, `flowsheet`, `intake_items` row counts) and `child_labels`. `PATCH` (`catalog:write`) takes `label_name` and/or `parent_label_id` (nullable) and returns `{ label, rewritten }`: a rename rewrites the non-null name copies beside every `label_id` in the same transaction; a name that belongs to another label is a 409 `label_name_taken` (merge instead, BS#3290) and a parent that is the label or a descendant is a 400 `label_parent_cycle`. `DELETE` (`catalog:write`) is 204, or 409 `label_in_use` with `details: { references, child_labels }` while any foreign key or child label points at the row; the guard is referential only. The (table, FK column, text column) list is `apps/backend/services/label-references.service.ts`; a unit test fails when `schema.ts` gains an unlisted `references(() => labels.id)`. The wire contract lives in `wxyc-shared/api.yaml` (WXYC/wxyc-shared#760).

## `/flowsheet` and the V2 projection

**There is no `/v2/flowsheet` route, and CLAUDE.md's route table used to claim there was.** `app.ts` mounts no `/v2` router; `projectEntriesV2` (`utils/album-metadata-projection.ts`) is called by `getEntries`, the handler mounted at plain `GET /flowsheet`, so **the V2 discriminated-union shape ships on the V1 path**. Three source comments still name `/v2/flowsheet` as though it were mounted (`utils/album-metadata-projection.ts:5`, `services/flowsheet.service.ts:392`, `services/playlist-proxy.service.ts:451`) — read those as naming the projection, not a route. `api.wxyc.org/v2/flowsheet` returns 404 with an HTML `Cannot GET` body, and always has.

The prefix was planned and never mounted. Mounting it now would mean maintaining two paths to one projection for zero callers, so `@wxyc/shared` deleted the two `/v2/flowsheet*` declarations from `api.yaml` in [WXYC/wxyc-shared#372](https://github.com/WXYC/wxyc-shared/issues/372) / [PR #378](https://github.com/WXYC/wxyc-shared/pull/378) and moved the explanation into `GET /flowsheet`'s description. This table was the second place the error was written down; correcting both together is the point.

### `PATCH /flowsheet/shows/{id}`

Tags or corrects a show's `specialty_id` and `show_name` (BS#3456). `requirePermissions({ flowsheet: ['write'] })`, then `mayEditShow` against the target loaded by `loadShowEditTarget` in the same transaction as the write: a `flowsheet: manage` caller (music director or station manager) may edit any show, open or ended (BS#3678); anyone else needs to be a DJ on the show while it is on the air, gets 400 as a non-member of an open show, and 403 `closed_show` once it has ended. Writes no flowsheet row, so the `touch_flowsheet_watermark_from_shows` trigger (migration 0204) is what moves `GET /flowsheet`'s validator; every `UPDATE` on `shows` bumps it, including a sign-off's and `closeShowFromTerminalShowEndMarker`'s usually-empty one. `afterShowTagged` is the seam BS#3467's poster binding hangs on.

### `POST /flowsheet` with `entry_type: spotlight`

Adds a who's-on row (BS#3460) to any open show, freeform included, from any DJ on it; `FLOWSHEET_SPOTLIGHT_ENABLED` off answers 403 `spotlight_disabled` first. The handler validates `spotlight_role` and `spotlight_name` (`services/flowsheet/spotlight.ts`), refuses any track field with 400 (one `SPOTLIGHT_FORBIDDEN_FIELDS` list shared with `PATCH`), composes `message` itself and ignores a client-sent one, and inserts through `addTrack` without touching `inferMessageEntryType`. `getOnAir` reads the open show's newest spotlight once, before `request_line`, and passes its role to `effectiveRequestMode` (BS#3472: a performer or reader closes a requests-mode line as `closed`/`spotlight`; never a DJ choice or feedback); it returns the row as `on_air.spotlight` (`null` when none; key absent while the flag is off or the read fails); `transformToV2` emits the same shape for the row in `entries`.

## Middleware notes

- ~~Legacy mirror middleware~~ — Removed in BS#2403. It synced flowsheet writes out to tubafrenzy over HTTP REST (`deleteEntry` via raw SQL over SSH) and back-stamped `shows.legacy_show_id` / `flowsheet.legacy_entry_id`. Retired after Milestone 1 (WXYC/wiki#93) took `wxyc.info/playlists/*` to 410. The **inbound** direction is deliberately still live: `POST /internal/flowsheet-webhook` remains routed. The rotation webhook (`POST /internal/rotation-webhook`) is retired: it had one sender, tubafrenzy's `/wxycdb`, which went dark on 2026-09-16, and the route now returns 404.

## Server timeout

Server timeout is 35 seconds globally — strictly greater than the LML client's 30 s `AbortController` (`@wxyc/lml-client`, `shared/lml-client/src/index.ts`) so a slow LML lookup's catch path can flush a 200-with-fallback response instead of racing the socket teardown to a CORS-less 502. SSE routes opt out via `res.setTimeout(0)`. Swagger API docs are served at `/api-docs` from `app.yaml` — Swagger-UI display only, **not** a codegen source; the cross-repo SSOT is `wxyc-shared/api.yaml` (see CLAUDE.md's Schema-first rule).
