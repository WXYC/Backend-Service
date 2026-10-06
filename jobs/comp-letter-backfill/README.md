# comp-letter-backfill

One-shot backfill for [BS#2834](https://github.com/WXYC/Backend-Service/issues/2834) (epic [BS#2828](https://github.com/WXYC/Backend-Service/issues/2828)). It sets `genre_artist_crossreference.code_comp_letter` on the 52 Rock/Soundtracks compilation slots: 26 `Various Artists - Rock - <L>` sections and 26 `Soundtracks - <L>` sections.

## Why

Rock and Soundtracks compilations are filed in lettered sections, and release numbers restart in each section, so `Rock V/A-76` names a different record on every one of the 26 Rock shelves. tubafrenzy kept the letter in the call code (`Z-L`). Backend's catalog import collapsed every `Z-<letter>` code to the literal `V/A`, which left the letter only in the slot's artist name. [BS#2833](https://github.com/WXYC/Backend-Service/issues/2833) added the column and [BS#2835](https://github.com/WXYC/Backend-Service/issues/2835) serves it. This job fills it in, which is what lets dj-site, LML and the catalog export render `Rock V/A L-76`.

## What it does

1. **Reads the candidate set**: `V/A` slots with `artist_genre_code = 0` in the Rock or Soundtracks genre whose trimmed name ends ` - <letter>`. The letter is that trailing character, upper-cased. This is the only place the job reads a name.
2. **Reports**, in both modes: every candidate (genre, letter, artist ID, name, current value), the Rock/Soundtracks `V/A` slots the predicate leaves out (expected: one, the catch-all `Various Artists` filing under Soundtracks, with a note that it leaves the by-code chooser once its siblings are lettered), and, with `--dump`, the advisory cross-check.
3. **Gates.** Nothing is written unless there are exactly 52 candidates, exactly 26 per genre, and the letters in each genre are exactly A–Z with no gaps or repeats. Each candidate's name must be exactly its genre's form plus its letter (`Various Artists - Rock - L` under Rock, `Soundtracks - L` under Soundtracks, compared case- and whitespace-insensitively), so a Soundtracks section filed under Rock can't stand in for a renamed Rock one. Every candidate must still be NULL, and no row outside the 52 may carry a letter. The completeness check is what makes reading a name safe: a section renamed since the cutover leaves a letter missing, and the run aborts instead of leaving that section quietly unlettered. A dry run and `--apply` evaluate the same checks, so a dry run that passes is one the apply will pass on the same data.
4. **Writes** (`--apply` only). Steps 1–3 and the write all run in one transaction that locks the candidate slots and their artists (`FOR UPDATE`), so a rename racing the run can't slip between the gate and the write. The write is one bound `UPDATE … WHERE artist_id = $a AND genre_id = $g AND code_comp_letter IS NULL` per slot, each required to touch exactly one row. Before commit, the table must hold exactly 52 non-NULL letters in total, or the transaction rolls back. After the commit, the job logs `COMMITTED` and runs `ANALYZE` (`docs/bulk-update-playbook.md`). The BS#2833 constraints (shape, slot, per-genre uniqueness) are the last line of defense.

A run after a successful apply finds every slot already holding the letter its name gives, and nothing else lettered. It reports `already applied` and writes nothing. Any other pre-set value fails the gate.

### The advisory cross-check

With `--dump`, the job reads `LIBRARY_CODE` and `LIBRARY_RELEASE` from the frozen tubafrenzy dump and compares every release under the 52 slots (joined through `library.legacy_release_id`) with how tubafrenzy filed it. Each release lands in exactly one bucket:

- **agree:** the dump filed it under `Z-<the slot's letter>` in the slot's genre;
- **disagree:** another letter, the other genre, a named artist's code, or a NULL/missing code. Each one is listed;
- **not in dump:** a tubafrenzy-era id the dump has no row for;
- **filed since the cutover:** a Backend-minted id (≥ 1,000,000), with nothing to compare against.

Disagreements never block the write, because a release legitimately re-filed to another section after the cutover disagrees with the dump. A dump with no rows in either table aborts the run, so a wrong file can't make every release read as "not in dump" while the run passes. The dump is read with `jobs/library-label-backfill/dump.ts`'s tested reader; that README covers where the capture lives and how to verify it.

## Running it

**The production dry run and `--apply` need Jake's explicit OK** (BS#2834). Paste the dry-run output into the issue before applying.

The job runs from a workstation through an SSH tunnel to RDS. That departs from BS#2834's "wxyc-ec2 host psql" wording on purpose, so the cross-check's dump can stay on local disk, and was approved on 2026-10-06. Keep the production password out of shell history (read it into the variable rather than typing it) and out of the logs below.

```sh
# 0. Build the workspace package the job imports (its exports point at dist/).
npm run build --workspace=@wxyc/database

# 1. Tunnel through the EC2 host (the RDS security group admits it). The RDS endpoint is DB_HOST in the host's ~/.env.
ssh -f -N -L 5455:<rds-endpoint>:5432 wxyc-ec2

# 2. Production DB_NAME / DB_USERNAME / DB_PASSWORD from the host's ~/.env, copied verbatim
#    (the password contains shell-special characters; never `source` the file).
export DB_HOST=127.0.0.1 DB_PORT=5455 DB_NAME=... DB_USERNAME=...
read -rs DB_PASSWORD && export DB_PASSWORD   # paste at the silent prompt; nothing reaches history

# 3. Dry run, with the cross-check. Writes nothing.
npx tsx jobs/comp-letter-backfill/job.ts --dump /path/to/wxycmusic-backup-2026-09-16-135233.sql.gz 2>&1 | tee comp-letter-dry.log

# 4. After review and approval:
npx tsx jobs/comp-letter-backfill/job.ts --dump /path/to/wxycmusic-backup-2026-09-16-135233.sql.gz --apply 2>&1 | tee comp-letter-apply.log
```

Exit code 0 means the dry run passed the gate, the write landed, or the job was already applied. Exit code 1 means the gate failed or the run errored. **Read the log before concluding nothing was written:** if it contains `COMMITTED`, the 52 letters landed and the error came afterwards (from `ANALYZE` or pool teardown). A re-run then reports `already applied`; run `ANALYZE wxyc_schema.genre_artist_crossreference` by hand. Without `COMMITTED`, nothing was written. `WXYC_SCHEMA_NAME` defaults to `wxyc_schema`.

After `--apply`, run BS#2834's checks: 26 letters A–Z per genre, and **only** the read-only `vaCouplingOffenders` `SELECT` from `tests/integration/genre-artist-crossreference-code-comp-letter.spec.js`, which must return no rows. Never run that integration spec itself against production: it inserts and deletes probe rows.

There is deliberately no `Dockerfile.comp-letter-backfill`. The run is one manual invocation that reads a dump from the operator's disk, so an EC2 image would add a dump upload and gain nothing.

## Rehearsal (2026-10-06)

Against a throwaway Postgres with every migration applied and `dev_env/seed-clone.sql` (the prod-clone fixture) loaded, using the 2026-09-21 re-dump:

- dry run: 52 candidates, 1 unlettered slot (artist 1087 `Various Artists`, Soundtracks), cross-check 3,207 agree, 0 disagree, 0 not in dump, 4 filed since the cutover (64,768 legacy releases read), gate passed, exit 0
- `--apply`: 52 letters, A–Z in each genre; the coupling query returned no rows
- second `--apply`: `already applied`, nothing written

## Testing

```sh
npx jest --config jest.unit.config.ts tests/unit/jobs/comp-letter-backfill   # the gate, the cross-check, the dump mapping, argument parsing
npm run build --workspace=@wxyc/comp-letter-backfill                          # emits dist/backfill.cjs for the spec
# tests/integration/comp-letter-backfill.spec.js runs in the integration tier, isolated in its own scratch schema
npm run typecheck --workspace=jobs/comp-letter-backfill                       # root typecheck skips jobs/**
```
