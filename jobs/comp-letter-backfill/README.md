# comp-letter-backfill

One-shot backfill for [BS#2834](https://github.com/WXYC/Backend-Service/issues/2834) (epic [BS#2828](https://github.com/WXYC/Backend-Service/issues/2828)). It sets `genre_artist_crossreference.code_comp_letter` on the 52 Rock/Soundtracks compilation slots: 26 `Various Artists - Rock - <L>` sections and 26 `Soundtracks - <L>` sections.

## Why

Rock and Soundtracks compilations are filed in lettered sections, and release numbers restart in each section, so `Rock V/A-76` names a different record on every one of the 26 Rock shelves. tubafrenzy kept the letter in the call code (`Z-L`). Backend's catalog import collapsed every `Z-<letter>` code to the literal `V/A`, which left the letter only in the slot's artist name. [BS#2833](https://github.com/WXYC/Backend-Service/issues/2833) added the column and [BS#2835](https://github.com/WXYC/Backend-Service/issues/2835) serves it. This job fills it in, which is what lets dj-site, LML and the catalog export render `Rock V/A L-76`.

## What it does

1. **Reads the candidate set**: `V/A` slots with `artist_genre_code = 0` in the Rock or Soundtracks genre whose trimmed name ends ` - <letter>`. The letter is that trailing character, upper-cased. This is the only place the job reads a name.
2. **Reports**, in both modes: every candidate (genre, letter, artist ID, name, current value) and the Rock/Soundtracks `V/A` slots the predicate leaves out (expected: one, the catch-all `Various Artists` filing under Soundtracks).
3. **Gates.** Nothing is written unless there are exactly 52 candidates, exactly 26 per genre, and the letters in each genre are exactly A–Z with no gaps or repeats. Each candidate's name must be exactly its genre's form plus its letter (`Various Artists - Rock - L` under Rock, `Soundtracks - L` under Soundtracks, compared case- and whitespace-insensitively), so a Soundtracks section filed under Rock can't stand in for a renamed Rock one. Every candidate must still be NULL, and no row outside the 52 may carry a letter. The completeness check is what makes reading a name safe: a section renamed since the cutover leaves a letter missing, and the run aborts instead of leaving that section quietly unlettered. A dry run and `--apply` evaluate the same checks, so a dry run that passes is one the apply will pass on the same data.
4. **Writes** (`--apply` only). Steps 1–3 and the write all run in one transaction that locks the candidate slots and their artists (`FOR UPDATE`), so a rename racing the run can't slip between the gate and the write. The write is one bound `UPDATE … WHERE artist_id = $a AND genre_id = $g AND code_comp_letter IS NULL` per slot, each required to touch exactly one row. Before commit, the table must hold exactly 52 non-NULL letters in total, or the transaction rolls back. After the commit, the job logs `COMMITTED` and runs `ANALYZE` (`docs/bulk-update-playbook.md`). The BS#2833 constraints (shape, slot, per-genre uniqueness) are the last line of defense.

A run after a successful apply finds every slot already holding the letter its name gives, and nothing else lettered. It reports `already applied` and writes nothing. Any other pre-set value fails the gate.

### Not yet: the advisory cross-check

BS#2834 also asks for an advisory comparison against the frozen tubafrenzy dump (each slot's letter vs the `Z-<letter>` code its releases had there). That lands as a stacked follow-up that adds `--dump`. The production dry run waits for it.

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

# 3. Dry run. Writes nothing.
npx tsx jobs/comp-letter-backfill/job.ts 2>&1 | tee comp-letter-dry.log

# 4. After review and approval:
npx tsx jobs/comp-letter-backfill/job.ts --apply 2>&1 | tee comp-letter-apply.log
```

Exit code 0 means the dry run passed the gate, the write landed, or the job was already applied. Exit code 1 means the gate failed or the run errored. **Read the log before concluding nothing was written:** if it contains `COMMITTED`, the 52 letters landed and the error came afterwards (from `ANALYZE` or pool teardown). A re-run then reports `already applied`; run `ANALYZE wxyc_schema.genre_artist_crossreference` by hand. Without `COMMITTED`, nothing was written. `WXYC_SCHEMA_NAME` defaults to `wxyc_schema`.

After `--apply`, run BS#2834's checks: 26 letters A–Z per genre, and **only** the read-only `vaCouplingOffenders` `SELECT` from `tests/integration/genre-artist-crossreference-code-comp-letter.spec.js`, which must return no rows. Never run that integration spec itself against production: it inserts and deletes probe rows.

There is deliberately no `Dockerfile.comp-letter-backfill`. The run is one manual invocation, and the cross-check will read a dump from the operator's disk, so an EC2 image would add a dump upload and gain nothing.

## Rehearsal (2026-10-06)

Against a throwaway Postgres with every migration applied and `dev_env/seed-clone.sql` (the prod-clone fixture) loaded:

- dry run: 52 candidates, 1 unlettered slot (artist 1087 `Various Artists`, Soundtracks), gate passed, exit 0
- `--apply`: 52 letters, A–Z in each genre; the coupling query returned no rows
- second `--apply`: `already applied`, nothing written

## Testing

```sh
npx jest --config jest.unit.config.ts tests/unit/jobs/comp-letter-backfill   # the gate
npm run build --workspace=@wxyc/comp-letter-backfill                          # emits dist/backfill.cjs for the spec
# tests/integration/comp-letter-backfill.spec.js runs in the integration tier, isolated in its own scratch schema
npm run typecheck --workspace=jobs/comp-letter-backfill                       # root typecheck skips jobs/**
```
