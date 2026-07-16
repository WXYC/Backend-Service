# 0011 — Form-sourced album review submissions are a separate archive, not the ADR 0006 Review model

WXYC's ~1,650 DJ-written album reviews collected since March 2021 through the "Album Review Responses" Google Form live in their own table, [`album_review_submissions`](../../shared/database/src/schema.ts) (migration 0119), synced nightly by [`jobs/album-reviews-etl/`](../../jobs/album-reviews-etl/) and read at `GET /album-reviews`. They do NOT extend the existing `reviews` table, which [ADR 0006](0006-reviews-model-extension.md) (canonical cross-repo ADR 0005 in the iOS DJ-tool repo) reserves as the one-per-album, author-owned (`author_dj_id` FK to `auth_user`), MD-queued in-app Review model with CRUD at `/reviews`.

The two review concepts conflict on every structural axis, which is why merging them was rejected (decision 2026-07-16, user-confirmed, after a first draft that evolved `reviews` was invalidated in review):

- **Cardinality**: the form archive holds multiple independent reviews per album (14 (artist, album) pairs have 2–3 today); ADR 0006's `reviews` is at most one per album (`album_id` UNIQUE).
- **Authorship**: form reviewers are free-text strings — many are alumni with no `auth_user` row and never will have one; ADR 0006 reviews are owned by a real account with edit/transfer rules.
- **Mutability**: form submissions are an append-only archive curated only via the sheet (the ETL UPSERTs content edits but never deletes and never reassigns identity); ADR 0006 reviews are living documents with author edits, MD transfer, and a claim queue.
- **Identity**: a submission's identity is free-text `(artist_name, album_title)` plus its `source_key`; `album_id` is a best-effort, never-overwritten singleton link that survives library deletions (FK ON DELETE SET NULL). ADR 0006 reviews are library-bound by construction.

## Decision

- `album_review_submissions` is the form archive: append-only, multi-per-album, free-text identity, PII-internal reviewer fields (`reviewer_raw`, `social_consent_raw`) that no read endpoint ever emits (the `flowsheet.dj_name` posture — the form promised "your name will not be shared").
- The read surface is `GET /album-reviews` (with the resource-named `album_reviews` response array). The `/reviews` namespace, the `reviews` table, ADR 0006, and `tests/integration/fk-on-delete-flowsheet-rotation-reviews.spec.js` stay untouched and reserved for the in-app Review model.
- Neither model migrates into the other. A future in-app Review MAY cite a submission row as provenance (e.g. a `submission_id` reference added by the ADR 0006 implementation), but that is a citation, not a merge.

## Consequences

- Later work touching "reviews" must first decide which of the two concepts it means; this ADR is the boundary marker that prevents the archive from being folded into the in-app model (or vice versa) by well-meaning consolidation.
- The archive's writer is exactly one job (`jobs/album-reviews-etl/`); its link pass is the only writer of `album_review_submissions.album_id`, and manual corrections always win over it.
- The dormant `feature/library-code-lookup-reviews` branch (PR #212, closed stale 2026-05-09) targets ADR 0006's `reviews` and is unaffected.
