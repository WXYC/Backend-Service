# Tubafrenzy ground truth for the residual U+FFFD rows, captured pre-turndown

**Captured 2026-09-07 (PT), against `dc1-mysql-01.kattare.com` / `wxycmusic`, read-only, hours before Milestone 1 retirement.** Once tubafrenzy is dark these bytes are unrecoverable — U+FFFD has no inverse, and every value below was previously in the "no canonical identifiable" bucket.

Method: `SELECT HEX(CAST(<col> AS BINARY))` over a `--default-character-set=binary` connection, so the hex is the **raw stored bytes** with no transcoding by the client. All source columns are declared `utf8_unicode_ci`.

## Headline finding: tubafrenzy is clean

```
LIBRARY_CODE.PRESENTATION_NAME    rows containing EF BF BD:  0
LIBRARY_RELEASE.TITLE             rows containing EF BF BD:  0
ROTATION_RELEASE.ARTIST_PRESENTATION_NAME                    0
ROTATION_RELEASE.TITLE                                       0
```

**Zero U+FFFD anywhere upstream.** Every replacement character in Backend-Service was introduced on the Backend side, at ETL read time — not inherited. This retires the "is the upstream corrupt too?" question for the whole `#863` family, and means no upstream write was ever needed.

## Decode-fidelity probe: the current read path is clean

Captured in the same session, and **not repeatable after turndown** — this is the only direct measurement of whether the live ETL read path still corrupts this value.

The production path is `MirrorSQL.makeSqlCommand` (`shared/database/src/legacy/sql.mirror.ts:71-86`): `mysql … --protocol=TCP --default-character-set=utf8 --batch --raw --silent`, whose stdout node-ssh then decodes as UTF-8. Replaying that exact flag set for `LIBRARY_CODE.ID=956` and dumping the raw bytes off the wire:

```
39 35 36 09 c2 b5 2d 5a 69 71 20 5b 6d 75 2d 5a 69 71 5d 0a
9  5  6  \t  µ(c2b5) -  Z  i  q     [  m  u  -  Z  i  q  ]  \n
```

**`c2 b5` — valid UTF-8 on the wire.** Node's lenient decoder produces `µ` correctly, so the current pipeline does **not** corrupt this row. Two consequences:

1. The Backend corruption is definitively **historical** — a past bad decode frozen into `artists` id 656 by `ensureArtist`'s insert-or-lookup (`jobs/library-etl/job.ts:376`), which never updates an existing artist's name.
2. Once Backend holds `µ-Ziq [mu-Ziq]`, a future ETL pass reads the identical string, folds it via `fold_artist_name`, and **matches the corrected row** — so the repair will not spawn a duplicate `artists` row. This was previously an inference from "months of clean runs"; that inference was weak (`buildReleaseQuery` only re-reads on a `TIME_LAST_MODIFIED` bump, so quiet months prove nothing). This probe is direct evidence and supersedes it.

This measures one row on one day. It does not prove the path was never lossy, nor that every other value decodes cleanly — it proves this value decodes cleanly now.

## Validation against the shipped Phase 4 pin

`scripts/audit/bs_replacement_char_phase4.sql` was written from a tubafrenzy pull it could not re-verify at authoring time. Confirmed correct, byte-for-byte:

| Source | Value | Hex |
|---|---|---|
| `LIBRARY_CODE.ID=956` `PRESENTATION_NAME` | `µ-Ziq [mu-Ziq]` | `C2B52D5A6971205B6D752D5A69715D` |
| Phase 4 test pin (`bs-replacement-char-phase4.spec.js:170`) | — | `c2b52d5a6971205b6d752d5a69715d` |

Identical. **U+00B5 MICRO SIGN (`C2 B5`) is confirmed correct**, not U+03BC (`CE BC`).

`LIBRARY_CODE.ID=956.ALPHABETICAL_NAME` = `mu-Ziq` = `6D752D5A6971` — plain ASCII, confirming Phase 4's claim that it is structurally incapable of carrying this corruption class.

## Recovered values — `artists` (deadline-critical, per Phase 4 header)

These two rows were fixed by #863 on `library.artist_name` **only**; the `artists` source of truth was never touched, leaving a standing `0060`-cascade-undo hazard.

