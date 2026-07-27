# album-critic-reviews-etl

Weekly cron ETL (BS#1830, album-critic-reviews slice / [ADR 0012](../../docs/adr/0012-external-critic-reviews.md)): the production follow-on to the one-off `scripts/seed-critic-reviews.ts` manual seed (~1,823 rows, 2026-07-26). Downloads the extracted review manifest published by [`WXYC/research-data`](https://github.com/WXYC/research-data) as its `manifest-latest` release's `manifest.jsonl.gz` asset, matches each `CorpusItem` to a linked library album via the shared exact resolver, extracts a <=300-char attributed snippet with Haiku for **new** items only, and idempotently UPSERTs into `album_critic_reviews` (migration 0125) keyed on `(album_id, source_url)`.

Structural donor: [`jobs/album-reviews-etl/`](../album-reviews-etl/README.md) (same shape: fetch external corpus, map, UPSERT with `IS DISTINCT FROM` no-churn, run guards, `DRY_RUN`, cron). The seed script's Haiku extraction + snippet cap/trim logic is lifted into `extract.ts`, not imported — the script transitively pulls `apps/backend`, which would break this job's Docker build stage.

## Schedule

`10 7 * * 0` UTC (weekly, Sunday 07:10) from `package.json`'s `cron-schedule`, registered by deploy-base. This job doesn't touch LML, so [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md)'s spacing policy doesn't govern it, but it shares EC2 + Postgres with the cron fleet and stays out of the busy 04:15–06:17 UTC stack; `:10` is clear of every current cron, and the weekly pollution check is Monday 07:00 (no collision).

## Environment

See [`docs/env-vars.md`](../../docs/env-vars.md) for the full reference. Required: `RESEARCH_DATA_TOKEN` (read-only token for the private `WXYC/research-data` repo — a fine-grained PAT with `Contents: Read-only`, or a classic PAT with `repo` scope; always required, even under `DRY_RUN`, since a dry run still validates against the real manifest). `ANTHROPIC_API_KEY` is required for a real run but NOT under `DRY_RUN` (a dry run makes zero LLM calls by design). Optional: `DRY_RUN`, `SENTRY_DSN`.

## Manifest contract (cross-repo interface — `WXYC/research-data`)

One `CorpusItem` JSON object per line in `manifest.jsonl`, published gzipped as the `manifest-latest` release's sole asset `manifest.jsonl.gz`:

```jsonc
{
  "artist": "string, required",
  "album": "string, required (raw, undecorated)",
  "source": "string, required — display name, e.g. 'The Quietus'",
  "sourceUrl": "string, required — the canonical review URL; half of the UPSERT conflict key",
  "articleText": "string, required — full review body Haiku reads from",
  "author": "string, optional — omitted (never null) when absent",
  "publishedAt": "string, optional — omitted when absent",
  // Not emitted by the current manifest builder, but kept on the CorpusItem
  // type: "rating", "discogsReleaseId" (fall through to null today).
}
```

Sources currently committed upstream (`WXYC/research-data`'s `build_manifest.py`): The Quietus, Tiny Mix Tapes (static — Wayback-only, no longer re-crawled but still read from its committed corpus), Bandcamp Daily, HHV Mag, Paste, Beats Per Minute, A Closer Listen, The Line of Best Fit, Drowned in Sound. **This set is open and growing** — a new upstream source needs zero code change here (see Dedup below).

## Pipeline (`orchestrate.ts`)

1. Fetch + gunzip the manifest asset (`fetch.ts`), parse line-by-line (`manifest.ts`) — malformed/incomplete lines are counted `invalid`, never thrown. Guard: 0 parsed items -> throw.
2. Match every item to a `library.id` via `resolveLinkedAlbumId` (`@wxyc/database`), exact `(artist, album)` match only — no fuzzy/pg_trgm, no matching against the broader `library` catalog (a deliberate ceiling: it avoids ever attaching a review to the wrong album). On a miss, retries once with a decoration-stripped album title (`match.ts`'s `stripAlbumDecoration` — a narrow, literal regex strip of a trailing `(reissue|deluxe|remaster(ed)?|expanded|ep|deluxe edition)` clause; deliberately NOT the broader `normalizeAlbumTitle` free-text normalizer, which would loosen the exact-match ceiling). Guard: 0 matched -> throw (evaluated regardless of `DRY_RUN`).
3. Dedup to one review per album (`dedup.ts`) by an explicit **total order** over sources: the editorial head (The Quietus → Tiny Mix Tapes → Bandcamp Daily, carried from the seed era) then the expansion order (The Line of Best Fit → Drowned in Sound → Paste → Beats Per Minute → A Closer Listen → HHV Mag — **an unconfirmed editorial judgment call**, shipped as the working default; re-ranking is a one-line edit to `RANKED_SOURCES`). Any source not in that list falls back to a deterministic name-sorted tail — **never excluded**: an album whose sole review comes from an unranked source still gets a card. Tallies `matched_by_source` from the winners.
4. Anti-join (`antijoin.ts`) against already-seeded `(album_id, source_url)` pairs, **before** any Haiku call — extraction is nondeterministic, so re-extracting an existing row would churn the UPSERT and re-spend tokens for nothing. Note: dedup never deletes a losing row, so if an album already carries a lower-preference card and a later corpus adds a higher-preference review, the anti-join (keyed on the pair, not the album) does not suppress the new `source_url` — the album then carries two cards. Consistent with the schema's multi-source-card design (read cap `CRITIC_REVIEWS_LIMIT = 5`).
5. `DRY_RUN` stops here: emits a locked-schema JSON report and returns, having made zero LLM calls and zero writes.
6. Steady state (no new items after the anti-join) logs a distinct `nothing_new` line.
7. Extract (`extract.ts`, Haiku tool-forced call) + build + write each new item. A per-item LLM error is caught and counted (`llm_errors`) — one poisoned article can't wedge the run. A clean extraction that isn't a usable review (`isReview:false`, or a snippet that can't be capped cleanly) is counted (`rejected`), never thrown. Guard: new items existed but 0 written -> throw.

## Run / dry-run

```bash
# Build + run locally (against whatever DB_* points at):
npm run build --workspace=@wxyc/database --workspace=@wxyc/album-critic-reviews-etl
npm start --workspace=@wxyc/album-critic-reviews-etl

# Dry run: fetch + match + dedup + anti-join + run guards, zero LLM calls, zero writes:
DRY_RUN=true npm start --workspace=@wxyc/album-critic-reviews-etl
```

The `DRY_RUN` report is a **locked schema** — exactly these keys, one JSON line on stdout; treat as an interface:

```json
{
  "job": "album-critic-reviews-etl",
  "dry_run": true,
  "fetched": 0,
  "parsed": 0,
  "invalid": 0,
  "matched": 0,
  "matched_by_source": {},
  "already_present": 0,
  "would_extract": 0
}
```

## Fair use (ADR 0012)

`snippet` is capped at 300 chars in code (`extract.ts`'s `MAX_SNIPPET`), never just in the prompt: an over-length model response is trimmed at the last sentence boundary past 60% of the cap, falling back to a word boundary, and rejected entirely (never persisted mid-thought) if neither clears that threshold. `source`/`source_url` are `NOT NULL` (attribution + link-out, always). `rating` is optional metadata, never the surfaced content.

## Invariants (do not weaken)

- **Never delete.** UPSERT-only; the job has no delete path.
- **Idempotent.** The anti-join + the writer's `IS DISTINCT FROM` `setWhere` together guarantee a repeated real run makes zero LLM calls and reports 0 written / 0 changed for already-seeded pairs.
- **Exact match only.** Do not loosen to fuzzy/pg_trgm without a measured false-positive analysis (out of scope for this job).
- **Author precedence, deliberately reversed from the seed script**: the manifest's `author` wins over the LLM-guessed one when present (`item.author ?? extraction.author`) — the seed script had it the other way around. Rating precedence is unchanged (LLM wins).
- **Source ranking is data, not a switch** (`dedup.ts`'s `RANKED_SOURCES`) — a new upstream source lands in the deterministic fallback tail automatically; ranking it explicitly is a one-line edit, never a required one.

## Related

- `scripts/seed-critic-reviews.ts` — the one-off whose extraction core this job lifts; left in place for manual runs, this job is the production path.
- [#1718](https://github.com/WXYC/Backend-Service/issues/1718) — critic-reviews epic.
- [BS#1829](https://github.com/WXYC/Backend-Service/issues/1829) — `resolveLinkedAlbumId` extraction to `@wxyc/database`, a hard dependency of this job.
- [`WXYC/research-data#1`](https://github.com/WXYC/research-data/issues/1) — the manifest crawl + publish pipeline this job consumes.
