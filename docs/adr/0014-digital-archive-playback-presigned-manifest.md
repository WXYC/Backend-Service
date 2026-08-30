# 0014 — Digital-archive playback is a generic multi-store presigner, gated on its own grant key and its own flag

`GET /digital-archive/albums/:id/playback` (BS#2320, contract wxyc-shared#417/#422, epic WXYC/wxyc-dj-ios#135) turns a `library.id` into a presigned `DigitalArchivePlaybackManifest` for the auto-DJ archive player. It is the read side of BS#2318's manifest schema (`digital_asset`/`digital_asset_file`/`digital_asset_store`) and BS#2319's binder job — this ADR records the decisions specific to serving it.

## Why presigned URLs, not a proxy stream

`AVPlayer` loads media out-of-process (a separate process on iOS/tvOS/watchOS handles the actual network fetch), so it cannot carry a bearer token the way a normal `fetch()` call can. A presigned URL is the only workable auth shape here: the credential lives in the URL itself, has a bounded lifetime (`expires_at`, configurable via `DIGITAL_ARCHIVE_SIGN_TTL_SECONDS`, default 4 hours), and never touches Backend-Service's own auth machinery. This is also why the response promises `Cache-Control: private, no-store` and why the presigner (`digital-archive-store.service.ts`) never logs a minted URL — it is a bearer credential from the moment it's returned.

The presigner's store key is READ-ONLY by design. A leaked signer key can only mint GET URLs against the buckets it's scoped to; it cannot write, delete, or list.

## Why a generic multi-store presigner, not a hardcoded S3 client

`presignGet(storeName, key, ttlSeconds)` resolves endpoint/region/bucket/credentials from `DIGITAL_ARCHIVE_STORE_<NAME>_ENDPOINT`/`_BUCKET`/`_KEY_ID`/`_SECRET`, keyed on the `digital_asset_store.name` DB column (today, `azuracast`). This is deliberately reusable rather than a `digital-archive`-specific S3 client: the horizontal-auth Track G migration (`wiki/proposals/auth/horizontal-auth-extension.md`) plans a second signer, for the broadcast archive, and the intent is that it adds a second `DIGITAL_ARCHIVE_STORE_<NAME>_*` env quartet and a second `digital_asset_store` row rather than a second presigning code path.

`<NAME>` is the store name UPPERCASED with `-` turned into `_`, done **explicitly** in `envNameFor` rather than left as an implicit convention — the store name is free text in the DB (`digital_asset_store.name`, no enum), so the transform has to be a real function callers can point to, not tribal knowledge about how today's one row happens to be spelled.

## Merge every bound asset; provenance and disc_number are per-track

`digital_asset`'s unique key is `(library_id, provenance, disc_number)`, so one album can have several `bound` rows — a multi-disc set today (same provenance, several `disc_number`s), and eventually a `cd_rip` alongside an existing `rotation_upload`. The manifest merges every `bound` asset for the album with **no precedence rule**. This is possible because wxyc-shared#422 moved `provenance` off the manifest and onto `DigitalArchivePlaybackTrack`, specifically so a merged manifest never has to elect a winner and misreport every track sourced from the others. `disc_number` is likewise projected per track from its parent asset, since it lives on `digital_asset`, not `digital_asset_file` — the manifest's `(disc_number, track_number NULLS LAST, title)` ordering therefore reads across the join.

All five codecs the schema recognizes (`mp3`, `aac`, `flac`, `m4a`, `wav`) are served; there is no mp3-only filter. A track can carry more than one rendition (the same logical track backfilled to a second format); the client picks whichever codec it can play.

## 200 means playable: no bound asset with zero servable files is a 200

`DigitalArchivePlaybackManifest.tracks` and `DigitalArchivePlaybackTrack.renditions` carry no `minItems` in the wire contract, so an empty-`tracks` `200` (or a track with empty `renditions`) is schema-legal but was left undefined by the contract review on purpose — it is a decision that belongs to this handler, not the SSOT. The 403/404 split this endpoint is built around is: `403` = feature off or caller below `dj`; `404` = permitted, but nothing to play. A `200` with zero playable tracks breaks that contract for a client that reasonably treats any `200` as "playable" — it opens an empty player with no error path, where a `404` would have rendered the correct "nothing bound yet" message.

Decision: a bound `digital_asset` whose files are absent, not yet ingested, or (once a per-file readiness column exists) all unready is **not** a bound asset for playback purposes. `getPlaybackManifest` returns `null` in that case, never an empty manifest, and the controller turns `null` into `404`. The same rule applies one level down: a track whose renditions are all unservable is omitted from `tracks` rather than emitted empty; if that leaves zero tracks, the whole response is `404`. This keeps "200 means you can play this" true, and it is why `has_digital_audio` on the catalog export is computed as a format-blind `EXISTS (... status = 'bound')` — the two surfaces agree about what counts as "has audio" without either one filtering by codec or readiness.

## A flag that changes the catalog export must be able to move the watermark itself

`GET /library/catalog` is served through `conditionalGet` against `library_watermark`, so a device with an unchanged `Last-Modified` gets a cheap `304` forever. `DIGITAL_ARCHIVE_STREAMING_ENABLED` changes what that export projects (`has_digital_audio`) without writing to any `library`/`digital_asset` row, so it cannot rely on an existing trigger to advance the watermark. `catalog-export-flag-reconcile.service.ts`'s `reconcileCatalogExportFlag` runs once at startup, diffs the env value against the last-observed value recorded in `catalog_export_flag_state` (BS#2318 migration 0158), and calls `wxyc_schema.touch_library_watermark_now()` (migration 0159's callable wrapper around the 0104 trigger's own UPDATE) exactly when the value changed. Every flag flip already recreates the EC2 container (`set-ec2-env-var.yml`), so running this at boot is exactly the right moment — no separate manual step in the normal light-up path.

First boot, with no `catalog_export_flag_state` row for the name at all, treats absent as `false` rather than "unknown" — the same value a client's `has_digital_audio` decode already assumes for an absent key. A first boot with the flag off therefore writes the row (so the next boot has a real value to diff against) but does not touch the watermark, since nothing observable changed; a first boot with the flag on both writes and touches, since that genuinely is a change from what every client currently believes.

## Its own grant key, not a reuse of `catalog: read`

`digital_archive: listen` is a new key in `auth.roles.ts`'s station domain, granted to `dj`/`musicDirector`/`stationManager` and explicitly denied (`[]`) to `member` — mirroring `album_reviews`'s shape and reasoning exactly (`auth.roles.ts:76`/`:236`). It is not folded into `catalog: read`, which `member` already holds: the file's standing rule is that a key belongs to the resource it names, and reusing a wider key would silently open playback to `member` the next time `catalog: read` is re-granted for an unrelated reason.

## Consequences

- A second store (the horizontal-auth Track G broadcast-archive signer) is expected to add one `digital_asset_store` row and one `DIGITAL_ARCHIVE_STORE_<NAME>_*` env quartet, not a second presigning module.
- `has_digital_audio` and the playback endpoint's `404` share one definition of "servable" (`digital_asset.status = 'bound'`, format-blind); a future per-file readiness column has to be threaded through both call sites or they will disagree about which albums are playable.
- `reconcileCatalogExportFlag` is written to take any flag name, so a second catalog-export-affecting flag can reuse it directly (`reconcileCatalogExportFlag('SOME_OTHER_FLAG')`) rather than growing its own reconciliation logic.