| Backend `artists` id | tubafrenzy `LIBRARY_CODE.ID` | Column | Correct value | Hex |
|---|---|---|---|---|
| 22025 | 25293 | `artist_name` | `Beyoncé` | `4265796F6E63C3A9` |
| 22025 | 25293 | `alphabetical_name` | `Beyoncé` | `4265796F6E63C3A9` |
| 23162 | 18646 | `artist_name` | `Damian Nisenson / Jean Félix Mailloux / Pierre Tanguay` | `44616D69616E204E6973656E736F6E202F204A65616E2046C3A96C6978204D61696C6C6F7578202F205069657272652054616E67756179` |
| 23162 | 18646 | `alphabetical_name` | `Nisenson, Damian` (already clean) | `4E6973656E736F6E2C2044616D69616E` |

`C3A9` = U+00E9 é. Note 22025's `alphabetical_name` is corrupt too and has **no** cascade (trigger `0060` fires only on `artist_name`), so it is inert but still what sorts and displays.

## Recovered values — `rotation` (all five, previously "deliberately unrecovered")

Phase 3.5 left these with an empty curated-canonical column because no canonical was identifiable. All five are recoverable from `ROTATION_RELEASE`, which carries the free-form snapshot columns Backend `rotation` mirrors — **not** `LIBRARY_CODE`, which is why earlier catalog-based searches found nothing.

| Backend `rotation` id | tubafrenzy `ROTATION_RELEASE.ID` | Column | Correct value | Hex |
|---|---|---|---|---|
| 10789 | 14408 | `album_title` | `«†»` | `C2ABE280A0C2BB` |
| 13703 | 17322 | `artist_name` | `Accüsed` | `416363C3BC736564` |
| 21149 | 24768 | `artist_name` | `Nídia & Valentina` | `4EC3AD64696120262056616C656E74696E61` |
| 21335 | 24954 | `artist_name` | `Civilistjävel! & Mayssa Jallad` | `436976696C6973746AC3A476656C212026204D6179737361204A616C6C6164` |
| 16683 | 20302 | `album_title` | `Amare Touré 1973-1980` | `416D61726520546F7572C3A920313937332D31393830` |
| 16683 | 20302 | `artist_name` | `Amare Touré` | `416D61726520546F7572C3A9` |

`«†»` is `«` U+00AB + `†` U+2020 + `»` U+00BB — three non-ASCII characters, which is exactly the "album_title mangled to 3 replacement chars" the Phase 4 header recorded for Justice. `C3BC` = ü, `C3AD` = í, `C3A4` = ä, `C3A9` = é.

## Two judgement calls this surfaces

**1. Phase 2's curated fix for rotation 16683 appears to be wrong.** The Phase 4 header records that Phase 2 "already fixed" its `artist_name` to `Amara Toure` (ASCII, "Amar**a**"). Tubafrenzy holds `Amare Touré` — different vowel *and* an accent. Since the BS#2114 acceptance criterion is **byte-exact** parity against tubafrenzy, the parity harness should be flagging this row today. Repairing it means overwriting a previously-curated value, which is a deliberate decision, not a mechanical substitution.

**2. Tubafrenzy's own spelling is internally inconsistent for this artist.** `LIBRARY_CODE.ID=23741` spells the catalog artist `Amara Toure` (plain ASCII), while `ROTATION_RELEASE.ID=20302` spells the rotation snapshot `Amare Touré`. The real artist is Amara Touré. Byte-exact parity says use `Amare Touré` for the `rotation` row and `Amara Toure` for the catalog row — i.e. faithfully reproduce upstream's inconsistency. Deviating from that is a catalog-data decision for the Music Director, and would show up as a parity mismatch.

## Provenance / caveats

- The tubafrenzy ids above are matched to Backend ids **by name**, not verified against prod Postgres (no Backend DB access from this capture). The `artists` mappings are high-confidence (unique name matches); the `rotation` mappings should be confirmed against `wxyc_schema.rotation` before any UPDATE is scoped by Backend id.
- No writes were issued to tubafrenzy. `SELECT` and `SHOW` only.
- Raw query output is not committed; the hex above is the durable artifact.
