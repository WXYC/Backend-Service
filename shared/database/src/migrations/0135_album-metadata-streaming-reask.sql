-- 0135 — WXYC/Backend-Service#1915: bounded self-heal of unresolved
-- streaming links, consuming LML#1053's per-service verdict
-- (verified/absent/unresolved) on `DiscogsMatchResult.streaming_status`.
--
-- Problem: a `*_url` column alone can't distinguish "consulted, genuinely
-- absent" from "couldn't check, transient" — both leave it NULL, so the
-- pre-#1915 enrichment worker either re-asked every null forever
-- (resurrecting the #1747 per-play LML-call amplifier) or froze a
-- transient Apple/Spotify null permanently. These 4 columns give the
-- worker the substrate to tell the two apart and bound the retry:
--
--   - `spotify_status` / `apple_music_status` / `bandcamp_status` — TEXT
--     with a documented vocabulary rather than a pgEnum (the 0109 lesson:
--     enum-value additions cost their own migration), mirroring this
--     file's `source`-style columns. Values: 'verified' | 'absent' |
--     'unresolved'. NULL = never consulted (LML's key-omission
--     convention) and must NOT be treated as 'absent'.
--   - `streaming_reask_attempts` — ONE shared per-album counter, not
--     per-service: a single LML re-ask resolves all three services'
--     verdicts at once. Bounds the re-ask loop (see
--     `apps/enrichment-worker/enrich.ts`'s `STREAMING_REASK_ATTEMPT_CAP`).
--
-- Operationally: four `ADD COLUMN`s on an existing table, three plain
-- nullable TEXT (no default, no constraint) and one `INTEGER DEFAULT 0
-- NOT NULL` — every existing row gets the default at add time, so the
-- `NOT NULL` is provably safe with no precondition guard needed
-- (`scripts/validate-migrations.mjs` Check 8's documented exception:
-- DEFAULT paired with NOT NULL). PG11+ metadata-only add-column for a
-- constant default — no table rewrite, no long lock.
--
-- @no-precondition-needed: all four columns are additive (nullable TEXT,
-- or NOT NULL with a DEFAULT applied to existing rows at add time); no
-- data invariant on current rows can be violated.

ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "spotify_status" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "apple_music_status" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "bandcamp_status" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "streaming_reask_attempts" integer DEFAULT 0 NOT NULL;