# §4 step 2 — Library identity backfill (superseded 2026-05-09)

> **Status:** SUPERSEDED by the cross-cache-identity architecture pivot. This file is a redirect.

## What happened

The original §4 step 2 plan committed Backend to a five-source backfill (S1=`canonical_entity_id`, S2=LML `entity.identity`, S3=discogs-cache `flowsheet_match`, S4=discogs-cache `fuzzy_resolved`, S5=semantic-index `reconciliation_log`) that required Backend to reach into LML's discogs-cache PG via `DATABASE_URL_DISCOGS`, run §3.4.1.1 composition rules locally, and detect cross-source agreement against caches Backend doesn't own. While building sub-PR 2.1, the architectural debt of that model became unworkable. On 2026-05-09 the project pivoted: Backend stops reading LML's PG, LML grows a `POST /api/v1/identity/bulk-resolve-libraries` endpoint, and Backend's role narrows to consuming LML's verdict over HTTP and writing locally via the existing §3.2.2.2 dual-table writer.

## Where the post-pivot plan lives

- **Decision record (this repo):** [`plans/library-hook-canonicalization/architecture-pivot-2026-05-09.md`](architecture-pivot-2026-05-09.md) — full reasoning, four-wave action plan, Phases 0-7 migration table, costs/benefits, what we keep vs. throw away. Merged in [#800](https://github.com/WXYC/Backend-Service/pull/800).
- **Wiki plan amendment:** [`WXYC/wiki:plans/library-hook-canonicalization.md`](https://github.com/WXYC/wiki/blob/main/plans/library-hook-canonicalization.md) — top-of-doc post-pivot banner plus inline POST-PIVOT (2026-05-09) callouts in §3.2, §3.2.2, §3.2.5, §3.4.1, §3.4.1.1, §4 step 2, §4.2. Wave 3 PR: [WXYC/wiki#25](https://github.com/WXYC/wiki/pull/25).
- **Execution tickets:**
  - [`wxyc-shared#103`](https://github.com/WXYC/wxyc-shared/issues/103) — `api.yaml` v0.7 contract for `POST /api/v1/identity/bulk-resolve-libraries`.
  - [`library-metadata-lookup#272`](https://github.com/WXYC/library-metadata-lookup/issues/272) — LML handler implementation (matcher cascade, §3.4.1.1 composition Rules 2-6, §3.2.5 cross-ref detection, response with `kind` / `external_ids` / `agreement_sources` / `provenance`).
  - [`Backend-Service#802`](https://github.com/WXYC/Backend-Service/issues/802) — Backend HTTP consumer in `jobs/library-identity-consumer/` (replaces this plan).
- **Epic:** [`Backend-Service#663`](https://github.com/WXYC/Backend-Service/issues/663) — rescoped 2026-05-09 to reflect the new structure.

## What survives from the pre-pivot work

- **Substrate** (`library_identity` + `library_identity_source` + `library_identity_history` tables; the dual-table writer with `ON CONFLICT` semantics; the §3.4.1.1 worked-example regression tests) — already merged in [#790](https://github.com/WXYC/Backend-Service/pull/790). Schema is correct in the new architecture.
- **S1 self-migration leg** (`library.canonical_entity_id` → `library_identity_source` for legacy rows) — runs as a one-shot before the bulk-resolve consumer kicks in.
- **The 2.2 spike memo** in PR [#794](https://github.com/WXYC/Backend-Service/pull/794) — durable findings about `flowsheet_match` and `fuzzy_resolved` shapes (no `trgm_score`; no Discogs ID on `fuzzy_resolved`); useful regardless of which service consumes the tables.

## What was discarded

The pre-pivot per-leg dispatcher in `jobs/library-identity-backfill/dispatch.ts`, the LML provenance index in `sources/lml-provenance-index.ts`, and the S2 resolver in `resolve-s2.ts` are not consumed under the new architecture. They live on disk in the closed worktree behind PR [#797](https://github.com/WXYC/Backend-Service/pull/797) in case any of the orchestrator or writer integration scaffolding transfers to [#802](https://github.com/WXYC/Backend-Service/issues/802); the per-leg shape itself does not.

## Why this stub instead of deleting the file

Future readers searching `plans/library-hook-canonicalization/` for "five source legs" or "S2 LML provenance" should land here and be redirected, not get a 404. The decision record + wiki amendment are the canonical pivot artifacts; this file's only job is to point at them.
