---
title: 'Cross-cache-identity architecture pivot'
status: decision record
date: 2026-05-09
authors: jake
related:
  - WXYC/wiki plans/library-hook-canonicalization-plan.md (parent plan; needs amendment)
  - WXYC/Backend-Service plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md (BS-side plan; superseded)
  - WXYC/Backend-Service#663 (epic; needs rescope)
  - WXYC/Backend-Service#790 (sub-PR 2.0, merged — substrate stays)
  - WXYC/Backend-Service#794 (spike memo PR; reframe to findings only)
  - WXYC/Backend-Service#797 (sub-PR 2.1 PR; close)
  - WXYC/Backend-Service#795 (sub-PR 2.2a ticket; close)
  - WXYC/Backend-Service#796 (sub-PR 2.2b ticket; close)
---

# Cross-cache-identity architecture pivot

## Status

Decision recorded 2026-05-09. Pre-execution: this document captures the architectural reasoning and the action sequence before any artifacts are closed or filed. Once Wave 4 lands, the pivot is in motion across BS / LML / wxyc-shared / wiki.

## Why a pivot

The cross-cache-identity project's original sub-PR series (§4 step 2 of the parent plan) committed Backend-Service to reading identity data from many external sources and composing the canonical record locally. The 5-source backfill model (S1 = Backend's own `canonical_entity_id`, S2 = LML `entity.identity`, S3 = `flowsheet_match`, S4 = `fuzzy_resolved`, S5 = semantic-index `reconciliation_log`) implied:

- Backend reaches into LML's discogs-cache PG via `DATABASE_URL_DISCOGS` (S2 + S3 + S4)
- Backend reads SQLite mounted from EC2 (S5)
- Backend implements §3.4.1.1 confidence composition rules locally
- Backend implements cross-source agreement detection locally
- The "LML write contract" in §3.2.2 has LML calling back to Backend's `library_identity` to mutate it

That model has Backend doing two distinct jobs: catalog service (its primary domain) and metadata-resolution service (multi-source merge, confidence composition, cross-ref detection). The boundary between Backend and LML becomes leaky in three directions at once:

1. Backend reads LML's PG schema directly (couples on schema).
2. Backend writes SQL scripts that run _against_ LML's PG (the `flowsheet_match` and `fuzzy_resolved` table-creation SQL lives in `Backend-Service/scripts/` despite the tables living in LML's PG).
3. The §3.2.2 write contract has LML calling back to Backend, creating a second cross-service write path with its own retry/consistency story.

While building sub-PR 2.1, two findings made the cost of this model concrete:

- **The 2.2 spike** ([audit memo](audits/discogs-cache-match-score-shape.md)) found that `flowsheet_match` and `fuzzy_resolved` aren't actually part of LML's discogs-cache schema — Backend's own scripts materialize them inside LML's PG for proximity to Discogs reference data. So Backend isn't even reading LML's data; it's reading data Backend's scripts wrote into LML's PG. The directional confusion is acute.
- **The S2 design pivot** found that LML's `entity.reconciliation_log` already carries per-row `(method, confidence)`. The "locked at `alias_match 0.85`" interim was unnecessary. Reaching this conclusion required Backend to read yet another LML schema (`reconciliation_log`) directly.

Each new source leg added another LML schema Backend depended on. The architectural debt was compounding.

## What we're going for

Two roles per service, one boundary at HTTP.

**Backend-Service is the catalog.** It owns: the WXYC library (what records the station has), flowsheet (what got played), DJs, shows, request line. Every JOIN key in the system roots in Backend (`library.id`, `flowsheet.id`, `artists.id`, `shows.id`). Backend is _not_ in the metadata-resolution business. When it needs to know the canonical identity of a library row, it asks LML over HTTP and stores the answer locally for read performance.

**LML is the metadata-resolution service.** It owns: every cache, every matcher, every confidence rule, every cross-reference. Given a `(library_id, artist_name, album_title)` tuple — or any subset — it returns the composed identity record. Internally it consults `entity.identity`, `reconciliation_log`, the discogs-cache `flowsheet_match`/`fuzzy_resolved` tables (now LML-owned), wikidata-cache for cross-refs, mb-cache for cross-refs, semantic-index for additional agreement signal. The matcher cascade (`exact_match`, `name_variation`, `member_group`, `alias_match`, `trigram`, `llm`, `cross_source_agreement`), the §3.4.1.1 composition rules, the §3.2.5 cross-ref detection — all LML-internal.

