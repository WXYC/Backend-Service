# library-label-backfill

Resolves a canonical record label per library card from tubafrenzy's acquisition record ([BS#2669](https://github.com/WXYC/Backend-Service/issues/2669)).

**This job writes nothing.** It opens no database connection at all — not even a read-only one. It reads a gzipped `mysqldump` off local disk and emits two TSVs plus `REPORT.md` into this directory. Applying the mapping to `wxyc_schema.library` is [BS#2672](https://github.com/WXYC/Backend-Service/issues/2672).

## Why it exists

`wxyc_schema.library.label` and `.label_id` have been 100% NULL since the schema was written — 0 of 64,193 rows. That is not an ETL bug: tubafrenzy's `LIBRARY_RELEASE` has no label column, so `jobs/library-etl` has nothing to map from.

The gap is load-bearing in three places: `library-search.service.ts`'s `buildAllFieldMatch` ILIKEs `label` on every query and the disjunct matches nothing; [BS#871](https://github.com/WXYC/Backend-Service/issues/871)'s `search_doc` weight and trigram index would ship inert; and `discogs-etl`'s top-priority `label_match` dedup key is rebuilt each run from an unresolved _set_ of flowsheet labels, so one mistyped entry can promote the wrong pressing.

## The source: `ROTATION_RELEASE`, not the flowsheet

`ROTATION_RELEASE` records something the station acquired. It carries `LIBRARY_RELEASE_ID` **directly** and a `COMPANY_ID` foreign key into `COMPANY`, whose `NAME` is the label. Reading those two tables — 21,641 + 7,246 rows — covers 17,175 cards and resolves 17,088 of them.

Because the label arrives as a **foreign key rather than free text**, this route needs no spelling normalization, no modal vote and no unanimity rule, and it supplies `library.label_id` directly instead of matching strings against `wxyc_schema.labels`. It also dissolves the compound-label problem, since `COMPANY_ID` is singular where a copied string is `Honest Jons/Astralwerks`.

### The one piece of text handling, and why

`COMPANY` holds 7,246 rows but only 5,964 distinct names. A label re-acquired years later was often entered as a fresh row, so "atlantic" exists as ids 123, 6446 and 6486. Grouping a card's rotation rows by raw `COMPANY_ID` would call 51 cards conflicted when every id names the same label, so comparison is by **case-folded `COMPANY.NAME`** — trim plus lowercase, nothing else. Seven of those cards differ only in letter case, which is why the fold is case-insensitive rather than exact.

That is a case-insensitive comparison of curated foreign-key targets, not the punctuation-stripping, suffix-dropping, diacritic-folding rule free text would need. `foldCompanyName` deliberately leaves `Sub-Pop` and `Sub Pop` distinct.

**BS#2672 must collapse the duplication rather than carry it across** — three "Atlantic" rows in `wxyc_schema.labels` would reintroduce the same problem on the Backend side. `label-mapping.tsv` carries a `company_ids` column listing every id behind each resolved name so the write side can see what it is collapsing.

## Why DJ-typed labels are excluded

`FLOWSHEET_ENTRY_PROD.LABEL_NAME` pools two provenances under one column name. Rotation-linked plays carry a label the system **copied** off the `ROTATION_RELEASE` record (100.0% fill — a copy, not diligence); everything else is free text a DJ typed per play (84.0% fill). Excluding the second costs 22,820 cards that nothing else covers, which is not a small number.

It is excluded anyway, and the reason is provenance rather than volume. A DJ-typed label describes whatever object was in that DJ's hands; nothing records whether that was the library's copy, and `library.label` exists to answer "which pressing does WXYC hold". So an unverifiable label is not weak evidence — it is the wrong kind of evidence.

The cost asymmetry settles it. A **missing** label makes `label_match` abstain, the status quo for 100% of cards today, costing nothing. A **wrong** label promotes the wrong pressing station-wide and is indistinguishable from a right one downstream. `resolve.ts` uses that same reasoning to abstain on conflicting labels; applying it to conflicts but not to provenance was the inconsistency an earlier revision of this job shipped.

If the trade is revisited, the DJ-typed route belongs in a **separate, separately-reviewed mapping with its own confidence column** — not merged into this one, where it would be indistinguishable from an acquisition record.

## Running it

```bash
npx tsx jobs/library-label-backfill/job.ts --dump /path/to/wxycmusic-backup-<date>.sql.gz
```

| flag                     | meaning                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dump <path>`          | **required.** The `mysqldump` `.sql.gz` to read.                                                                                                               |
| `--out <dir>`            | Output directory (default: this directory).                                                                                                                    |
| `--clone <path>`         | A `pg_dump --data-only` clone of `wxyc_schema.library`, used only to report how many mapped cards still have a live row. Defaults to `dev_env/seed-clone.sql`. |
| `--skip-excluded-census` | Skip the `FLOWSHEET_ENTRY_PROD` pass that measures the excluded DJ-typed population.                                                                           |

The mapping itself reads only `ROTATION_RELEASE` and `COMPANY` and takes seconds. The default run also scans the 2.6M-row flowsheet — **purely to measure the population this job excludes**, which the report has to state — and that pass is what makes a full run take ~4 minutes. `--skip-excluded-census` drops it.

## Which artefact to use

The authoritative final capture named by BS#2669 is

```
s3://wxyc-archive/legacy/tubafrenzy/2026-09-16/wxycmusic-backup-2026-09-16-135233.sql.gz
```

sha256 `533bb48da9dc89aa354849a6eebe8ab348da67e0ffc9e5a3941607925d46bad1`, reachable with the `wxyc-api` AWS profile. **Verify by re-hashing a streamed copy** — the stored `ChecksumSHA256` is a 17-part multipart composite and is not comparable.

The committed artefacts were generated from a **later re-dump** of the same database (frozen since 2026-09-16 13:09 PDT), sha256 `aa289593f7652e77c2e83e5ce81a70c44ebe9ca1a04cd0da64a89e835fbfb95e`, because the S3 object is unreachable (expired SSO session). `REPORT.md` says so in its own provenance block. **Regenerate from the S3 object and diff before BS#2672 applies anything to production.**

## Output

| file                  | contents                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `label-mapping.tsv`   | The mapping. `legacy_release_id` → `label_name` + `company_id`, plus every duplicate `COMPANY` id behind that name and the rotation-row count. |
| `label-conflicts.tsv` | Cards whose re-adds name two or more different labels. **No value** — see above.                                                               |
| `REPORT.md`           | Coverage, the `COMPANY` duplication finding, `ALTERNATE_LABEL_NAME` handling, the excluded DJ-typed population, and all 87 conflicts in full.  |

TSV rather than CSV so no field needs quoting: a `COMPANY.NAME` cannot contain a tab, and the conflicts file's JSON column nests cleanly without doubling quotes. Keys are `legacy_release_id` (tubafrenzy `LIBRARY_RELEASE_ID`), never `library.id` — resolving to `library.id` needs production and belongs to BS#2672.

## `ALTERNATE_LABEL_NAME`

Ignored. Of the 17,795 card-linked rotation rows, 13 carry one, and **none** of those lack a resolvable `COMPANY_ID` — so using it as a fallback would add **0 cards**. It is free text rather than an identity, so it is not worth reintroducing text handling for zero coverage. The job recomputes that count on every run, so if a future capture changes it the report will say so.

## The parser

`dump.ts` hand-rolls the `mysqldump` VALUES tokenizer rather than using `wxyc_etl.parser.iter_table_rows`, the Rust parser the sibling ETL repos use. That binding is Python-only, is not installed here, and Backend-Service has no Python in CI at all — adding a PyO3 wheel and a Python test lane for one read-only analysis costs more than it buys.

The two mitigations for "hand-rolled is fragile":

1. `parseValuesClause` is a pure function and every escaping rule it claims is enumerated in `tests/unit/jobs/library-label-backfill/dump.test.ts` — backslash escapes, doubled quotes, `\%`/`\_` preservation, structural characters inside strings, and the malformed inputs it must **throw** on rather than return a short row for.
2. The run reproduces BS#2669's independently measured figures exactly: 21,641 `ROTATION_RELEASE` rows, 17,795 linked, 17,636 with a resolvable company, 7,246 `COMPANY` rows, 17,175 cards covered, 17,088 resolved. A parser that mis-tokenized would not land on all six.

## Testing

```bash
npx jest --config jest.unit.config.ts tests/unit/jobs/library-label-backfill
```

`dump.ts` and `resolve.ts` are covered there and are type-checked in CI as a side effect (ts-jest compiles them through `tests/tsconfig.json`). `job.ts` — argument parsing, the census pass and file writing — is not imported by any test; the repo's root `typecheck` skips `jobs/**` by convention, so run `npm run typecheck --workspace=jobs/library-label-backfill` after editing it.
