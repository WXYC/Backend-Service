# Runbook: flowsheet-metadata-backfill cron LML re-validation (BS#1064)

Once LML's `prod` branch carries the per-item cascade cap (LML#370) and the
queue-cancellation propagation (LML#372), the BS-side cron's ~21% LML
timeout rate should drop. This runbook is the cheap, decisive triage to
confirm that — and the fallback if it doesn't.

## Premise

The 2026-05-25 06:00 UTC firing showed:

- 21 batches in ~10h45m
- 21.1% `lml_error` (all `LML request timed out` — client-side 8s budget firing)
- Sampled inter-row spacing ≈ 8s (the budget IS the cutoff, not server slowness)

Two hypotheses (see BS#1064 body):

- **A**: per-call 8s budget is too tight for cold-tail rows post-LML #337/#359.
- **B**: BS-side stack degradation (undici pool poisoning, Sentry transport backlog, FD leak) — LML responds fast on direct curl but slow from inside the cron container.

The LML closures don't make A vs B distinguishable in isolation. This runbook
runs the cheap decision tree.

## Prerequisites

- LML's `prod` branch has both LML#370 and LML#372 deployed. Verify via the
  LML repo's deploy log; both were closed 2026-05-25 but the LML `prod`
  deploy is a separate event. Confirm with `gh issue view <id> --repo
WXYC/library-metadata-lookup` and look for the "deployed to prod"
  comment, OR query LML's `/version` endpoint.
- BS EC2 host healthy (`gh issue list --label status:investigating` shows
  nothing relevant, host metrics nominal).
- No active show on air (the cron's cooperative pause via #735 already
  defers when DJs are active; this just avoids an immediate restart loop
  if a DJ joins mid-run).

## Step 1 — Baseline run with current config

Do not change the cron config. Trigger one out-of-band firing so the
post-LML-deploy state is sampled before doing anything else.

```sh
# SSH to wxyc-ec2:
ssh wxyc-ec2

# Run the cron once interactively. The exact docker invocation matches
# what deploy-base.yml registers; copy it from the systemd unit at
# /etc/systemd/system/flowsheet-metadata-backfill-cron.service or check
# `docker compose --project-name wxyc-backend ps` for the configured
# container name.
docker compose --project-name wxyc-backend run --rm flowsheet-metadata-backfill 2>&1 | tee /tmp/bs-1064-baseline.log
```

(Or trigger via the existing systemd timer's `OnCalendar` ad-hoc:
`sudo systemctl start flowsheet-metadata-backfill-cron.service` and follow
with `journalctl -u flowsheet-metadata-backfill-cron.service -f`.)

Wait for the run to either finish or stabilize at a representative state
(~5-10 batches). Don't let it run the full ~10h45m unless the error rate
is dropping fast — abort earlier if 5 batches in a row show <5% error.

## Step 2 — Compute the error rate from the log

The cron emits per-batch `batch_done` records. Grep them out and average:

```sh
grep '"step":"batch_done"' /tmp/bs-1064-baseline.log \
  | jq -s '
    {
      batches: length,
      scanned: ([.[].scanned] | add),
      enriched_match: ([.[].enriched_match] | add),
      enriched_no_match: ([.[].enriched_no_match] | add),
      lml_error: ([.[].lml_error] | add),
      pct_error: (([.[].lml_error] | add) * 100 / ([.[].scanned] | add))
    }'
```

## Step 3 — Decide

| `pct_error` | Verdict                                                                                                        | Action                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| < 5%        | **Hypothesis A confirmed; LML fixes closed the gap.**                                                          | Comment on BS#1064 with the numbers; close as fixed. No config change needed.                                                             |
| 5–15%       | Marginal. Could be A (a slightly too-tight budget still chops the tail) or B (intermittent stack degradation). | Bump `BACKFILL_LML_PER_CALL_TIMEOUT_MS` to `20000` in EC2 `.env` (Step 4) and re-run. If error rate drops to <5%: A. If it stays high: B. |
| > 15%       | **Hypothesis B; the BS-side stack is the bottleneck.**                                                         | Don't bump the budget — that just hides the symptom. Proceed to Step 5 (deeper investigation).                                            |

## Step 4 — Budget bump (only if Step 3 says "Marginal")

```sh
# Edit EC2 .env in place. The value lives next to the other
# BACKFILL_LML_* knobs.
ssh wxyc-ec2
sudo sed -i.bak 's/^BACKFILL_LML_PER_CALL_TIMEOUT_MS=.*/BACKFILL_LML_PER_CALL_TIMEOUT_MS=20000/' /opt/wxyc/.env

# Rebuild the cron container so the new env is in effect:
docker compose --project-name wxyc-backend up -d --build flowsheet-metadata-backfill
```

Re-run Step 1 and recompute Step 2. If the error rate drops below 5%,
commit the .env change permanently (don't leave it as a manual sed) and
close BS#1064 with a comment naming the value that worked.

## Step 5 — Hypothesis B investigation (only if Step 3 says "> 15%")

Do not chase by sleeping/restarting. Capture evidence first.

5a. **Direct LML latency probe**. Re-run Jake's earlier 5-row probe against
LML directly, comparing wall-clock to the cron's same-row latency for the
same `flowsheet_id`s:

```sh
# From wxyc-ec2 (so the network path matches the cron's path):
for id in 58060 58078 58095 58097 58141; do
  echo "--- flowsheet_id=$id"
  time curl -s -X POST "${LIBRARY_METADATA_URL}/api/v1/lookup" \
    -H "Authorization: Bearer ${LML_API_KEY}" \
    -H 'Content-Type: application/json' \
    -d "$(scripts/build-lookup-payload.sh "$id")" \
    -o /dev/null
done
```

If LML responds <2s for the same rows that timed out in the cron, B is
confirmed.

5b. **`/proc` snapshot of a stuck call**. While the cron is mid-call (run
it interactively in Step 1 and grab the PID), capture:

```sh
ssh wxyc-ec2 -- 'CRON_PID=$(pgrep -f flowsheet-metadata-backfill | head -1); \
  cat /proc/$CRON_PID/status; \
  ls /proc/$CRON_PID/fd | wc -l; \
  ls -la /proc/$CRON_PID/fd | head -50'
```

Look for FD count growing over the run (socket leak) or `State: D` (uninterruptible sleep on a syscall).

5c. **Strip Sentry**. Build a debug container with `@sentry/node` excluded
(comment out the `Sentry.init(...)` call in `apps/backend/instrument.ts`'s
equivalent for the cron entrypoint) and re-run Step 1. If the timeout rate
drops without Sentry, attach the finding to BS#1064 — the transport
backlog hypothesis becomes credible and gets its own ticket.

## Side effects to watch

- The cron's cooperative pause via #735 still applies. If a DJ joins
  mid-run, the cron defers. That's fine — re-trigger after the show ends.
- Don't lower `BACKFILL_LML_PER_CALL_TIMEOUT_MS` below the value that
  worked. Tighter budgets free LML's slots faster but also push borderline
  rows into the no-match bucket; that's a different tradeoff and a
  different ticket.

## Closeout

Post a comment on BS#1064 with:

- Final value of `pct_error`
- Verdict (A / Marginal-fixed-by-bump / B)
- Any `.env` changes applied + the host they're on
- If B: link to the new investigation ticket
