# artist-conflation-split

One-shot inverse of `jobs/artist-unicode-dedup`: where that job merges `artists` rows one fold key should share, this one restores rows two acts should never have shared.

The MySQL→Postgres import manufactured cross-genre artist identity from names — tubafrenzy's `ARTIST` table was empty, the genre-scoped shelf slot was the only identity — so same-named acts landed on one row (BS#2637; the canonical case is artist 431 "Isis", a hip-hop act and a post-metal band). The release-tie audit ([WXYC/catalog-audits#30](https://github.com/WXYC/catalog-audits/issues/30)) classifies which merged rows are genuinely two acts; this job consumes its `split-directives.tsv` and gives each confirmed act its own row.

## What a split does

Per directive, in one transaction: for each split genre, INSERT a new `artists` row (name columns copied; the six reconciled-identity columns start NULL — a name-keyed stamp belongs to at most one act), move that genre's `genre_artist_crossreference` row to the new id, and repoint that genre's `library` rows. The shelf code needs no cascade — `library` stores neither call letters nor artist number, so every release re-labels at read time through the moved crossreference. `clear_identity` additionally NULLs the kept row's identity columns (used when the audit could not place the existing stamp).

`artist_crossreference` and the derived sites (aliases, similarity, station plays, track credits, concerts) are **reported, not repointed** — which act a frozen legacy cross-reference meant is not mechanically knowable, and derived state regenerates. The dry-run log hands those rows to the operator.

## Run procedure

Manual Build & Deploy with `target=artist-conflation-split`, then SSH to EC2 and:

    docker run --rm --env-file .env -v /path/to/directives:/directives <image> --directives /directives/split-directives.tsv            2>&1 | tee log-dry
    docker run --rm --env-file .env -v /path/to/directives:/directives <image> --directives /directives/split-directives.tsv --execute  2>&1 | tee log-exec

**Deploy order**: BS#2644's identity-ETL ambiguity guard must be live before the first `--execute`, or the next hourly ETL run stamps the same name-keyed id onto both rows, silently re-merging the identities this job separated.

Dry-run by default; validation refuses (never guesses) on a directive whose artist is missing a named filing — which is also what makes a completed run idempotent.