**Caches are LML-internal.** discogs-cache, musicbrainz-cache, wikidata-cache, semantic-index — each is queried only by LML. Backend has no cache connection strings. The cache repos' schemas are LML's implementation detail.

**HTTP is the only contract surface between Backend and LML.** No cross-DB SELECTs. No cross-DB INSERTs. The substrate `library_identity` lives in Backend's PG and only Backend's code writes to it; LML returns data, Backend stores it. The §3.2.2 "LML write contract" simplifies dramatically: instead of LML calling Backend's PG to upsert library_identity rows, LML returns identity in its `/lookup` response and Backend extracts and writes locally. One write path, no callback pattern.

## Backend's read performance under the pivot

Backend's hot-path search needs identity columns local. The pivot doesn't change that — it changes whether Backend computes that data or just stores it.

### What Backend caches

Backend's tables are caches/projections of LML's authoritative data, but they live locally for performance. Specifically:

- **`library`** — primary catalog data + FTS infrastructure (search_doc tsvector, trigram indexes). Always local.
- **`library_identity`** — the substrate from sub-PR 2.0. All 8 external-ID columns (discogs_master_id, discogs_release_id, mb_release_group_mbid, mb_release_mbid, mb_recording_mbid, wikidata_qid, spotify_id, apple_music_id) plus method, confidence, agreement_sources. **Hot-path read target** — every catalog search JOINs to this. Indexed by `library_id` (PK).
- **`library_identity_source`** — per-source provenance. Less hot; read by audit/review queue and reconciliation drift detection.
- **`library_identity_history`** — supersedure log. Audit-only.
- **`artists.{discogs_artist_id, mb_artist_id, wikidata_qid, spotify_artist_id, apple_music_artist_id, bandcamp_id}`** — artist-level identity mirror. Currently populated by `artist-identity-etl`; eventually populated by side-effect of LML `/lookup` calls during runtime path (Phase 5).
- **`flowsheet.{discogs_url, spotify_url, apple_music_url, ...}`** — denormalized URLs for play-by-play views. Already enriched on add; unchanged.

The catalog search SQL stays unchanged after the pivot:

```sql
SELECT
  l.id, l.artist_name, l.album_title, l.genre,
  l.artwork_url, l.on_streaming,
  li.discogs_release_id, li.discogs_master_id,
  li.spotify_id, li.apple_music_id,
  li.method, li.confidence
FROM library l
LEFT JOIN library_identity li ON li.library_id = l.id
WHERE l.search_doc @@ websearch_to_tsquery('stereolab')
ORDER BY ts_rank_cd(l.search_doc, websearch_to_tsquery('stereolab')) DESC
LIMIT 25;
```

Same query, same indexes, same ~5-15ms latency. The pivot only changes how `library_identity` got populated — not how it's read.

### What Backend does NOT cache

