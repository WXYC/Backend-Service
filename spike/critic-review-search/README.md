# Spike: search-augmented critic-review discovery

Deliverable of [Backend-Service#1873](https://github.com/WXYC/Backend-Service/issues/1873) — design + spike, **not** production code. This directory is throwaway: it proves the core pipeline (`search -> classify -> verify -> extract`) and validates it against the ticket's labeled 40-release ground truth. See [`docs/adr/0013-search-augmented-critic-review-discovery.md`](../../docs/adr/0013-search-augmented-critic-review-discovery.md) for the architecture decision this validates, including the search-provider evaluation.

## Layout

```
spike/critic-review-search/
  src/
    classify.py   heuristic editorial vs retail/listing classifier
    verify.py     exact-release match guard (the "Decosimo trap")
    extract.py    first-paragraph extraction
    robots.py     robots.txt + AI-opt-out checker (real HTTP, injectable fetcher)
    pipeline.py   orchestration: shortlist -> evaluate fetched candidate -> decision
    metrics.py    precision/recall/findable-rate scoring
  tests/          45 offline unit tests (pytest, no network)
  scripts/
    compute_metrics.py   regenerates data/metrics_summary.json from data/results.json
  fixture/
    labeled_sample.json  the full 40-release ground truth, transcribed from the issue
  data/
    search/       raw WebSearch results per validated item
    robots/       real, live robots.txt decisions captured during the run
    fetched/      raw WebFetch outputs + technical/WAF failures per candidate
    results.json  final per-item automated verdict vs ground truth
    metrics_summary.json  computed headline numbers (regenerable)
```

## Running it

```bash
cd spike/critic-review-search
python3 -m pytest tests/ -q          # 45 tests, offline, no network
python3 scripts/compute_metrics.py   # recompute the headline numbers from data/results.json
```

No third-party dependencies — pure standard library, so there's no `requirements.txt` to install. `robots.py`'s live HTTP checker only runs when you call it with a real URL and no `fetcher=` override; the test suite never touches the network.

## What was validated, and how

The ticket's ground truth is a labeled 40-release sample (`fixture/labeled_sample.json`, transcribed verbatim from the issue body). Running live search + fetch against all 40 was not practical inside this spike's time budget (each release needs a search plus one-to-three fetches, several of which involve slow/blocked domains), so a **16-item representative subset** was validated live, chosen to preserve the full sample's shape:

- Spans all four rotation bins (H/M/L/S).
- Preserves close to the full sample's editorial:retail:nothing ratio (11 editorial : 4 retail : 1 nothing in the subset, vs 27:12:1 in the full 40 — 68.75% vs 67.5% editorial).
- Includes outlets already known to block AI crawlers per research-data's own documentation (All About Jazz, Resident Advisor), to test the robots/opt-out guard against known-hard cases rather than only easy ones.
- Includes a diacritic-bearing non-English case (Csillagrablók — Reménytelen), a multi-artist-billing case (Various Artists — When There is No Sun), and the sample's one "nothing findable" case (Activ-Analog — Space Cadet).

Subset (fixture ids): **1, 3, 5, 9, 12, 14, 16, 18, 21, 24, 26, 29, 30, 34, 36, 39** — 16 of 40. **All numbers below are computed over this N=16 subset, stated explicitly; nothing extrapolates to the full 40 without saying so.**

Per the ticket's instruction, the spike used the WebSearch/WebFetch tools available in this environment as a stand-in for a real search-provider API and a real HTTP fetch client (see ADR 0013's "Spike scope" section for exactly what that substitution does and doesn't change about the results).

All raw data is committed for reproducibility and audit, append-only per the org's data-safety policy — `data/search/*.json`, `data/robots/live_robots_check.json`, `data/fetched/live_fetch_results.json`, `data/results.json`, `data/metrics_summary.json`.

## Headline metrics (N=16)

| Metric                            | Value                                                         | Target / baseline              |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| **Editorial-detection precision** | **100%** (5/5 attached rows were genuinely editorial)         | —                              |
| **Editorial-detection recall**    | **45.5%** (5/11 ground-truth-editorial releases got attached) | —                              |
| **Exact-match precision**         | **100%** — **0 false attaches**                               | Target: 0/40 false attaches    |
| **Automated findable-rate**       | **31.25%** (5/16)                                             | vs manual baseline 68% (27/40) |

Plus a supplementary, unscored guard-rail trial (not part of the 40-sample): a deliberate live attempt to attach a real HHV Mag review of the _wrong_ K. Frimpong album was correctly rejected (see below) — the guard held under a live adversarial-ish test, not just synthetic unit tests.

Run `python3 scripts/compute_metrics.py` to regenerate this table from `data/results.json`; the numbers above are its literal output.

## Reading the recall number correctly

45.5% recall looks like a large gap from the manual 68% findable-rate, and the raw findable-rate (31.25% vs 68%) looks worse still. **Almost none of that gap is a classifier failure.** Breaking down the 6 false negatives by cause:

| Release                                                       | Ground-truth outlet | Why the automated pipeline missed it                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 22 Beaches — _Dust: Recordings 1980-1984_                  | Maximum Rocknroll   | **Search-recall miss.** The outlet never appeared anywhere in the WebSearch results (8 results, all retail/marketplace pages).                                                                                                                                                     |
| #3 Janel Leppin's Ensemble Volcanic Ash — _Pluto in Aquarius_ | All About Jazz      | **Robots-block** on the ground-truth outlet (`ClaudeBot` disallowed) + a TLS handshake failure on the next candidate + a third candidate correctly judged non-editorial. Three independent barriers stacked on one release.                                                        |
| #9 Noura Mint Seymali — _Yenbett_                             | Far Out Magazine    | **WAF block** (`HTTP 403`) — robots.txt explicitly allowed the fetch; an edge/bot-challenge layer blocked it anyway.                                                                                                                                                               |
| #21 Various Artists — _When There is No Sun_                  | Resident Advisor    | **Robots-block** (`ClaudeBot` disallowed). A Wayback-fallback attempt (research-data's own documented workaround for this exact outlet) was blocked at the _tool_ level — the WebFetch tool refuses `web.archive.org` outright, a spike-tooling limitation, not a policy decision. |
| #26 Hiding Places — _The Secret to Good Living_               | Treble              | **WAF block** (`HTTP 403`) — robots.txt allowed it. Treble is already a **shipped, working source in research-data's own crawler** (`crawl_reviews.py treble`), so this is very likely an artifact of the spike's fetch tool's identity, not a genuine block.                      |
| #30 Nashpaints — _Everyone Good is Called Molly_              | Paste               | **WAF block** (`HTTP 403`) — robots.txt allowed it. Paste is also **already shipped and in research-data's manifest** (`crawl_reviews.py paste`). Same conclusion as Treble.                                                                                                       |

Reason tally: **3 WAF blocks, 2 robots/AI-opt-out blocks (correctly honored — a feature, not a bug), 1 search-recall miss.** Zero false negatives were caused by the classify/verify logic itself getting a page wrong. Every successfully-_fetched_ page in this run (10 of them, counting both correct-outlet hits and the correctly-rejected non-reviews) was classified correctly:

| Page fetched                                                | Automated call                             | Correct? |
| ----------------------------------------------------------- | ------------------------------------------ | -------- |
| Chapelboro.com (Mellow Swells radio segment)                | not editorial                              | Yes      |
| The COSMOS (Paradise Bangkok Molam festival recap)          | not editorial                              | Yes      |
| Sputnikmusic (Vladislav Delay — Entain)                     | editorial, exact match                     | Yes      |
| HHV Mag (K. Frimpong — The Black Album)                     | editorial, exact match                     | Yes      |
| HHV Mag (K. Frimpong — **The Blue Album**, deliberate trap) | editorial, but **wrong release, rejected** | Yes      |
| The Needle Drop (low.bo news post)                          | not editorial                              | Yes      |
| Recorder/rec.hu (Csillagrablók — Reménytelen, Hungarian)    | editorial, exact match                     | Yes      |
| Loud And Clear Reviews (unrelated film "Space Cadet")       | not editorial / no match                   | Yes      |
| First Floor (Carré — Hibiscus)                              | editorial, exact match                     | Yes      |
| Music Connection (Mei Semones — Kurage)                     | editorial, exact match                     | Yes      |

**10/10 correct page-level calls**, in both directions, across English and Hungarian, including one deliberately adversarial case. The sample is small (this is a spike, not a statistically powered study), but zero errors across a genuinely varied set is a strong signal the classify → fetch → verify chain is sound. The findable-rate gap is a **fetch-availability problem** (robots/AI-opt-out policy correctly applied, plus WAF friction from this spike's specific fetch tool), not an intelligence problem — and ADR 0013's production recommendation (reuse research-data's existing honest-HTTP-client fetch infrastructure, add a Wayback fallback for AI-opt-out cases) targets exactly that gap.

## The Decosimo trap, demonstrated live

Named for WXYC rotation artist Joseph Decosimo (multiple distinct albums: _While You Were Slumbering_, _Beehive Cathedral_, _Sequatchie Valley_) — none of those albums are in the 40-sample, so this spike ran a deliberate supplementary trial using a real case surfaced by the live search results instead: while validating item #16 (K. Frimpong and his Cubano Fiestas — _The Black Album_, correctly attached from HHV Mag), the search results also surfaced HHV Mag's review of the same artist's _The Blue Album_ — a different, real release, also a genuine editorial review from the same trusted outlet. The pipeline was pointed at that URL while still targeting _The Black Album_:

```
target:  K Frimpong and his Cubano Fiestas — The Black Album
fetched: HHV Mag review of "The Blue Album" (LLM correctly says is_editorial_review=true)
verify_exact_release() -> REJECTED_MISMATCH
  reason: "album mismatch (Decosimo trap): wanted 'The Black Album', page is about 'The Blue Album'"
```

The small-LLM classification stage said, correctly, "yes, this is a real review" — and the code-level exact-match guard downstream of it still rejected the attach, because the album didn't match. This is the design point of keeping `verify_exact_release()` as a hard code-level gate rather than folding exact-match into the LLM's judgment: an LLM can be right that something _is_ a review and still be the wrong review to attach.

## Exact-match precision: 0/16 false attaches (target: 0/40)

All 5 automated attaches were genuinely correct exact-release matches, confirmed against the fixture. The supplementary Decosimo-trap trial above is additional evidence the guard fires correctly under a live, non-synthetic adversarial input, not just the 40 unit-test assertions in `tests/test_verify.py`. This spike cannot claim 0/40 (only 16 were run live), but the validated subset plus the guard-rail trial gives no counter-evidence to the ADR 0012 "never mis-attribute" posture, and the guard's design (exact-normalized match, no fuzzy fallback, reject-on-uncertain) gives no structural reason to expect it to degrade at full scale.

## What the classify/verify/extract logic looks like

Pure, dependency-free Python (`src/classify.py`, `src/verify.py`, `src/extract.py`, `src/robots.py`, `src/pipeline.py`), 40 offline unit tests (`tests/`) plus 5 for the metrics scoring (`tests/test_metrics.py`) — 45 total, all green (`python3 -m pytest tests/ -q`). No network access in the test suite; `robots.py`'s default HTTP fetcher is injectable and every `robots.py` test runs against a fake fetcher. The live network calls (WebSearch/WebFetch/real robots.txt fetches) only happened in the validation run recorded under `data/`, never in the test suite.

## Known limitations of this spike (read before generalizing the numbers)

1. **N=16, not N=40.** Explicitly a representative subset, not a truncation hidden as a full run. See "What was validated" above for the selection method.
2. **WebFetch tool artifacts, not production behavior.** Three WAF 403s and one hard `web.archive.org` refusal are properties of this spike's specific stand-in fetch tool, evidenced by two of the three WAF-blocked domains already being successfully crawled today by research-data's own `crawl_reviews.py`. Production's fetch layer will very likely do better than this spike's findable-rate, not worse — see ADR 0013.
3. **"Editorial found" was scored as any legitimate exact-match review, not only the fixture's named outlet.** Three of the five automated attaches (Entain/Sputnikmusic, Hibiscus/First Floor) landed on a different outlet than the human prober found, because a different, equally legitimate editorial review of the same exact release existed. This is scored as a true positive because the ADR 0012 goal is "does the album get a real attributed review," not "does it get _this specific_ review" — but it's worth naming explicitly since it affects how "recall" should be read.
4. **The heuristic domain lists (`classify.py`'s `_RETAIL_DOMAINS`) are seeded from what this run actually saw, not exhaustive.** They will always miss some retailer the first time it shows up; the small-LLM fetch stage is the designed backstop for exactly that gap, and the live run shows it working (e.g., `chapelboro.com` and `theneedledrop.com` were never going to hit a domain-based retail rule, and both were correctly caught at the LLM stage instead).
5. **The multi-release joint-review case (item #3's "Slowly Melting & Pluto in Aquarius") was not cleanly resolved either way** — the fetch failed for unrelated technical reasons before this edge case could be exercised. `verify_exact_release()`'s "drop on uncertain" design (a `None` found_album is a rejection, never a guess) is the intended handling, but this run didn't get a live confirmation of it on a _successful_ fetch. Worth a dedicated test case in the production build.
