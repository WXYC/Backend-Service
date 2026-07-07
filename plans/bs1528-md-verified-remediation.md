# BS#1528: `md_verified` provenance + MD-decided remediation of the 11 held rotation rows

## Context

[#1528](https://github.com/WXYC/Backend-Service/issues/1528) holds 11 rotation rows split out of the #1517 wrong-album audit because their free-text references are degenerate (self-titled, catalog code, artist-as-title, single letter). A verification pass (posted as a #1528 comment on 2026-07-06, independently re-verified against the Discogs API + prod clone) settled every row: **3 leave** (8276, 8277, 15726), **4 NULL-and-reset** (8247, 8248, 8267, 8268 — Killing Frost; stored id is Killing Joke's 1980 debut, wrong artist, and no self-titled Killing Frost release exists on Discogs), **4 repoint** (21583 → 37372443, 21533 → 35937175, 21574 → 37412646, 43164 → 36996060 — in each case the "degenerate" free-text was the artist's real new-release title and the direct backfill grabbed back-catalog).

The user decided open question 1: the four repoints get a new **`md_verified`** value on `discogs_release_id_source_enum` — the ids are human-verified against Discogs, not LML-resolved (`lml_offline_backfill` would misstate provenance and break the "0 lml_offline_backfill rows in prod" forensic invariant from #1521; `discogs_direct_backfill` would put the rows back in the #1522 recurring auditor's crosshairs).

The review also surfaced a gap this plan fixes: **no remediation path clears `rotation.lml_identity_id`**. The BS#1380 invariant (schema.ts:640-649) requires clearing it whenever the effective `discogs_release_id` changes; a stale identity minted against the old wrong id keeps feeding `rotation-artist-backfill` (reads `DISTINCT lml_identity_id` on active rows), and on the NULL path permanently escapes the drift-repair sweep (predicate: `lml_identity_id IS NULL AND discogs_release_id IS NOT NULL`). This applies to the 11 rows here **and retroactively to the 31 rows already NULL-and-reset on 2026-07-06** (239/245 direct_backfill rows carried an `lml_identity_id` per the #1521 forensics).

## Changes

### 1. Migration `0109_md-verified-release-id-source.sql` (+ schema.ts)

- Add `'md_verified'` at the **end** of the `discogsReleaseIdSourceEnum` array in `shared/database/src/schema.ts` (append-to-end matches PG `ADD VALUE` semantics, keeping DB order == snapshot order == TS order; verified against the 0108 snapshot's value list), and extend the provenance comment block above the enum (schema.ts:546-553): written only by operator-run, human-verified remediation (first use #1528); rotation-etl's flip-back CASE correctly supersedes it with `tubafrenzy_paste` if tubafrenzy later contributes a non-NULL id (a fresh MD paste outranks an old MD verification); the #1522 recurring auditor's default `--sources` scope deliberately excludes it.
- Generate via `npm run drizzle:generate` (never hand-create journal/snapshot — docs/migrations.md rule). Template is `0086_rotation-discogs-direct-backfill-source.sql`, the previous ADD VALUE on this same enum: prepend the comment block with `-- precondition-guard: not-required` and `-- @no-analyze-needed` rationale; DDL is exactly `ALTER TYPE "wxyc_schema"."discogs_release_id_source_enum" ADD VALUE 'md_verified';`.
- Hand-bump the new journal entry's `when` to tail + 1 = **1781468384353** (tail is idx 108, `when` 1781468384352). Run `npm run lint:migrations`; add the hash via `npm run drizzle:freeze-hashes` if Check 11 requires it for new files.
- DDL-only; PG12+ allows ADD VALUE inside a transaction but the value isn't usable in the same transaction — nothing else in the migration references it, so this is safe (same shape as 0086).

### 2. New script `scripts/audit/bs_1528_md_remediation.py`

Pattern-matched on `bs_rotation_release_id_remediation.py` (#1529) but with **no LML resolution** — the plan is human-decided and embedded as data:

- `PLAN`: 11 tuples `(rotation_id, expected_old_id, action, new_id, note)` with the verdicts above.
- **repoint** → `SET discogs_release_id = <new>, discogs_release_id_source = 'md_verified', lml_identity_id = NULL WHERE id = ? AND discogs_release_id = <expected_old> AND discogs_release_id_source = 'discogs_direct_backfill'`.
- **null** → `SET discogs_release_id = NULL, discogs_release_id_source = 'tubafrenzy_paste', lml_identity_id = NULL` with the same guard (matches the #1517 convention; `tubafrenzy_paste` reset keeps the row eligible for the trust-gated re-resolve paths).
- **leave** → no UPDATE; SELECT and report `confirmed` if the stored id equals the expected id, `state_drift` otherwise.
- **Retro identity scrub**: second phase over the 31 already-remediated #1517 ids (8187, 11325, 11326, 11327, 14824, 14825, 14826, 21456, 21474, 21491, 21492, 21496, 21497, 21500, 21504, 21509, 21510, 21511, 21525, 21527, 21532, 21536, 21539, 21540, 21552, 21565, 21567, 21572, 21573, 43155, 43156): `SET lml_identity_id = NULL WHERE id = ? AND discogs_release_id IS NULL AND discogs_release_id_source = 'tubafrenzy_paste' AND lml_identity_id IS NOT NULL` — the state predicate is the guard; rows already consistent match 0 rows and are skipped. Surgical per Data Safety rules: only the known 31 ids, only where the inconsistent state is confirmed.
- Conventions carried over: `--dry-run` default / `--execute`, SELECT-before (which also surfaces **43164's `add_date`** — open question 2 — and current `lml_identity_id` values), per-row guard + `rowcount == 1` check + per-row commit, SELECT-after, markdown report table, rollback-on-guard-fail, `conn.rollback()` after the read phase.
- `--self-test`: pure-function checks, no DB — plan-table integrity (ids unique and equal to the #1528 set, repoint entries carry a positive new_id, null/leave carry none, retro set is exactly the 31 and disjoint from the 11) and a `classify_row()` state-drift decision function covering proceed / skip-on-drift / leave-confirmed / leave-drift branches.

### 3. Fix `scripts/audit/bs_rotation_release_id_remediation.py`

Add `lml_identity_id = NULL` to both UPDATE branches so a future re-run doesn't strand stale identities, plus a docstring note that runs before 2026-07-07 did not clear it and the retro scrub for the 2026-07-06 run lives in `bs_1528_md_remediation.py`. No self-test changes (its tests cover `resolve_plan`, not SQL).

## Test plan

- `python3 scripts/audit/bs_1528_md_remediation.py --self-test` → all pass.
- `npm run typecheck && npm run lint && npm run format:check && npm run test:unit` in the worktree.
- `npm run lint:migrations` for the journal/snapshot/hash checks.
- `npm run ci:testmock` (Docker CI replica) since `shared/database` changes trigger the integration path; CI's `migrate-dryrun` job (migrations/\*\* path filter) applies 0109 against a restored prod snapshot at PR time.

## Rollout

1. PR from `task/1528-md-verified-remediation` (Refs #1528 — the issue closes only after prod execution). Rebase onto origin/main first; re-check the journal tail for a parallel-PR `when` collision before merge.
2. Rebase-merge after CI is green; verify the auto-deploy succeeds (migration-bearing merge — the 24h manual-deploy rule applies if it doesn't).
3. On prod EC2 (per the established runbook: /tmp venv + psycopg, creds from `docker inspect backend`, parsed in Python): `--dry-run`, review the plan table (including 43164's add_date and the guard states), then `--execute`.
4. Post the before/after report as a #1528 comment, tick the acceptance boxes (noting the 21583 verdict flip is already recorded in the verification comment), close #1528.
5. Note on #1522 that rows with `discogs_release_id_source = 'md_verified'` are intentionally out of the recurring auditor's default `--sources` scope (`bs_rotation_release_id_pollution.py` defaults exclude it): they're human-verified and not subject to re-audit.

## Risks / notes

- **Parallel-PR `when` collision** (docs/migrations.md): re-verify the journal tail at merge time. If another migration PR lands first, rebase (the `git-merge-append` driver auto-resolves the structural append), then hand-bump this entry's `when` to the new tail + 1 — the driver does not detect duplicate `when` values, so check explicitly before merging.
- **Row-state races**: every UPDATE is guarded on the observed `(id, old_id, source)` triple; a rotation-etl tick can't overwrite the writes afterward (its COALESCE keeps the persisted id and its CASE only flips source when tubafrenzy contributes a non-NULL id, which these rows don't have).
- **43164 unverifiable offline**: the clone snapshot predates the row; the dry-run SELECT-before on prod confirms `(add_date, old_id 12502729, source)` before any write.
- **Post-repoint identity re-mint**: clearing `lml_identity_id` on the 4 repointed rows makes them eligible for the daily `rotation-lml-identity-backfill` sweep (`lml_identity_id IS NULL AND discogs_release_id IS NOT NULL`) — identities regenerate against the correct ids within ~24h; no manual mint needed.
- The NULLed Killing Frost rows stay NULL at steady state (LML has no direct match — that's by design; the trust gate refuses `alternative` answers), which is the correct end state given no self-titled release exists.
