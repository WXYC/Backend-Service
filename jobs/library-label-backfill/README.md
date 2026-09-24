# library-label-backfill

Resolves a canonical record label per library card from the archived tubafrenzy flowsheet ([BS#2669](https://github.com/WXYC/Backend-Service/issues/2669)).

**This job writes nothing.** It opens no database connection at all — not even a read-only one. It reads a gzipped `mysqldump` off local disk and emits three TSVs plus `REPORT.md` into this directory. Applying the mapping to `wxyc_schema.library` is [BS#2672](https://github.com/WXYC/Backend-Service/issues/2672), deliberately separate because that write touches ~37k production catalog rows.

## Why it exists

`wxyc_schema.library.label` and `.label_id` have been 100% NULL since the schema was written — 0 of 64,193 rows. That is not an ETL bug: tubafrenzy's `LIBRARY_RELEASE` has no label column, so `jobs/library-etl` has nothing to map from. But the station _did_ record labels, on every play, in the flowsheet's `LABEL_NAME`. Nothing ever backfilled the catalog from there.

The gap is load-bearing in three places: `library-search.service.ts`'s `buildAllFieldMatch` ILIKEs `label` on every query and the disjunct matches nothing; [BS#871](https://github.com/WXYC/Backend-Service/issues/871)'s `search_doc` weight and trigram index would ship inert; and `discogs-etl`'s top-priority `label_match` dedup key is rebuilt each run from an unresolved _set_ of flowsheet labels, so one mistyped entry can promote the wrong pressing.

## Running it

```bash
npx tsx jobs/library-label-backfill/job.ts --dump /path/to/wxycmusic-backup-<date>.sql.gz
```

| flag             | meaning                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dump <path>`  | **required.** The `mysqldump` `.sql.gz` to read.                                                                                                               |
| `--out <dir>`    | Output directory (default: this directory).                                                                                                                    |
| `--clone <path>` | A `pg_dump --data-only` clone of `wxyc_schema.library`, used only to report how many mapped cards still have a live row. Defaults to `dev_env/seed-clone.sql`. |

Takes ~4 minutes over the 142 MB capture. It prints the input's SHA-256 and embeds it in the report, because the provenance of the capture is the one fact a reviewer cannot re-derive from the output.

## Which artefact to use

The authoritative final capture named by BS#2669 is

```
s3://wxyc-archive/legacy/tubafrenzy/2026-09-16/wxycmusic-backup-2026-09-16-135233.sql.gz
```

sha256 `533bb48da9dc89aa354849a6eebe8ab348da67e0ffc9e5a3941607925d46bad1`, reachable with the `wxyc-api` AWS profile. **Verify by re-hashing a streamed copy** — the stored `ChecksumSHA256` is a 17-part multipart composite and is not comparable.

The committed artefacts were generated from a **later re-dump** of the same database (frozen since 2026-09-16 13:09 PDT), sha256 `aa289593f7652e77c2e83e5ce81a70c44ebe9ca1a04cd0da64a89e835fbfb95e`, because the S3 object was unreachable at the time (expired SSO session). `REPORT.md` says so in its own provenance block. **Regenerate from the S3 object and diff before BS#2672 applies anything to production.**

## Output

| file                       | contents                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label-mapping.tsv`        | The mapping. `legacy_release_id` → resolved label, with every raw spelling and its play count in a JSON column so a reviewer can spot-check without a second file. |
| `label-conflicts.tsv`      | Cards whose plays carry two or more genuinely distinct labels. **No candidate value** — see below.                                                                 |
| `resolved-label-names.tsv` | Distinct resolved labels and how many cards each covers. This is what BS#2672 diffs against `wxyc_schema.labels`.                                                  |
| `REPORT.md`                | Coverage, the cross-check against BS#2669's quoted figures, the normalization rule, both variant-count distributions, and a verbatim conflict sample.              |

TSV rather than CSV so no field needs quoting: a label cannot contain a tab, and the JSON columns nest cleanly without doubling quotes. Keys are `legacy_release_id` (tubafrenzy `LIBRARY_RELEASE_ID`), never `library.id` — resolving to `library.id` needs production and belongs to BS#2672.

## Why conflicts carry no candidate

A card resolves only when **every** play agrees after normalization. Where they disagree the card is emitted as a conflict with no value, even when one spelling has 999 plays and the other has 1.

That asymmetry is deliberate. A wrong label here is worse than a missing one: `library.label` feeds discogs-etl's `label_match` dedup ranking key, which decides which pressing the whole station sees for a release. A modal vote across disagreeing labels would manufacture confidence the data does not contain — and a reissue legitimately carries different labels across plays, so disagreement is not always error. The modal vote settles _spelling_, never _substance_: it picks the display form inside an already-unanimous group and abstains everywhere else.

## The parser

`dump.ts` hand-rolls the `mysqldump` VALUES tokenizer rather than using `wxyc_etl.parser.iter_table_rows`, the Rust parser the sibling ETL repos use. That binding is Python-only, is not installed here, and Backend-Service has no Python in CI at all — adding a PyO3 wheel and a Python test lane for one read-only analysis costs more than it buys. (If a second dump-reading job ever lands here, revisit that trade.)

The two mitigations for "hand-rolled is fragile":

1. `parseValuesClause` is a pure function and every escaping rule it claims is enumerated in `tests/unit/jobs/library-label-backfill/dump.test.ts` — backslash escapes, doubled quotes, `\%`/`\_` preservation, structural characters inside strings, and the malformed inputs it must **throw** on rather than return a short row for.
2. The run cross-checks its totals against BS#2669's independently measured figures. Four counted quantities — 2,643,453 dump rows, 1,081,412 linked plays, 1,009,419 labelled plays, 37,741 cards — reproduce exactly. A parser that mis-tokenized would not land on all four.

## Testing

```bash
npx jest --config jest.unit.config.ts tests/unit/jobs/library-label-backfill
```

`normalize.ts`, `dump.ts` and `resolve.ts` are covered there and are type-checked in CI as a side effect (ts-jest compiles them through `tests/tsconfig.json`). `job.ts` — argument parsing and file writing — is not imported by any test; the repo's root `typecheck` skips `jobs/**` by convention, so run `npm run typecheck --workspace=jobs/library-label-backfill` after editing it.