- discogs-cache schema (Discogs releases, masters, artists, XML-dump-derived data)
- musicbrainz-cache schema (MB releases, artists, recordings)
- wikidata-cache `discogs_mapping`, `mb_mapping` (cross-reference tables)
- LML `entity.reconciliation_log` (LML's audit trail of resolution attempts)
- semantic-index graph DB
- `flowsheet_match`, `fuzzy_resolved` (post-pivot these are LML-internal)

The shared characteristic: anything that's _raw input to identity resolution_ stays in LML. Anything that's _the resolved verdict_ lives in Backend.

### How data flows into Backend's cache (HTTP only)

**Push (runtime, fresh writes).** When a user adds a flowsheet entry or a release to the catalog, Backend calls LML's `/api/v1/lookup` with `include_identity: true`. LML returns the response with the identity block. Backend writes the identity to `library_identity_source` and `library_identity` in the same transaction as the flowsheet/library write. No cross-service write — Backend extracts identity from LML's response and writes locally.

**Pull (backfill + reconciliation).** Periodically, Backend calls LML's `POST /api/v1/identity/bulk-resolve-libraries` with a batch of `(library_id, artist_name, album_title)` tuples. Three uses:

1. **Initial backfill** — populate the substrate for every existing library row (the new sub-PR 2.1 work).
2. **Drift reconciliation** — periodically re-fetch identity for some rows and compare to local; alert on divergence.
3. **On-demand refresh** — admin UI button to re-resolve a row.

### Composition logic remaining in Backend

Just Rule 1 from §3.4.1.1 (manual override). Rules 2-4 (cross-source agreement boost, inherited exclusion, MIN fallback) move to LML.

```ts
// BS's recompute, post-pivot
function composeMainRow(perSourceRows: SourceRow[], lmlVerdict: LmlMainRow): MainRow {
  const manualRow = perSourceRows.find((r) => r.method === 'manual');
  if (manualRow) {
    return { ...rowFromManual(manualRow), method: 'manual', confidence: 1.0, agreement_sources: null };
  }
  return lmlVerdict;
}
```

About 10 lines, replacing the current ~150-line `recomputeMainRow`. The §3.4.1.1 worked-example regression tests stay valuable but the test inputs change — they become "what LML returns" + "what manual rows exist" rather than "what per-source rows we computed."

## What changes in LML

LML grows by:

**A new endpoint.** `POST /api/v1/identity/bulk-resolve-libraries` returns the composed identity record per input tuple, with optional provenance.

```json
// Request
{
  "libraries": [
    { "library_id": 100, "artist_name": "Stereolab", "album_title": "Aluminum Tunes" },
    { "library_id": 101, "artist_name": "Juana Molina", "album_title": "DOGA" }
  ],
  "include_provenance": true
}

// Response
{
  "results": [
    {
      "library_id": 100,
      "main": {
        "discogs_master_id": null,
        "discogs_release_id": 987654,
        "musicbrainz_release_group_mbid": "550e8400-...",
        "musicbrainz_release_mbid": null,
        "musicbrainz_recording_mbid": null,
        "wikidata_qid": "Q483507",
        "spotify_id": "4XYZ",
        "apple_music_id": null,
        "method": "cross_source_agreement",
        "confidence": 0.95,
        "agreement_sources": ["discogs_release", "discogs_artist", "wikidata"]
      },
      "sources": [
        { "source": "discogs_release", "external_id": "987654", "method": "exact_match", "confidence": 1.0 },
        { "source": "discogs_artist", "external_id": "12345", "method": "exact_match", "confidence": 1.0 },
        { "source": "wikidata", "external_id": "Q483507", "method": "name_variation", "confidence": 0.95 }
      ]
    }
  ]
}
```

**Internal release-level matching.** The `discogs-bridge-flowsheet.sql` and `fuzzy-trigram-flowsheet.sql` scripts move from `Backend-Service/scripts/` to LML's `scripts/entity_resolution/` (or become Python orchestration). LML's matcher cascade extends to: artist-level (existing) + release-level via `flowsheet_match` (new) + trigram-resolved library_id via `fuzzy_resolved` (new) + recording-level via mb-cache (future).

**§3.4.1.1 composition rules in Python.** Port the TypeScript `recomputeMainRow` from sub-PR 2.0. The §5.1.1 worked-example matrix transfers as Python regression tests.

**§3.2.5 cross-source agreement detection.** The `cross_ref_present(s1, s2)` function with its lookups against wikidata-cache `discogs_mapping`, mb-cache `artist_url`, etc. — LML-internal. The pre-index that the parent plan §5.2 calls for stays in LML.

**Confidence becomes a guarantee, not a hint.** The bulk-resolve endpoint always returns `(method, confidence)` joined to each source row. LML's contract: every response has both fields populated, no NULLs. That eliminates the "fallback to alias_match 0.85" branch in BS entirely.

LML grows by ~1000 LOC: endpoint code + composition logic + porting matching SQL + cross-ref pre-index. Backend's loss roughly equals LML's gain.

## Migration phases

| Phase | Scope                                                                                                                                                                                                                           | Status                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0     | Stop the bleed (close obsolete PRs/tickets, halt forward motion on the wrong pattern)                                                                                                                                           | this doc, this session |
| 1     | Define the contract — `wxyc-shared/api.yaml` v0.7 with bulk-resolve-libraries endpoint schema. Schema PR + release tag publishing TS/Python/Swift/Kotlin types.                                                                 | next                   |
| 2     | LML implementation — endpoint handler, internal artist-level resolution, §3.4.1.1 composition rules in Python. Initial version may return `null` for release-level columns.                                                     | next                   |
| 3     | BS consumes the endpoint — replace cross-DB read pattern with HTTP calls. The new sub-PR 2.1.                                                                                                                                   | next                   |
| 4     | Move release-level matching to LML — port `flowsheet_match` and `fuzzy_resolved` SQL into LML's pipeline; bulk-resolve endpoint starts populating `discogs_master_id`/`discogs_release_id` etc. The 2.2a/2.2b split disappears. | later                  |
| 5     | Deprecate `artist-identity-etl` — Backend's `artists.{discogs_artist_id, ...}` columns get populated by side-effect of `/lookup` calls; the ETL is removed. `DATABASE_URL_DISCOGS` drops from BS entirely.                      | later                  |
| 6     | Remove BS's matching from runtime path — anywhere in BS's runtime code that does its own metadata lookup, normalization, or fuzzy matching moves to LML.                                                                        | later                  |
| 7     | Drop legacy columns — `library.canonical_entity_id`, `canonical_entity_confidence`, `canonical_entity_resolved_at`. The full canonical record lives in `library_identity`. (This is parent plan §4 step 5; predates the pivot.) | later                  |

Phases 0-3 are this initiative's near-term focus. 4-7 are months out and follow the cross-cache-identity dual-run audit cadence.

## Costs and benefits

Costs accepted:

- **Throwaway in BS**: most of #797 (~600 LOC), the 2.2a + 2.2b implementations that haven't been written yet (~600 LOC), eventually the artist-identity-etl (~400 LOC), eventually the matching SQL scripts (~500 LOC). About 1200 LOC of unwritten work avoided; about 900 LOC of existing BS code eventually retired across phases 5-6.
- **New work in LML**: bulk-resolve endpoint + composition rules + porting matching scripts. ~1000 LOC over phases 2 + 4.
- **Coordination**: wxyc-shared schema PR is a contract gate. LML and BS evolve in lockstep through phases 1-3. Three or four cross-repo coordinated PR rounds.
- **Test rebuild**: tests against the @wxyc/database mock transfer poorly because the data source changes. New tests use HTTP mocks. Probably one full rewrite of the orchestrator test suite.
- **Wall-clock**: 3-6 months for phases 1-3 including dual-run windows. Phases 4-7 are quarters out.

Benefits:

- **One canonical home for resolution domain knowledge.** Today the matcher cascade lives in LML, the composition rules live in BS, cross-ref detection is unimplemented but spans both. After: all in LML.
- **Schema decoupling.** LML can evolve `entity.identity`, `reconciliation_log`, the matching scripts internally without breaking BS. The contract is the HTTP API.
- **Service-shaped tests.** BS uses HTTP mocks; LML uses its own PG fixtures. Today there's a tangled middle ground where BS unit tests mock @wxyc/database while the real path queries multiple PGs.
- **Cleaner cache lifecycle.** Today discogs-cache changes affect BS via the matching scripts. After: discogs-cache changes affect only LML.
- **Operational clarity.** When resolution is wrong, trace back to LML and reproduce there. Today the tracing path crosses service boundaries multiple times.
- **Future-proof for new sources.** Adding a Bandcamp matcher, a Beatport matcher, an iTunes matcher: today that's "extend wikidata-cache schema, update LML's entity.identity, update BS's artists table, update BS's resolver, update BS's writer." After: extend LML internally, ship a new endpoint version (or just include the new field in the existing response). BS gets the new source for free.

## What we keep vs. throw away

**Keep:**

- Sub-PR 2.0 substrate (`library_identity`, `library_identity_source`, `library_identity_history` tables; the dual-table writer with `ON CONFLICT` semantics; the §3.4.1.1 worked-example regression tests). The schema is correct in the new architecture too. Already merged in PR #790.
- The spike memo from PR #794 (the 2.2 audit findings). Durable facts: `flowsheet_match` and `fuzzy_resolved` carry no `trgm_score`; `fuzzy_resolved` carries no Discogs ID. Useful regardless of which service consumes the tables.
- BS's `library_identity_source` table — including the `notes` tag column for audit-trail provenance (`'backfill:S2'`, `'backfill:S3'`, etc.). Same columns, different writer.
- `dispatch.ts` (`BACKFILL_LEG` env-var parser) — the dispatcher pattern transfers; just the legs are different ("S1 self-migration" + "S-from-LML").
- The orchestrator pattern (id-cursor pagination, partition support, DRY_RUN with locked JSON output schema, idempotency filters). The shape stays; the per-row work simplifies to "extract from LML response and write."
- The §3.4.1.1 worked-example matrix as a regression test target — but the tests move to LML (where composition now happens).

**Throw away (in BS):**

- `lml-provenance-index.ts` (~90 LOC) — direct PG read of LML's `reconciliation_log`. Replaced by HTTP call.
- `resolve-s2.ts` (~100 LOC) — BS-side resolver. Replaced by thin response-parsing.
- Most of `recompute.ts` (~150 LOC, leaving ~10 lines for Rule 1 manual override) — Rules 2-4 move to LML.
- The 2.2 plan amendment commit on PR #794 — the 2.2a/2.2b split is obsolete because BS won't consume those tables.
- Eventually (phases 4-5): `discogs-bridge-flowsheet.sql` and `fuzzy-trigram-flowsheet.sql` (move to LML); `artist-identity-etl` package (replaced by runtime push).

**Reframe:**

- PR #794 — keep as "spike findings only," drop the plan-amendment commit.
- PR #797 — close. Worktree preserves code in case any of it transfers to the new sub-PR 2.1.
- Plan doc at `Backend-Service/plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md` — replace with a stub pointing at the wiki amendment.
- Epic #663 — comment with the pivot, edit body to remove the "Backend reads from many sources" framing.
- Issues #795, #796 — close as superseded.
- Issue #793 — close as superseded; new BS sub-PR 2.1 ticket gets its own number.

## Action plan

Four waves. Three of them parallelize within their wave; one (the wiki amendment) is sequential. A separate background agent triages obsolete-architecture references in parallel with Wave 1.

### Wave 1 — pure GitHub state changes (high parallelism)

Independent `gh` calls touching different artifacts. No shared state. Fire all at once.

- [ ] Close PR #797 with pivot comment; preserve worktree on disk.
- [ ] Reframe PR #794: drop the plan-amendment commit, update body to "spike findings only," force-push.
- [ ] Close issue #795 (sub-PR 2.2a — flowsheet_match reader) as superseded.
- [ ] Close issue #796 (sub-PR 2.2b — fuzzy_resolved reader) as superseded.
- [ ] Close issue #793 (sub-PR 2.1 ticket) as superseded if not already closed-by-PR.

### Wave 1 sidecar — background subagent

- [ ] Subagent: scan all open WXYC issues across repos for obsolete-architecture references (search for `DATABASE_URL_DISCOGS in BS`, "Backend reads entity.identity directly", "cross-DB read", etc.). Returns a punch list of any tickets the manual review of #663/#793/#795/#796 missed.

### Wave 2 — file new tickets (medium parallelism)

Three new tickets cross-reference each other. Draft all bodies sequentially with the contract shape held in mind, then fire `gh issue create` in parallel; patch cross-references via `gh issue edit` once numbers are known.

- [ ] WXYC/wxyc-shared ticket: "api.yaml v0.7 — POST /api/v1/identity/bulk-resolve-libraries endpoint schema."
- [ ] WXYC/library-metadata-lookup ticket: "Implement /api/v1/identity/bulk-resolve-libraries with provenance + composition."
- [ ] WXYC/Backend-Service ticket: "§4 step 2 sub-PR 2.1 (post-pivot) — consume LML bulk-resolve-libraries endpoint."

After all three numbers exist, patch each body's cross-references.

### Wave 3 — wiki plan amendment (sequential, sustained attention)

The keystone artifact. Coherence cost too high to parallelize.

- [ ] WXYC/wiki PR amending `plans/library-hook-canonicalization-plan.md`. Sections affected:
  - §3.2 (the canonical identity record): clarify Backend stores, LML composes.
  - §3.2.2 (LML write contract): simplify to "LML returns identity in /lookup response; BS extracts and writes locally." No more callback pattern.
  - §3.2.5 (cross-source agreement): all on LML side.
  - §3.4.1 + §3.4.1.1 (confidence matrix + composition rules): note composition lives in LML.
  - §4 step 2 (backfill): rewrite from 5 source legs to "S1 self-migration + bulk-resolve from LML."
  - §4.2 (dual-run window): unchanged conceptually but the audit comparator simplifies (BS local vs. LML response, not BS local vs. LML PG).

Estimated 200-400 lines edited.

### Wave 4 — close out (small parallelism)

After Wave 3 is settled and ticket numbers exist:

- [ ] Comment on epic #663 with pivot summary linking all new tickets.
- [ ] Edit #663 body to reflect new structure (remove "Backend reads from many sources" framing).
- [ ] Open BS PR for the plan-doc stub: replace `Backend-Service/plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md` with a pointer to the wiki amendment + this decision record.
- [ ] Update auto-memory with the pivot decision so future sessions don't re-litigate.

## Parallelization summary

| Wave | Parallel within                           | Parallel with other waves   | Why                                 |
| ---- | ----------------------------------------- | --------------------------- | ----------------------------------- |
| 1    | yes (independent gh calls)                | yes (with sidecar subagent) | no shared state                     |
| 2    | partial (draft sequential, fire parallel) | no                          | tickets define a shared contract    |
| 3    | no (single doc, sustained attention)      | no                          | coherence cost outweighs speed gain |
| 4    | yes (small independent calls)             | no (waits on Wave 3)        | references material from Wave 3     |

Things explicitly NOT parallelized:

- The wiki amendment + the BS plan doc stub. Coherence cost too high. Wiki first; BS doc becomes a stub pointer.
- Ticket drafting before the contract shape is settled. Sequential drafting prevents subtle inconsistencies in field names.
- Auto-memory before the rest is done. Memory should record actual state, not planned state.

Things explicitly delegated:

- The triage scan for obsolete-architecture refs across WXYC repos. Independent of my own writing, well-scoped, returns a list. Background subagent during Wave 1.

## Open decisions for execution

A few soft edges to resolve as we work, none blocking:

1. **`include_provenance` flag default.** Should LML's bulk-resolve endpoint return per-source provenance always, or only on flag? Default `true` to keep responses self-describing; `false` for performance-sensitive callers. Resolved during Wave 2 schema drafting.
2. **Manual override in the response.** When LML's matcher would have produced one verdict but a manual override exists in Backend, does LML know about that override? Two options: (a) Backend post-processes the response by applying its local manual rows on top, (b) LML reads Backend's manual rows via a new read endpoint Backend exposes. (a) is simpler; (b) is more SOA-pure. Resolved during Wave 2.
3. **Streaming vs single-response on big batches.** A 64K-row backfill in one HTTP call is impractical. Page the request (e.g., 500 tuples per call) or accept streaming response (e.g., NDJSON)? Resolved during Wave 2.
4. **Versioning the endpoint.** When LML's matcher cascade improves, the response shape may need a new version. Header? Path-versioned (`/api/v2/...`)? Resolved during Wave 2.

## Reversibility

The actions in this plan are reversible at low cost:

- Closed PRs/issues can be reopened.
- The PR #797 worktree stays on disk; if the pivot is wrong, the original implementation is recoverable.
- The wiki amendment is a PR, not a destructive edit.
- No production data is touched.
- No deploys happen during the pivot itself.

The hardest-to-reverse action is **closing PR #797**. Closing it discards a working artifact (CI green, tests passing, code reviewed). The argument for closing: landing it would cement the wrong pattern in main. The argument against: keeping it open gives us optionality. Default to closing — drafts that don't land tend to bitrot, and the worktree+branch preserve the code if we change our minds.

## Success criteria for the pivot

We'll know this pivot worked when:

- Backend has zero direct PG connections to LML, wikidata-cache, or musicbrainz-cache.
- The `library_identity` substrate is populated end-to-end via HTTP only.
- Catalog search latency (p95) is unchanged from today.
- Adding a new identity source (e.g., Beatport) is a single LML PR with no Backend changes.
- The §4 step 5 legacy-column drop happens cleanly because the data lives in `library_identity`.

That's the definition of the steady state. Phases 4-7 in the migration table above are the path there.
