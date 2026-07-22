# 0012 — External critic-review snippets are attributed, link-out, and a fourth distinct "review" concept

Short attributed excerpts from external music-critic reviews (Pitchfork, The Quietus, and the crawled review corpus in [`WXYC/research-data`](https://github.com/WXYC/research-data)) surface in the iOS playcut detail view. They live in their own table, [`album_critic_reviews`](../../shared/database/src/schema.ts) (migration 0125), keyed on `library.id`, and are served as an additive optional `criticReviews` array on `GET /proxy/metadata/album` (contract: `CriticReviewItem` in [wxyc-shared `api.yaml`](https://github.com/WXYC/wxyc-shared/pull/243)). This is the fourth distinct "review" concept in the stack and does NOT extend any of the other three.

The four concepts and why none of them is this one:

- **`reviews`** ([ADR 0006](0006-reviews-model-extension.md)) — the one-per-album, author-owned (`author_dj_id` FK to `auth_user`), MD-queued in-app Review model at `/reviews`. Authored by WXYC DJs, mutable, library-bound. Critic reviews are third-party, not DJ-authored, and there are many per album.
- **`album_review_submissions`** ([ADR 0011](0011-album-review-submissions-separate-archive.md)) — the ~1,650 DJ-written Google-Form reviews, an append-only PII-internal archive. Also WXYC-authored; critic reviews carry no PII and are meant to be shown with attribution, the opposite posture.
- **`AlbumReview` DTO** (wxyc-shared #229, closed) — reserved for the ADR 0006 in-app model's wire shape. `CriticReviewItem` is deliberately named to avoid colliding with it.
- **`album_critic_reviews`** (this ADR) — external, third-party, attributed, multiple per album, keyed on `library.id`.

## Departure from "Complement, Don't Confirm"

[`WXYC/wiki` `research/review-corpus-analysis.md`](https://github.com/WXYC/wiki/blob/main/research/review-corpus-analysis.md) established the **"Complement, Don't Confirm"** doctrine: the crawled critic corpus is used _internally_ — as an unattributed signal that informs WXYC's own editorial voice — and is never republished as third-party opinion, because doing so both dilutes the station's freeform identity and raises the copyright question of redistributing full critic text.

This slice consciously departs on the second half. It surfaces **short attributed excerpts with a link-out to the source**, not full text and not an unattributed signal. The departure is bounded so it stays defensible:

- **Length.** The seed writer trims each `snippet` to ≤300 characters (a 512-char column gives headroom but the writer is the cap). Short, attributed, transformative-context excerpts with a link to the full review are the standard fair-use quotation posture for editorial aggregators.
- **Attribution + link-out, always.** `source` and `source_url` are `NOT NULL`. The UI shows the publication name and links out; it never presents critic text as WXYC's.
- **No scores as the primary artifact.** `rating` is optional metadata, not the surfaced content. We show what a critic _said_, attributed, not a decontextualized number.
- **Complement still holds for the corpus's internal uses.** Nothing here changes how the corpus informs internal editorial work; this adds a second, separately-governed, attributed surface.

## Decision

- `album_critic_reviews` is the store for external attributed critic snippets: multiple per album, keyed on `album_id` → `library.id` (`ON DELETE CASCADE` — a critic snippet has no meaning once its library album is gone), `(album_id, source_url)` as the UPSERT conflict target so a re-seed refreshes rather than duplicates.
- Two ingestion sources feed the one table through a single seed writer: (a) **structured relations** (publisher review APIs / linked-data where a review URL is directly resolvable for a release) and (b) the **existing crawled corpus** in `research-data`. `source` records the publication; `source_key` records the writer's provenance handle so a given source's rows can be re-driven idempotently.
- The serve path is **flag-gated** behind `CRITIC_REVIEWS_ENABLED` (strict `=== 'true'`, default `false`), attaches `criticReviews` to the `GET /proxy/metadata/album` response **only when non-empty**, and does the extra read in a `try/catch` that degrades to omitting the field. With the flag off (the production default), the response shape and the serve-path query plan are byte-for-byte unchanged. This keeps the change compatible with the [Post-launch service hardening](https://github.com/orgs/WXYC/projects/32) freeze on the album-metadata serve path: no behavior ships to prod until an operator opts in, at which point the added query's cost can be measured against #32's perf budgets deliberately.
- The wire contract is additive and optional (`CriticReviewItem` requires only `source`/`url`/`snippet`), so iOS `decodeIfPresent` and dj-site optional chaining stay decode-compatible whether or not the field is present.

## Consequences

- Later work touching "reviews" now has four concepts to disambiguate; this ADR and [ADR 0011](0011-album-review-submissions-separate-archive.md) together are the boundary markers.
- The seed writer is the sole writer of `album_critic_reviews`; manual corrections (should any be needed) win over it, mirroring the `album_review_submissions.album_id` link-pass posture.
- Flipping `CRITIC_REVIEWS_ENABLED=true` adds one indexed read (`album_id` equality on `album_critic_reviews`) to the album-metadata serve path. That is the only prod-latency change and it is opt-in; enabling it is a decision for the #32 owners, not a side effect of this merge.
- The fair-use posture is a per-source judgment. If a specific publisher's terms forbid excerpting, that source is excluded at the seed writer, not litigated in the serve path — the table trusts its writer.
