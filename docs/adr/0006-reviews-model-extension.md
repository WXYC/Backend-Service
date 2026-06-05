# 0006 — Reviews are one-per-album, author-owned, internal-only, with an MD-curated queue

We extend (not replace) the existing [`reviews`](../../shared/database/src/schema.ts) table into the canonical Review model. Each Album has at most one Review; the Review is owned by `author_dj_id` (FK to `auth_user.id`); the existing `author varchar(32)` column becomes the at-write display-name snapshot (Q12b resolution in the iOS grilling). New columns: `headline` (≤140 chars), `rotation_hint` enum (`yes_promote` / `maybe` / `no_skip`), `fcc_explicit` boolean, `tags` (FK to a new tag vocabulary table), and split-out tables `review_callouts` (`track_title`, `comment`, `polarity`) and `review_queue` (`album_id`, `added_by_md_id`, `added_at`, claim state with 14-day soft lock). Rating is numeric in half-star increments 0.5–5.0.

Editing rules: author edits anytime; MD can transfer authorship (handles departed authors / fresh-take requests); other DJs writing on an already-reviewed album request takeover via MD. The MD queue is **guidance, not a gate** — any DJ can author a review for any album, but the queue surfaces "albums that need a take." When a DJ claims a queued album, the resulting review's `rotation_hint` becomes required (otherwise optional).

Internal-only for v1 — reviews visible to signed-in users on iOS and dj-site, not on listener-facing wxyc.org. A `published_publicly` boolean is the future migration to listener-facing publication (paired with the equivalent DJ profile public-handle work — see [`dj-site/694-public-dj-handle`](https://github.com/WXYC/dj-site)).

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0005](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0005--reviews-are-one-per-album-author-owned-internal-only-with-an-md-curated-queue).

## Consequences

- Schema deltas: extend `reviews`, add `review_queue`, `review_callouts`, `tag_vocabulary`. All Drizzle migrations under [`shared/database/src/migrations/`](../../shared/database/src/migrations/).
- Endpoints (none exist today): `GET/POST/PATCH/DELETE /reviews`, `GET/POST/DELETE /review-queue`, `POST /review-queue/{id}/claim`, `POST /review-queue/{id}/release`, MD-gated tag-vocabulary CRUD.
- Tag vocabulary is MD-curated rather than freeform — prevents tag-soup, gives MDs a real editorial knob.
- The `published_publicly` flag is forward-compatible: when listener-facing publication ships, the migration is a flag flip plus a wxyc.org consumer, not a model rewrite.
