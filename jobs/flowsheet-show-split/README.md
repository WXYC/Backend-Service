# flowsheet-show-split

One-shot repair for a show that accumulated several DJs' sets, splitting it into one show per DJ and promoting the `dj_join` / `dj_leave` boundary markers to `show_start` / `show_end`.

The full rationale, the boundary rules, and why the tubafrenzy half is mandatory are in the docblock at the top of `job.ts`. The boundary rules themselves are in `segment.ts` and are unit-tested against production show 1951224's real marker sequence (`tests/unit/jobs/flowsheet-show-split/segment.test.ts`).

## When you need this

A show whose `end_time` is NULL long past its slot, with `dj_join` markers from DJs who each thought they were starting their own show. `GET /flowsheet/open-shows` lists the candidates; the on-air name reading as a DJ who left hours ago is the usual first symptom.

The underlying defect is that `POST /flowsheet/join` routes on `current_show?.end_time !== null`, so a go-live against a show nobody closed becomes a guest join (WXYC/dj-site#1035). This job repairs the data; it does not stop it recurring.

## Options

| Flag                        | Default    | Meaning                                                                                                                |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--show-id=<n>`             | _required_ | The show to split. No default, so it cannot run against the wrong one by accident.                                     |
| `--dry-run`                 | off        | Log the full plan and exit without writing.                                                                            |
| `--min-segment-seconds=<n>` | `120`      | Joins that close faster are treated as blind-toggle noise and left in place as co-host markers, not promoted to shows. |
| `--skip-mirror`             | off        | Skip the tubafrenzy `SIGNOFF_TIME` write. See the warning below before using it.                                       |
| `--repair-marker-order`     | off        | Standalone mode: re-mint `--show-id`'s `show_start` so it stays the newest marker by id. See below.                    |

## `--repair-marker-order`

The iOS listener app derives its on-air banner from `showMarkers.max(by: { $0.id })` and renders nothing when that marker is a `show_end`. It orders by **id**, not `add_time` — so a `show_end` this job mints for an earlier segment carries a correct `add_time` but a brand-new serial id that outranks the live show's `show_start`, and the app reads "AUTO DJ" while a DJ is on the air.

`applySplit` already handles this inline: when the final segment is still open it re-mints that show's `show_start` last, after every other insert has taken its id. This standalone mode exists only for a split that already ran before that guard existed.

It requires `--show-id` and refuses to guess. An earlier cut took "the newest open show" instead, which is right only when run immediately after the split and quietly wrong afterwards — run it hours later and the split's live tail has closed, so it no-ops against an unrelated show and still logs a success. That is exactly what happened on 2026-08-28: it reported `repair-complete` for show 1951231 while 1951228 was the one it was aimed at. No harm done, because by then the next DJ's `show_start` had taken a higher id than the minted marker and the banner had already self-corrected — but a repair tool that can look like it worked when it did not is worse than one that refuses.

Pass the id of the **open** show whose `show_start` must stay newest — after a split that is the last new show the run created, not the original `--show-id`. A closed show is a logged no-op: the invariant only bites while something is genuinely live, since a blank banner is the correct rendering when nothing is on the air.

## Run procedure

Best run when nobody is on the air — splitting a live show re-points the open segment onto a new `shows` row mid-broadcast.

Manual Build & Deploy with `target=flowsheet-show-split`, then on EC2:

```
docker run --rm --env-file .env <image> --show-id=1951224 --dry-run 2>&1 | tee log-dry
docker run --rm --env-file .env <image> --show-id=1951224 2>&1 | tee log-apply
```

Read the `plan` line from the dry run before applying. Check that every segment shows `resolved: true` — an unresolved segment means the marker's `dj_name` didn't match any `auth_user.dj_name` among the show's `show_djs`, and that show will be created with a NULL `primary_dj_id`, reintroducing the same legacy-name fallback the repair exists to remove.

Also check `ignored_blips`. Anything listed there stays as co-host markers inside whichever segment contains it; if a real set shows up in that list, raise `--min-segment-seconds` is the wrong lever — lower it, or the set was genuinely shorter than the threshold.

## Not re-runnable

A second pass finds its own promoted `show_start` markers where the `dj_join` boundaries used to be and splits nothing. This is why the whole apply is one transaction and why the Dockerfile does not carry the sibling one-shots' `DB_SYNCHRONOUS_COMMIT=off`.

## Do not `--skip-mirror` on a mirrored show

`jobs/flowsheet-etl`'s incremental upsert sets `end_time: excluded.end_time` whenever it differs from what tubafrenzy holds, and `epochMsToDate(0)` is `null`. So while tubafrenzy still has `SIGNOFF_TIME = 0`, an ETL pass reverts the repaired `end_time` to NULL and the show reopens. `flowsheet-etl` is not in the EC2 crontab today, so nothing does this on a schedule — but a manual run would, silently.

Stamping `SIGNOFF_TIME` to the same instant makes the ETL upsert a no-op over the repair rather than a revert.

The job does **not** re-point tubafrenzy's `FLOWSHEET_ENTRY_PROD.RADIO_SHOW_ID`. `GLOBAL_ORDER_ID = RADIO_SHOW_ID * 1000 + SEQUENCE_WITHIN_SHOW` drives render order there, so moving entries between shows means recomputing both columns for every row and restarting Tomcat to clear `FlowsheetEntryCache`. tubafrenzy's copy stays one long show; Backend-Service — what the iOS app, dj-site and the archive read — carries the corrected shape.
