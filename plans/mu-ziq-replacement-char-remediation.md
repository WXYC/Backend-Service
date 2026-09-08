# `μ-Ziq` renders as U+FFFD in the app — close Phase 4's flowsheet gap, and repair the residue now that ground truth is captured (BS#2382)

> Revision 9. Supersedes r1–r8. Three things changed the shape of this plan: `scripts/audit/bs_replacement_char_phase4.sql` already repairs the catalog rows (r3); **tubafrenzy ground truth has been captured for every residual row** (r4); and a **decode-fidelity probe of the live read path** now settles empirically that the corruption is historical rather than ongoing (r5). Both captures are in `audit/tubafrenzy_ground_truth_pre_turndown.md`, taken 2026-09-07 hours before Milestone 1 retirement and not repeatable. The deadline that dominated r3 is met. See [What changed](#what-changed-across-revisions).

## The observation

`GET https://api.wxyc.org/flowsheet` returns corrupt bytes; the app renders them faithfully:

```
flowsheet id=5316557  album_id=1235
"artist_name": "\xEF\xBF\xBD-Ziq [mu-Ziq]"   -- EF BF BD = U+FFFD
```

The upstream corrupt value lives in `artists` id 656 (and the 10 `library` rows the audit CSV records at `id=1236`), but note that **`flowsheet` has no `artist_id` column**: `schema.ts:1152-1158` gives it `id`, `show_id`, `album_id`, `rotation_id` only. `artist_name` on a flowsheet row is a denormalized per-play snapshot with no direct artist FK — which is exactly why §1's catalog repair cannot reach it, and it constrains how §2 can be scoped.

iOS is correct throughout. `PlaylistDataSourceV2` deliberately skips `Data.repairingMojibake()`, which only reverses the round-trippable direction (`Ã¶` → `ö`) anyway. U+FFFD has no inverse. **No client change is in scope.**

That row was written today, 2026-09-07 at 1:13 PM PDT.

## What the tubafrenzy capture established

Full detail and hex in `audit/tubafrenzy_ground_truth_pre_turndown.md`. Three results reshape this plan:

**1. Tubafrenzy is completely clean — zero U+FFFD across all four source columns.** Every replacement character in Backend-Service was introduced Backend-side at ETL read time, never inherited. This retires the "is the upstream corrupt too?" question for the entire #863 family, and confirms no upstream write was ever needed.

**2. Phase 4's pin is correct, verified byte-for-byte.** `LIBRARY_CODE.ID=956.PRESENTATION_NAME` = `C2B52D5A6971205B6D752D5A69715D`, identical to the hex pinned at `bs-replacement-char-phase4.spec.js:170`. **U+00B5 MICRO SIGN, not U+03BC** — settled, and r2's contrary recommendation was wrong.

**3. Every previously-unrecoverable row is now recoverable.** Both hazardous `artists` rows (22025 `Beyoncé`, 23162 `Damian Nisenson / Jean Félix Mailloux / Pierre Tanguay`) and all five `rotation` rows Phase 3.5 left in the "no canonical identifiable" bucket. The rotation values live in `ROTATION_RELEASE`, not `LIBRARY_CODE` — which is why every earlier catalog-based search came up empty.

### The corruption is frozen, not active

**Measured, not inferred.** Replaying the production read path's exact flag set (`--protocol=TCP --default-character-set=utf8 --batch --raw --silent`, per `shared/database/src/legacy/sql.mirror.ts:71-86`) against `LIBRARY_CODE.ID=956` and dumping raw wire bytes returns `c2 b5 2d 5a 69 71 …` — **valid UTF-8**. Node's lenient decoder yields `µ` correctly. The current pipeline does not corrupt this row. Probe recorded in `audit/tubafrenzy_ground_truth_pre_turndown.md`; it is not repeatable after turndown.

So the corruption is **historical**: a past bad decode froze into `artists` id 656 via `ensureArtist` (`jobs/library-etl/job.ts:376`), which is insert-or-lookup and never updates an existing artist's name.

An earlier draft argued this from "months of clean ETL runs, still exactly one corrupt row." **That reasoning was unsound** and is withdrawn: `buildReleaseQuery` (`jobs/library-etl/job.ts:274-307`) filters `WHERE lr.TIME_LAST_MODIFIED > ${lastRunMs}`, so µ-Ziq's row is only re-read when upstream bumps it — quiet months prove nothing about decode fidelity. The probe above is the actual evidence.

**Two consequences.** The post-fix duplicate-row hazard is genuinely low — the ETL will read the identical string, fold it, and match the corrected row (note the failure mode, had the decode still been lossy, would have been a **duplicate** `artists` row from the fold-key miss, not re-corruption of 656). And §4's `MirrorSQL` hardening is defense-in-depth against a failure mode that no longer reproduces on this row — worth doing, not urgent, not step one.

Scope limit worth stating plainly: this is one row measured on one day. It does not prove the path was never lossy, nor that every other value decodes cleanly. And `flowsheet` corruption **is** still accreting — the audit CSV has no `flowsheet` entry for this value, yet row 5316557 carries it today — because new rows keep copying the frozen `artists` value forward. "Frozen" describes the source, not the blast radius.

## What Phase 4 already covers, and the one gap it leaves

`scripts/audit/bs_replacement_char_phase4.sql` (BS#2114) repairs `artists` id 656, the 10 `library` rows, and `library.album_title` id 50340 — idempotent, verified twice against a prod-derived clone, `artists`-first so migration `0060`'s `cascade_library_artist_name` trigger handles `library`.

**It never writes `flowsheet`.** Its three UPDATEs (lines 270, 276, 281) touch `artists` and `library` only; the `flowsheet` references at lines 333–339 are read-only audit counts for BS#2114 acceptance criterion 5. `flowsheet.artist_name` is denormalized per play and is not reached by the `0060` cascade, which fires only `artists`→`library`.

**That gap is exactly what the app renders.** Row 5316557 is a `flowsheet` row, so even a fully successful Phase 4 apply leaves the screenshot unchanged.

### The gating question

> **Was Phase 4 ever applied to prod?**

Evidence says no: `artists.artist_name` is what dj-site autocomplete draws from, so a flowsheet row minted today at 1:13 PM PDT carrying the corrupt string means artist 656 was still corrupt at that moment. Confirm with one read-only query before anything else:

```sql
SELECT id, artist_name, encode(convert_to(artist_name,'UTF8'),'hex')
  FROM wxyc_schema.artists WHERE id = 656;
```

- `efbfbd…` → never applied. Run it (§1).
- `c2b52d…` → it ran and something re-corrupted the row. Given finding 1 above that would be surprising and would make §3 the priority — investigate before repairing further.

## Design

### 1. Apply Phase 4

No authoring. Run the existing script per its operator instructions, including the read-only dry-run added in `6bdf18ba`. Its `WHERE` clauses match on corrupt-value AND `legacy_release_id`, so re-running against already-fixed rows is a genuine no-op — safe to apply even if its status is uncertain.

### 2. Close the flowsheet gap

**Artifact: `scripts/audit/bs_replacement_char_flowsheet.sql`, with a mirrored `tests/integration/bs-replacement-char-flowsheet.spec.js`.** A hand-applied `psql -f` operator script under `scripts/audit/`. **Do not author a Drizzle migration** (r1–r2 proposed this; wrong) — but cite the authority accurately, because `docs/migrations.md`'s `ddl-only` rule (`:62-64`) does not actually prescribe this artifact. It establishes that migrations are DDL-only (so: not a migration, which is the half that holds) and then prescribes a **one-shot backfill job under `jobs/<name>-backfill/`** for bulk DML — scoped to "rewrites of more than ~10k rows," which these repairs are nowhere near. The real authority for the operator-script posture is the predecessor headers: `bs_replacement_char_phase4.sql:3-7` states it verbatim ("Hand-applied operator script, NOT a Drizzle-tracked migration — same posture as … `bs_replacement_char_recovery.sql` … and `bs_replacement_char_phase35.sql`"). Both new scripts should carry that same sentence. The name is load-bearing in three other places below — the spec's `SCRIPT_PATH` constant (the shape at `bs-replacement-char-phase4.spec.js:43`), the CI paths-filter entry, and the acceptance criteria — so it is fixed here rather than left to the implementer. It follows the family convention already set by `recovery` / `phase35` / `phase4` / `cta`.

There is a direct precedent to extend rather than invent: `bs_replacement_char_recovery.sql:110-112` already contains exact-match `flowsheet.artist_name` repairs of precisely this family (`Csillagrablók`, `Sonido Dueñez`, `Eydie Gorme`). Those three lines only — `:113` is `record_label` and `:114-118` are `track_title`. Match its conventions, including **embedding both the corrupt and correct characters raw** rather than as `U&'\FFFD'` escapes — every predecessor does, and `bs-replacement-char-phase4.spec.js:166-176` extracts values by regex from the _script file text_, so a mirrored spec inherits that assumption.

Use the full skeleton all three predecessors share — header block → pre-amble counts → `BEGIN; SET LOCAL statement_timeout = …;` → UPDATEs → `COMMIT;` → post-amble residual verify → `ANALYZE` outside the transaction. Open with the family's `V_BS_FFFD_*` tag, which every sibling carries and which appears in operator-visible output: `bs_replacement_char_phase4.sql:1` is `V_BS_FFFD_P4`, `bs_replacement_char_cta.sql:1` is `V_BS_FFFD_CTA`, and `phase35` reuses its tag in a post-amble section label at `:56`. **Pin `V_BS_FFFD_FS` for §2 and `V_BS_FFFD_RES` for §3** rather than leaving them to the implementer.

**Set `statement_timeout` to `120s` — but not by predecessor precedent, which does not settle it.** An earlier revision justified 120s as coming from "`recovery.sql:97`, the flowsheet-writing predecessor"; that is false, because `bs_replacement_char_phase35.sql:42` also writes `flowsheet` and uses `60s`. The two predecessors disagree. Justify it from the cost model instead: `flowsheet` is the ~1.7 GB table (`schema.ts:1368`) with `search_doc` regeneration, ~6 index updates and CDC `pg_notify` per row, this repair's row count is still unmeasured, and a timeout aborts the whole transaction — so take the larger of the two.

**And add a batching branch.** `docs/bulk-update-playbook.md:43` sets 5000 as the batch size (`BACKFILL_BATCH_SIZE`), sized so each batch lands under a per-statement timeout on a healthy host. A single unbatched UPDATE inside one transaction is off-playbook if the pre-count runs to thousands. **If the pre-count exceeds ~5000, switch to the playbook's id-cursor batch recipe** instead of raising the timeout further; below that, the single statement is fine and matches every predecessor.

```sql
-- pre-amble: record this count in the PR, per Phase 4's convention
SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = '<?>-Ziq [mu-Ziq]';

BEGIN;
SET LOCAL statement_timeout = '120s';   -- matching recovery.sql:97, the flowsheet-writing predecessor
UPDATE wxyc_schema.flowsheet SET artist_name = 'µ-Ziq [mu-Ziq]'
 WHERE artist_name = '<?>-Ziq [mu-Ziq]';   -- raw U+FFFD, as predecessors do
COMMIT;

-- post-amble verify, then:
ANALYZE wxyc_schema.flowsheet;
```

Keep `BEGIN;` at column 0, so commit `6bdf18ba`'s operator dry-run idiom (`awk '/^BEGIN;/{exit}'`, which prints everything up to the first transaction) works on this script too.

The replacement must be byte-identical to Phase 4's `C2B5…` or the two repairs disagree. No NFC normalization — Phase 4 documents that normalizing on write is the one thing that could reintroduce a byte-exact parity mismatch, and `catalog_parity_diff.py::_normalize` applies "no case folding, no accent folding".

**Ordering constraint: apply §1 first, then take this pre-count and apply §2 in the same window.** New corrupt `flowsheet` rows keep minting from `artists.artist_name` via dj-site until Phase 4 lands, so a count taken before §1 is already stale when §2 runs and the PR-recorded number will not match what the UPDATE touches. Re-read the count immediately before `COMMIT`.

**The row count is unknown and must be measured.** This value does not appear in `audit/bs_replacement_char_audit.csv` at all, so no prior count exists. `docs/bulk-update-playbook.md:7-19` prices the per-row `flowsheet` cost (search_doc regeneration + ~6 index updates + CDC `pg_notify` at ~500 bytes/row); the pre-amble count is the input that cost model needs.

`ANALYZE` is **a hard CI gate**, correcting r3: `.github/workflows/test.yml:304` runs `node scripts/check-bulk-update-analyze.mjs --strict`, and its scan set includes `scripts/**`, so the new file is covered. (r2 had this right; r3 wrongly softened it to warn-only — that is the default, not what CI runs.)

**Test it** to the established shape — `tests/integration/bs-replacement-char-phase4.spec.js` and `bs-replacement-char-cta.spec.js` extract the real UPDATEs from the `.sql`, run them against a throwaway schema, and pin exact-string scoping, idempotency, and near-miss decoys. Port the suffix-sharing decoy at `bs-replacement-char-phase4.spec.js:193` (`<?>ther-Ziq [mu-Ziq]` under a different corrupt prefix), which an exact-match UPDATE satisfies, plus a hex assertion mirroring `c2b52d5a6971205b6d752d5a69715d` so the two scripts cannot drift. **Do not port the second decoy at `:200`** — the exact corrupt string at an unlisted id. It passes in Phase 4 only because that UPDATE carries `legacy_release_id IN (…)`; §2's flowsheet statement is deliberately unscoped, so copying it would fail by design.

**Why unscoped, stated correctly.** An earlier revision justified this as "flowsheet has no catalog id" — that is false; it has `album_id` → `library.id` (`schema.ts:1156`). The real reason is that scoping on it would **under-repair**: free-form plays carry a NULL `album_id`, and those rows hold the same denormalized `artist_name` snapshot. An `album_id`-scoped UPDATE would silently skip every one of them. Record that rationale in the script header, and add a NULL-`album_id` row to the spec as a _positive_ case — it must be repaired — alongside the ported `:193` decoy, which must not.

**Register the script in the CI paths-filter — the drift guard is opt-in, not automatic.** `.github/workflows/test.yml:68-89` lists each operator `.sql` that an integration spec reads verbatim under the `tests:` filter, with a comment explaining why: "editing one must re-run its integration test, or the drift guard is silently bypassed on a script-only PR." Four scripts are enrolled today (`relabel-rotation-direct-backfill.sql`, `bs_format_qualifier_recovery.sql`, `bs_2117_crossref_backfill.sql`, `bs_replacement_char_cta.sql`). Both new scripts in this plan need an entry with the same commented rationale, or their specs simply do not run on the PR that edits the `.sql` — which is exactly the PR where drift is introduced:

```yaml
# tests/integration/bs-replacement-char-flowsheet.spec.js reads:
- 'scripts/audit/bs_replacement_char_flowsheet.sql'
# tests/integration/bs-replacement-char-residue.spec.js reads:
- 'scripts/audit/bs_replacement_char_residue.sql'
```

`scripts/audit/bs_replacement_char_phase4.sql` is itself missing from that list despite `bs-replacement-char-phase4.spec.js:43` reading it verbatim — a pre-existing hole in this same family. Fix it in the same PR; it is a one-line addition and this plan is the natural place to notice it.

### 3. Repair the residue — now unblocked

Ground truth for all seven previously-unrecoverable rows is captured in `audit/tubafrenzy_ground_truth_pre_turndown.md`. This was the deadline-driven work; it is no longer deadline-driven, but it is no longer _blocked_ either.

**Artifact: a new `scripts/audit/bs_replacement_char_residue.sql`, with a mirrored `tests/integration/bs-replacement-char-residue.spec.js`** following the same extract-and-run shape as §2's. It must **not** be folded into `bs_replacement_char_phase4.sql` — that script's spec hard-codes its shape, throwing unless it finds exactly three UPDATEs (`bs-replacement-char-phase4.spec.js:78-81`), so adding statements there breaks a green test.

**Do not copy the hex assertion's regex verbatim — it does not generalize to this script.** `bs-replacement-char-phase4.spec.js:166-167` uses `scriptText.match(/SET artist_name = '(.+?)'/)`, non-global, so `String.match` returns only the **first** occurrence. That is sound in Phase 4, which has exactly one `SET artist_name`. This script will carry five or six (`artists` 22025 and 23162, `rotation` 13703 / 21149 / 21335, plus 16683 if the override is taken), so the copied form would pin bytes on one statement and pass no matter what the other four wrote — the precise drift the guard exists to catch. Use `matchAll` with the `g` flag and assert against a per-target expected-hex map built from `audit/tubafrenzy_ground_truth_pre_turndown.md`, which already records the hex for every one of these values.

**`ANALYZE` `artists`, `library`, and `rotation`** — all three. `bs_replacement_char_phase4.sql:361-362` is the precedent for the first two only; its comment at `:358-360` explicitly notes that script leaves `rotation`/`flowsheet` alone because they are read-only there. For the `rotation` ANALYZE the precedent is `bs_replacement_char_phase35.sql:97-98` (`ANALYZE flowsheet; ANALYZE rotation;`), which does write them. All three are cheap and unconditionally correct, but be accurate about why, because the obvious rationale is wrong here: the `0060` cascade will write **zero** `library` rows on this repair. `bs_replacement_char_recovery.sql:126-127` already set `library.artist_name` to `Beyoncé` and `Damian Nisenson / Jean Félix Mailloux / Pierre Tanguay` — byte-identical to the captured ground truth — and `cascade_library_artist_name` guards with `artist_name IS DISTINCT FROM NEW.artist_name` (`0060_*.sql:20-30`), so it is inert. The `library` `ANALYZE` is defensive only. And `rotation` is named directly in §3's own UPDATE statements, so `scripts/check-bulk-update-analyze.mjs` sees it normally — it is not an instance of the line-level checker's blind spot.

(That blind spot is real and worth keeping in mind for any _future_ repair where a cascade is the only writer of a table: the checker is line-level per its own header, so it would see only `UPDATE artists` and pass CI while the cascaded table's stats went stale — the BS#934 shape. It just isn't what is happening here.)

**`artists` 22025 / 23162 should go first among these** — they are actively regressive, not merely unfinished. #863 fixed both on `library.artist_name` only, never the `artists` source of truth, so via the `0060` cascade any future write to `artists.artist_name` pushes the corrupt value back onto every linked `library` row and **silently undoes the #863 fix**. Phase 4's header records two further arming conditions needing no `artists` write at all: discogs-etl's `cross_reference_names` reads that column directly with no `library` fallback, and its `artist_name` COALESCEs through to it on any NULL `library.artist_name`. Both measured unarmed in the 2026-08-12 clone. Note 22025's `alphabetical_name` is corrupt too and has **no** cascade (trigger `0060` fires only on `artist_name`) — inert, but it is what sorts and displays.

**Pre-flight the `artists` writes for a fold-key collision — the index will not stop you.** `artists_fold_name_idx` is a **plain, non-unique** btree over `fold_artist_name(artist_name)` (`0134_fold-artist-name.sql:82`, and its own header says so at `:3` and `:58`). So rewriting 22025 to `Beyoncé` cannot error on a duplicate; it can silently leave two `artists` rows sharing one fold key. That is precisely the BS#1897 condition `jobs/artist-unicode-dedup/` exists to merge — it partitions `library` rows across two `artist_id`s and breaks reconciled-identity attachment. `Beyoncé` is a high-probability pre-existing row, since `bs_replacement_char_recovery.sql:126` already wrote that exact string into `library.artist_name`. The fold-match argument this plan makes for artist 656 was never extended to 22025 and 23162; it must be, and by measurement:

```sql
-- pre-flight, before any UPDATE: expect zero rows.
-- Asks the post-repair question directly: does some OTHER artist row already
-- fold to what 22025 / 23162 will fold to once repaired?
SELECT a.id, a.artist_name, t.target_id
  FROM (VALUES (22025, 'Beyoncé'),
               (23162, 'Damian Nisenson / Jean Félix Mailloux / Pierre Tanguay'))
       AS t(target_id, repaired_name)
  JOIN wxyc_schema.artists a
    ON wxyc_schema.fold_artist_name(a.artist_name)
     = wxyc_schema.fold_artist_name(t.repaired_name)
 WHERE a.id <> t.target_id;
```

It has to be phrased as the _post-repair_ question — a plain `GROUP BY fold HAVING count(*) > 1` over the current state finds nothing, because the corrupt and clean spellings fold differently until the UPDATE lands (U+FFFD is not a combining mark, so `Beyonc<?>` folds to `beyonc<?>`, not `beyonce`). If this returns a row, the repair is a **merge**, not an UPDATE, and belongs on `artist-unicode-dedup`'s path. Extend verification step 5's "exactly one artist" check to cover 22025 and 23162, not just 656.

The `rotation` work splits into **five mechanical repairs and one conditional** — do not bundle them, because five of the six are unambiguous:

_Mechanical_ (each still contains U+FFFD; each keyed on its unique corrupt value, self-scoping by construction):

- `artist_name` at 13703 (`Accüsed`), 21149 (`Nídia & Valentina`), 21335 (`Civilistjävel! & Mayssa Jallad`)
- `album_title` at 10789 (`«†»`) and **16683 (`Amare Touré 1973-1980`)**

That last one matters: `audit/bs_replacement_char_audit.csv` records `rotation,album_title,Amare Tour<?> 1973-1980,1,1,id=16683`, so 16683's _album_title_ still holds U+FFFD and its repair is **not** optional — it is one of the two album_title fixes that produce the "0 rows" residual. Only 16683's `artist_name` is the judgement call.

_Conditional — MD decision:_ **Phase 2's curated `Amara Toure` fix for rotation 16683's `artist_name` appears to be wrong.** Tubafrenzy holds `Amare Touré`, differing in both a vowel and an accent. Overriding it means overwriting a previously-curated value.

**If overriding, this is the one UPDATE in the family that needs an explicit id bound.** `bs_replacement_char_recovery.sql:130` already rewrote that row to plain-ASCII `Amara Toure` — a value that is _not_ unique by construction, unlike every other target here, whose corrupt string is self-scoping. Follow the house pattern from `bs_replacement_char_phase4.sql:278-279` and key it `WHERE id = 16683 AND artist_name = 'Amara Toure'`, after confirming 16683 against `wxyc_schema.rotation` (the tubafrenzy→Backend mapping is name-matched, not verified).

If the MD declines the override, the row lands mixed — `artist_name = 'Amara Toure'`, `album_title = 'Amare Touré 1973-1980'` — which is a legitimate outcome but should be a chosen one. Note tubafrenzy is itself internally inconsistent for this artist (`LIBRARY_CODE` says `Amara Toure`, `ROTATION_RELEASE` says `Amare Touré`); byte-exact parity means faithfully reproducing that inconsistency.

Scope check: this could reasonably be its own ticket. It is included here because the ground-truth pull that unblocked it happened here, and splitting would strand the context. Split it if the diff gets unwieldy.

### 4. Defense-in-depth: make the decode failure loud

Not urgent (see "the corruption is frozen"), but this is the only item that protects against the failure mode recurring, and it is why #863 was archaeology rather than an alert: today nothing downstream can distinguish "upstream genuinely contains U+FFFD" from "we just destroyed a byte."

Production reads legacy MySQL over SSH — `MirrorSQL.send` (`shared/database/src/legacy/sql.mirror.ts:107-134`) reads `const { stdout, stderr, code } = await ssh.execCommand(...)`, an already-decoded, already-lossy string. Node's UTF-8 decoding is WHATWG-lenient and silently substitutes U+FFFD for invalid bytes. (r1–r2 proposed hardening `sendLocal`'s `execSync`; that branch is reached only when `LEGACY_DB_DOCKER_CONTAINER` is set — one place repo-wide, `tests/e2e/etl.test.ts:33` — so fixing only it would change nothing in production.)

Three constraints, in dependency order:

- **Prerequisite: there is no Buffer to work with yet.** `shared/database/src/legacy/sql.mirror.ts:117` is `const { stdout, stderr, code } = await ssh.execCommand(mysqlCommand, {})` — node-ssh returns an already-decoded `string`, so the U+FFFD substitution has happened before any repo code sees a byte. Capturing bytes is therefore step zero, not an implementation detail: pass `execCommand`'s `onStdout: (chunk: Buffer) => …` callback and accumulate, and drop `encoding: 'utf8'` from `sendLocal`'s `execSync` (`sql.mirror.ts:96`) so it hands back a Buffer. **Keep that Buffer local to `sendLocal` and keep the method returning `string`** — its signature is `private sendLocal(sql: string): string` (`:87`, returning at `:97`), and `send`'s return (`:133`) flows to `cmd.lastResult` at `commandqueue.mirror.ts:286`, so changing the return type is a much wider blast radius than this step wants. Nothing else in this section is implementable until byte capture lands. (Note `send` spans `107-134` and does check `code`/`stderr` at `119-131` — a strict-decode failure needs to surface alongside that existing error handling, not bypass it.)
- **Do not split on newlines.** An earlier draft proposed splitting the buffer on `0x0A` and strict-decoding per line, justified as "`--batch` escapes embedded newlines". That is wrong: `makeSqlCommand` passes `--batch --raw --silent` (`shared/database/src/legacy/sql.mirror.ts:82`, and `sendLocal` at `:93`), and `--raw` exists precisely to **disable** that `\n`/`\t`/`\\` escaping — a value containing a literal newline would split mid-record. Dropping `--raw` would fix that but changes parsing for `parseTabRow` and every `parseReleaseRows` consumer, so it needs its own justification and is out of scope here. Instead, pick a boundary that assumes nothing: strict-decode the **whole** buffer to get a yes/no on batch validity, and on failure scan the raw bytes for invalid UTF-8 sequences and report each offset with a hex context window. That localizes the damage for an operator without needing record boundaries at all.
- **`send` is on the live DJ write path, not just a cron.** `apps/backend/middleware/legacy/commandqueue.mirror.ts:286` calls `MirrorSQL.instance().send(cmd.sql)` for every mirrored flowsheet command. A hard throw there fails a DJ's write mid-show. **Make strictness an opt-in option on `send`** — lenient default for the commandqueue, strict for the ETL jobs. The full caller inventory: `jobs/library-etl/job.ts:20`, `flowsheet-etl`, `rotation-etl`, `flowsheet-show-split`, `flowsheet-april-gap-import`, `legacy-dj-name-remediation`.

  **`library-etl` is the caller that matters, and it must be the one that opts in.** It owns `ensureArtist` (`jobs/library-etl/job.ts:376`) — the exact mechanism this plan says froze the corruption into `artists` 656 — and per CLAUDE.md's job table it is the last job on a live `*/30` cron; `flowsheet-etl` and `rotation-etl` are one-shot behind `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`. Because strictness is opt-in per call, shipping the option without wiring it into `library-etl` protects nothing. This is the same job Open Question 4 turns on.

  **Set strictness on the instance, not per call — `library-etl` has nine `send` sites.** `legacyDB.send(...)` appears at `jobs/library-etl/job.ts:221, 226, 353, 359, 365, 369, 590, 629, 725`. A per-call opt-in satisfied by editing one of them leaves eight silently lenient, which is precisely the gap §4 exists to close. Configure the instance the job already holds at `job.ts:20` (`const legacyDB = MirrorSQL.instance()`) so every read inherits it. The same multiplicity applies to the other jobs if they are ever wired: `flowsheet-etl` (`fetch-legacy.ts:89, 196, 202`; `backfill-legacy-ids.ts:28, 101`) and `rotation-etl` (`fetch-legacy.ts:86`).

- **Scope limit: strict decode cannot catch the utf8mb3 substitution class.** `makeSqlCommand` pins `--default-character-set=utf8` (`sql.mirror.ts:81`), which in MySQL is the 3-byte `utf8mb3` alias. Any 4-byte codepoint in a `utf8mb4` column is substituted server-side _before_ it reaches the wire and arrives as valid ASCII `?`, so a whole-buffer strict decode passes it silently — and the fidelity probe, which replayed this exact flag set, cannot distinguish it either. Two things bound how much this matters here: the four tubafrenzy source columns are declared `utf8_unicode_ci` (itself utf8mb3), so they cannot _store_ a 4-byte codepoint in the first place, and this class produces `?`, not U+FFFD, so it is not the `#863` corruption. But §4 is framed above as the item that stops the failure mode recurring, and that claim should be scoped: it catches invalid-byte-sequence loss, not charset-narrowing loss. Widening the connection to `utf8mb4`, or flagging literal `?` runs, is a separate change and out of scope here.

Test at `tests/unit/middleware/legacy/mirror.charset.test.ts`, alongside the existing suite (`ssh-timeout.test.ts` is the precedent for importing `MirrorSQL` and mocking `node-ssh`), feeding a lone `0xB5` through both branches. Do **not** add this artist to `tests/unit/charset-torture/`: `tests/fixtures/charset-torture.json:55-60` pins the _bare_ name `μ-Ziq` in U+03BC, a different string from the catalog form — conflating the two is what produced r2's wrong recommendation.

## Data safety

- Every UPDATE is value-keyed (Phase 4 additionally `legacy_release_id`-scoped) and idempotent; re-runs are genuine no-ops, verified against a clone.
- No `DELETE`, `TRUNCATE`, or column drop. No writes were made to tubafrenzy during the capture — `SELECT`/`SHOW` only.
- Capture pre-state across `artists`/`library`/`flowsheet`/`rotation` to a file before applying, as the rollback key.
- Phase 4's blast-radius guard assumes the corrupt string identifies exactly one `artists` row — a fact about the data, not a property of the statement. Re-verify against prod before applying.
- The tubafrenzy→Backend id mappings in the capture doc are matched **by name**, not verified against prod Postgres. The `artists` mappings are unique-name matches; **confirm the `rotation` mappings against `wxyc_schema.rotation` before scoping any UPDATE by Backend id.**

## Verification

1. `SELECT encode(convert_to(artist_name,'UTF8'),'hex') FROM wxyc_schema.artists WHERE id = 656` returns `c2b52d5a6971205b6d752d5a69715d`.
2. **Scoped to this repair's strings only**: zero rows remain matching `'<?>-Ziq [mu-Ziq]'` across `artists`, `library`, `flowsheet`; and zero for the seven §3 values.

   Residual U+FFFD elsewhere is expected, but **the figures must net out the Phase 2 / 3.5 repairs that already shipped, and the units must be carried explicitly** — the audit CSV is one line per _distinct lossy value_ with a separate `row_count` column, while the post-amble this mirrors (`bs_replacement_char_phase4.sql:333-339`) returns `COUNT(*)` **rows**. Mixing them reads a passing verify as a failure. Both units are carried below so the derivation can be checked either way; they agree here, but that is a fact to be shown, not assumed. Derived against `bs_replacement_char_recovery.sql:110-135` and `bs_replacement_char_phase35.sql:44-49`:

   | column                                                  | audit (values / rows) | already repaired |   repaired by §2 | repaired by §3 |              **expected residual** |
   | ------------------------------------------------------- | --------------------: | ---------------: | ---------------: | -------------: | ---------------------------------: |
   | `artists.artist_name`                                   |                     — |                — |                — |          2 / 2 |                  **0 / 0** (was 2) |
   | `artists.alphabetical_name`                             |                     — |                — |                — |          1 / 1 |                  **0 / 0** (was 1) |
   | `flowsheet.artist_name`                                 |                 7 / 9 |            6 / 8 | _N_ (unmeasured) |              0 |   **1 value / 1 row** (`p<?>r-no`) |
   | `rotation.artist_name`                                  |                 8 / 8 |            5 / 5 |                — |          3 / 3 |                          **0 / 0** |
   | `rotation.album_title`                                  |                 5 / 5 |            3 / 3 |                — |          2 / 2 |                          **0 / 0** |
   | `compilation_track_artist.artist_name` / `.track_title` |                     — |                — |                — |              0 | **0 rows** (measure, don't assume) |

   The two `artists` rows come from a different source than the rest of the table: `bs_replacement_char_phase4.sql:319` pins the expected **post-Phase-4** residual against the 2026-08-12 clone as "artist_name 2, alphabetical_name 1" — those are 22025 and 23162, plus 22025's `alphabetical_name`. §3 is what drives them to zero, and its post-amble counts sit at `:321` and `:323`. Without these rows an operator re-running Phase 4's post-amble after §3 has no stated expectation and reads a passing verify as a failure.

   `flowsheet.artist_name`'s already-repaired 6 values split 3 in `recovery.sql:110-112` (`Csillagrablók` ×2 rows, `Sonido Dueñez` ×2, `Eydie Gorme` ×1) and 3 in `phase35.sql:45-47` (`Ana María Vahos`, `Mehmet Güreli`, `Uğur Yücel`, ×1 each). Every `rotation` row in the CSV has `row_count = 1`, which is why its two columns read identically in both units.

   **The §2 column is why this table cannot be read before §2 runs.** `<?>-Ziq [mu-Ziq]` has no `flowsheet` entry in the audit CSV at all — only `library,artist_name,<?>-Ziq [mu-Ziq],10,1,id=1236` — yet those flowsheet rows demonstrably exist today; they are what the app renders. Phase 4's post-amble at `:333` is a bare `COUNT(*) … WHERE artist_name LIKE E'%<?>%'` over the whole column, so between §1 and §2 it returns `1 + N`, not `1`. That is precisely the trap this paragraph warns about, arriving from the direction of an unmeasured row count rather than a unit mismatch. Read the `flowsheet.artist_name` residual as **post-§2 only**.

   The CTA row is there because `bs_replacement_char_phase4.sql:351` and `:353` audit that table for exactly this reason — so a script cannot report clean while the parity harness fails on rows it never looked at — and `bs_replacement_char_cta.sql` (BS#2152) is a whole sibling script for it. No `Ziq` value appears in that script, so 0 is the expected answer; Phase 4's convention is to state it as measured rather than assumed.

   Note the consequence: **§3 fully clears `rotation` for this corruption class.** Both rotation columns should verify at zero, not at a non-zero residual.

3. `GET https://api.wxyc.org/flowsheet` contains `c2 b5` and no `ef bf bd` for this artist.
4. iOS renders `µ-Ziq [mu-Ziq]` — no app release; the string is server-supplied.
5. dj-site autocomplete returns exactly one artist for "ziq" — and, per the fold-collision pre-flight above, exactly one for "beyonce" and one for "nisenson". A repair that stranded a fold-key duplicate shows up here as two entries, which is the user-visible face of the BS#1897 partition.
6. New flowsheet repair spec + `mirror.charset` unit test green; Phase 4's existing spec still green.
7. discogs-etl catalog-parity harness reports 0 mismatches for the repaired ids — **not runnable as written**. `catalog_parity_diff.py` is cited as `scripts/catalog_parity_diff.py` by `bs_replacement_char_phase4.sql:157` and `bs_2117_crossref_backfill.sql:235`, but it exists nowhere under `~/Developer/WXYC` (this repo's `scripts/` holds only `build-flowsheet-stamps-sql.py`). Locate the harness and record its real repo/path, or drop this from the gate list and verify via steps 1–3 instead. Do not leave it as an unrunnable checkbox.

## Acceptance criteria

- [x] **Step zero: file the BS# issue — this is BS#2382.** Every artifact in this plan needs it by convention and cannot be written without it: `bs_replacement_char_phase4.sql:1` carries "for #2114" in its header, `bs_replacement_char_cta.sql` carries BS#2152, and the paths-filter comments at `.github/workflows/test.yml:78` and `:80-89` cite BS#2117 / BS#2152. Thread `#2382` through both new script headers (`V_BS_FFFD_FS` and `V_BS_FFFD_RES`), both new paths-filter comments, and the PR title.
- [ ] Phase 4 application status established and recorded in the PR.
- [ ] Phase 4 applied (or confirmed already applied).
- [ ] `scripts/audit/bs_replacement_char_flowsheet.sql` written to the predecessor skeleton, pre-count recorded in the PR, tested by `tests/integration/bs-replacement-char-flowsheet.spec.js` to the existing spec shape, applied.
- [ ] Both new scripts — and the pre-existing `bs_replacement_char_phase4.sql` omission — enrolled under the `tests:` paths-filter at `.github/workflows/test.yml:68-89`, each with the commented rationale the existing four carry.
- [ ] Fold-collision pre-flight run for 22025 / 23162 and its result recorded; if it returns a row, the repair is re-scoped as an `artist-unicode-dedup` merge rather than an UPDATE.
- [ ] `artists` 22025 / 23162 repaired from captured ground truth (incl. 22025's `alphabetical_name`).
- [ ] Five mechanical `rotation` repairs applied (3 artist_name, 2 album_title incl. 16683.album_title); 16683.artist_name override explicitly decided by the MD and, if applied, id-scoped.
- [ ] **Conditional on Open Question 4** — if `MirrorSQL` survives Milestone 1: strict-decode available as an opt-in per call (**whole-buffer decode reporting invalid-sequence byte offsets**, never per-line — see §4), wired in **at the instance** `jobs/library-etl/job.ts:20` holds — not per call, or eight of its nine `send` sites stay lenient — with `commandqueue.mirror.ts:286` left lenient; `sendLocal` still returns `string`; unit test green. If OQ4 resolves that the read path is retired, this drops to a follow-up ticket and §4's deliverable here is the recorded probe alone — which is already done. Do not treat it as a blocking checkbox before OQ4 is settled.
- [ ] `audit/tubafrenzy_ground_truth_pre_turndown.md` committed. **This is the irreplaceable artifact** — tubafrenzy is gone after today.
- [ ] `/flowsheet` and `/playlists/recentEntries?v=2` serve the corrected name.
- [ ] No iOS change shipped.
- [ ] `docs/migrations.md`'s "Journal idx vs filename idx (post-2026-06-14 invariant)" section corrected (`:182-196`) — **a section edit, not the one-liner earlier revisions claimed**: the table at `:186-192` ends at `0099_*.sql | 100` and the prose at `:184` asserts the +1 offset holds "from journal idx 47 onward", but the journal re-syncs at idx 101 (`0101_rotation-discogs-release-id-not-sentinel`) and the tail is idx 161 → `0161_station-signup-downgraded-at`. Needs a new table row, a qualified heading, and a prose fix. **Split this into its own PR** — it is unrelated to the mu-Ziq repair and only surfaced here.

## Out of scope

- The other lossy values in `bs_replacement_char_audit.csv` not named here. After Phase 2/3.5 and this ticket, the artist-name residue is **one** `flowsheet.artist_name` value (`p<?>r-no`, 1 row) — `rotation` is fully cleared by §3 — plus the `flowsheet.track_title` / `album_title` / `record_label` families, which this ticket does not touch. Ground truth for those was **not** captured and tubafrenzy is gone; recovering them means LML/Discogs fuzzy matching under #863's ≥0.80 gate, or accepting them as permanent.
- The `Î¼`-family round-trippable mojibake — handled by `0064` / `0066`.
- Any change to `Data.repairingMojibake()` on iOS. It is correct and correctly not applied to V2.
- Reconciling `0064`'s bare-name `μ-Ziq` flowsheet rows (U+03BC) to the catalog form. Those are free-form plays, not catalog-linked, so they are legitimately a different string. MD call, non-blocking.
- Retiring the `[mu-Ziq]` card-catalog suffix convention.

## Documentation fix to include

`docs/migrations.md`'s "Journal idx vs filename idx (post-2026-06-14 invariant)" section still presents the journal-idx-is-filename-plus-one offset as current. It re-synced at `idx 101` (`0101_rotation-discogs-release-id-not-sentinel`); the tail is `idx 161 / 0161_station-signup-downgraded-at`, delta 0. Correct it so the next author doesn't hand-derive a wrong filename.

## Open questions

1. **Was Phase 4 applied to prod?** Gates sequencing. Read-only query, above.
2. **Rotation 16683**: overwrite Phase 2's curated `Amara Toure` with tubafrenzy's `Amare Touré`? Byte-exact parity says yes; it means overriding a human-curated value with an upstream typo.
3. Strict-decode default for the ETL jobs: throw, or collect-and-report by byte offset?
4. **Does the `MirrorSQL` read path survive Milestone 1 at all?** It exists solely to reach tubafrenzy. Per CLAUDE.md's job table, `flowsheet-etl` and `rotation-etl` are already one-shot behind `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`, leaving `library-etl`'s `*/30` as effectively the last live consumer. If today's retirement removes tubafrenzy, §4's opt-in strict-decode option ships with no caller — and its durable value was the diagnostic probe (already run and recorded), not the shipped code. Settle this before building §4.

## What changed across revisions

| Earlier revision said                                                         | Established since                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| r1–r2: author a Drizzle migration                                             | `scripts/audit/*.sql` operator script — migrations are DDL-only (r3)                                                                              |
| r1–r2: step 1 is "verify the upstream byte"                                   | Captured directly: tubafrenzy has **zero** U+FFFD anywhere (r4)                                                                                   |
| r2: recommend U+03BC, "two pins vs zero"                                      | U+00B5, now verified byte-for-byte against tubafrenzy (r3, confirmed r4)                                                                          |
| r3: rotation rows are unrecoverable, deadline-lost                            | All five recovered from `ROTATION_RELEASE` (r4)                                                                                                   |
| r3: ETL re-corruption is a critical hazard                                    | Low — upstream is clean, so the post-fix ETL fold-matches the corrected row (r4)                                                                  |
| r3: `check-bulk-update-analyze` is warn-only                                  | Hard CI gate: `test.yml:304` runs it `--strict` (r2 was right)                                                                                    |
| r3: fallback = "log the row key and skip"                                     | Not implementable at `send`; it returns one string per batch (r4)                                                                                 |
| r3: throw-vs-skip is an ETL cron decision                                     | `send` is on the live DJ write path via `commandqueue.mirror.ts:286` (r4)                                                                         |
| r3: framed the flowsheet write as new work                                    | `bs_replacement_char_recovery.sql:110-112` already repairs this exact family                                                                      |
| r6: §2's script left unnamed; new scripts not enrolled in the CI paths-filter | Named `bs_replacement_char_flowsheet.sql`; both new scripts (and the pre-existing `phase4.sql` hole) enrolled at `test.yml:68-89` (r7)            |
| r6: fold-match argument applied to artist 656 only                            | `artists_fold_name_idx` is non-unique (`0134:82`), so 22025 / 23162 need a post-repair collision pre-flight (r7)                                  |
| r7: §4 caller inventory omitted `library-etl`                                 | `jobs/library-etl/job.ts:20` — it owns `ensureArtist` and is the last live `*/30` consumer, so it is _the_ strict-mode caller (r8)                |
| r7: "mirror §2's spec shape" for §3                                           | Phase 4's hex regex is non-global (`spec.js:167`); copied onto a 5–6 UPDATE script it checks only the first (r8)                                  |
| r1–r7: §4 stops the failure mode recurring                                    | Scoped: it catches invalid-byte loss, not utf8mb3 charset-narrowing to `?` (`sql.mirror.ts:81`) (r8)                                              |
| r1–r8: "flowsheet has no catalog id"                                          | False — it has `album_id` (`schema.ts:1156`); unscoped is right because free-form plays carry NULL `album_id` and scoping would under-repair (r9) |
| r8: 120s "from `recovery.sql:97`, the flowsheet-writing predecessor"          | `phase35.sql:42` also writes flowsheet, at 60s. 120s stands, justified by the cost model instead (r9)                                             |
| r1–r8: operator script "per `docs/migrations.md`'s `ddl-only` rule"           | That rule prescribes a one-shot backfill job above ~10k rows; the real authority is `phase4.sql:3-7` (r9)                                         |
| r8: "wire strict decode into `library-etl`"                                   | Nine `send` sites in that job — set it on the instance at `job.ts:20` (r9)                                                                        |

Constant across all four: `flowsheet` is a real gap Phase 4 does not cover, and the `MirrorSQL` SSH decode is a real silent-corruption source.
