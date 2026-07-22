"""Weekly recurring rotation release-id pollution check (BS#1522).

Scheduled wrapper around ``pollution_engine.py`` (the #1517/#1520/#1523 auditor,
imported literally — never copied — so manual and scheduled runs can never
disagree on scoring). Two detections per run:

1. **Mismatch scoring** (the #1517 audit): fetch every active rotation row whose
   ``discogs_release_id_source`` is in ``DEFAULT_SOURCES``, score the stored
   release's Discogs title against the row's reference title (rotation free-text,
   else the catalog row via ``album_id -> library``), and emit one Sentry
   ``warning`` event per ``mismatch`` row (album score < 60), fingerprinted
   ``[JOB_NAME, "mismatch", <rotation_id>]``. Per the 2026-07-05 calibration the
   60-79 ``suspect`` band is 100% false-positive and never alerts. A stable
   unremediated row regroups into its existing Sentry issue on later runs (no
   new-issue noise); a remediated row stops firing and auto-resolves; only a
   genuinely new bad write opens a fresh issue.
2. **Provenance anomaly** (#1521 retirement invariant): the bypass-LML rescue
   writer is retired, so any rotation row (active OR killed) stamped
   ``discogs_direct_backfill`` that is not in the frozen ``PROVENANCE_BASELINE``
   is a writer regression. One event per new id, fingerprinted
   ``[JOB_NAME, "provenance", <rotation_id>]``. SQL-only; no LML calls. The
   baseline is a superset allowance — ids that leave the stamped set (future
   remediation) never re-appear in the query, so shrinkage needs no baseline
   edit. See the README for the update procedure and the "superset is safe,
   subset false-alerts" rule.

Read-only: never issues UPDATE/DELETE. Remediation stays manual per the #1517
recipe (see README). Cooperative pause (BS#735): before each row's LML call the
job probes ``flowsheet`` for live DJ activity and sleeps while a DJ is actively
adding tracks. LML pacing per BS#995: sequential, default 20/min, per-call
timeout — the engine's ``LmlReleaseClient`` enforces it.

Alerting is ``sentry_sdk.capture_message`` events (not span attributes), so the
BS-cron ``SENTRY_TRACES_SAMPLE_RATE=0`` default is irrelevant here — no tracing
configuration is needed for the alerts to fire.

Required env (job aborts at init if missing): ``DB_HOST``/``DB_PORT``/
``DB_USERNAME``/``DB_PASSWORD``/``DB_NAME``, ``LIBRARY_METADATA_URL``,
``LML_API_KEY``, and ``SENTRY_DSN`` (unless ``DRY_RUN`` — a cron run that cannot
alert is a silent failure of the job's whole purpose, so it fails loudly
instead).

Optional env (in-code defaults when absent):
    DRY_RUN=true                       suppress Sentry events; log what would fire
    BACKFILL_LML_RATE_PER_MIN=N        default 20 (BS#995)
    BACKFILL_LML_RESOLVE_TIMEOUT_MS=N  default 15000, per LML call
    LIVE_ACTIVITY_LOOKBACK_SECONDS=N   default 60; 0 disables cooperative pause
    LIVE_ACTIVITY_PAUSE_MS=N           default 30000
    LIVE_ACTIVITY_MAX_PAUSE_MS=N       default 1800000 (30 min). Cumulative
                                       pause budget per run; once spent the run
                                       proceeds without pausing, so a non-zero
                                       budget can never wedge (BS#1636). 0 opts
                                       out (uncapped) — keep non-zero in prod.
    WXYC_SCHEMA_NAME                   default wxyc_schema

One-shot invocation (smoke test on the EC2 host):
    docker run --rm --env-file .env -e DRY_RUN=true \\
        $AWS_ECR_URI/rotation-release-id-pollution-check:latest
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid

from pollution_engine import AuditRow, LmlReleaseClient, audit, fetch_candidates

JOB_NAME = "rotation-release-id-pollution-check"
DEFAULT_SOURCES = ["lml_offline_backfill", "discogs_direct_backfill"]

# Decision 3 fallback ONLY (see plans/bs1522-recurring-pollution-check.md):
# empty while the 3 confirmed-correct #1528 "leave" rows (8276, 8277, 15726)
# are flipped to md_verified provenance, which removes them from the candidate
# set data-side. Populate with those ids only if the flip is declined/delayed.
KNOWN_ACCEPTED_ROTATION_IDS: frozenset[int] = frozenset()

# The full set of rotation ids stamped `discogs_direct_backfill` in prod — active
# AND killed — snapshotted during the #1522 go-live session (2026-07-06), after
# the #1528 "leave" rows (8276, 8277, 15726) were flipped to md_verified. This
# CORRECTS the original active-only baseline (207 ids from the 2026-07-05 audit
# CSV): that CSV was `include_killed=False`, so it missed 32 killed stragglers
# (rows stamped before the #1521 retirement that later aged out on kill_date) —
# the provenance query has no kill filter, so those 32 false-alerted on the
# go-live DRY_RUN smoke (38 total anomalies vs. the active-only baseline). A
# read-only classifier confirmed 0 post-retirement active adds, i.e. no genuine
# writer regression — the anomalies were purely a baseline-coverage gap.
#
# Update rule (see README "Provenance baseline"): a SUPERSET is safe, a subset
# false-alerts. Ids that leave the stamped set (remediation / md_verified flips)
# never re-appear in the query, so shrinkage needs no edit here. Only an ADDITION
# matters, and it should only ever happen as the acknowledgment of an investigated
# `provenance` alert. Recompute for verification with:
#   SELECT id FROM wxyc_schema.rotation
#    WHERE discogs_release_id_source = 'discogs_direct_backfill' ORDER BY id;
PROVENANCE_BASELINE: frozenset[int] = frozenset([
    7960, 7961, 8207, 8255, 8256, 8499, 9192, 9296, 9882, 9884, 9885, 10562,
    10563, 10564, 10565, 10566, 10567, 10568, 10569, 10578, 11069, 11343, 11344, 11345,
    11507, 11557, 12028, 12029, 12452, 12474, 12650, 13262, 13263, 13264, 13265, 13372,
    13373, 13374, 13704, 14009, 14144, 14145, 14146, 14147, 14148, 14149, 14164, 15065,
    15132, 15133, 15717, 15949, 15950, 15951, 15952, 16018, 16019, 16020, 16023, 16688,
    16690, 16715, 16716, 16717, 16718, 16795, 16796, 16797, 16799, 16861, 16862, 16892,
    16901, 16902, 16951, 16955, 17004, 17007, 17266, 18428, 18429, 18430, 18431, 18434,
    18454, 18455, 18961, 18962, 18963, 18964, 18995, 18996, 18997, 18998, 18999, 19016,
    19017, 19024, 19077, 19078, 19079, 19155, 19160, 19164, 19165, 19166, 19167, 19168,
    19169, 19170, 19171, 19224, 19342, 19574, 20468, 20469, 20832, 20833, 20834, 20835,
    20836, 20837, 20838, 21318, 21319, 21320, 21321, 21396, 21413, 21417, 21422, 21426,
    21431, 21433, 21434, 21435, 21436, 21438, 21439, 21440, 21441, 21442, 21446, 21449,
    21451, 21453, 21454, 21458, 21462, 21463, 21467, 21469, 21471, 21476, 21477, 21478,
    21480, 21481, 21482, 21484, 21485, 21488, 21490, 21493, 21494, 21495, 21498, 21501,
    21503, 21505, 21506, 21507, 21508, 21512, 21516, 21518, 21519, 21521, 21522, 21524,
    21526, 21528, 21529, 21530, 21531, 21534, 21535, 21537, 21541, 21545, 21546, 21547,
    21551, 21555, 21556, 21560, 21569, 21581, 21584, 21585, 43154, 43160, 43162,
])

# Run-degraded threshold: an LML outage turns most rows into `error`; one
# run-level event beats N per-row alerts (and beats silence).
DEGRADED_ERROR_FLOOR = 5
DEGRADED_ERROR_FRACTION = 0.25

# Cumulative cooperative-pause budget per run (BS#1636): once the probe has
# spent this much wall-clock pausing, it logs a warning and stops yielding so
# the weekly signal completes. 30 min dwarfs the ~9 min audit itself.
LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT = 1_800_000.0

_RUN_ID = str(uuid.uuid4())


def log(level: str, step: str, message: str, **fields: object) -> None:
    """JSON log line carrying the Phase-A four-tag contract (#538):
    ``repo``, ``tool``, ``step``, ``run_id`` — mirroring the sibling jobs'
    logger semantics. ``error`` goes to stderr so log shippers split streams."""
    line = json.dumps({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "step": step,
        "message": message,
        "repo": "Backend-Service",
        "tool": JOB_NAME,
        "run_id": _RUN_ID,
        **fields,
    })
    stream = sys.stderr if level == "error" else sys.stdout
    stream.write(line + "\n")
    stream.flush()


def env_truthy(raw: str | None) -> bool:
    return (raw or "").strip().lower() in ("true", "1")


def env_non_negative(raw: str | None, fallback: float) -> float:
    """Mirror the sibling orchestrators' envNonNegativeInt: empty/invalid/negative
    falls back rather than erroring, so a typo'd tuning var can't kill the cron."""
    if raw is None or raw.strip() == "":
        return fallback
    try:
        parsed = float(raw)
    except ValueError:
        return fallback
    return parsed if parsed >= 0 else fallback


def missing_required_env(env: dict[str, str]) -> list[str]:
    """Names of required vars absent/blank in ``env``. SENTRY_DSN is required
    unless DRY_RUN — an alerting job that cannot alert must fail loudly."""
    required = ["DB_HOST", "DB_USERNAME", "DB_PASSWORD", "DB_NAME", "LIBRARY_METADATA_URL", "LML_API_KEY"]
    if not env_truthy(env.get("DRY_RUN")):
        required.append("SENTRY_DSN")
    return [name for name in required if not (env.get(name) or "").strip()]


def fingerprint_for(kind: str, rotation_id: int) -> list[str]:
    """Sentry fingerprint: one issue per (kind, rotation_id). ``kind`` is
    ``mismatch`` or ``provenance``. Per-row grouping is the load-bearing design
    (#1522): stable rows regroup, remediated rows auto-resolve, new rows open
    fresh issues."""
    return [JOB_NAME, kind, str(rotation_id)]


def provenance_anomalies(stamped_ids: list[int], baseline: frozenset[int]) -> list[int]:
    """Ids stamped ``discogs_direct_backfill`` that the frozen baseline does not
    know — each one is a #1521-retirement violation. Sorted for stable output."""
    return sorted(set(stamped_ids) - baseline)


def should_alert_mismatch(row: AuditRow, known_accepted: frozenset[int]) -> bool:
    """Alert on ``mismatch`` only (2026-07-05 calibration: ``suspect`` was 100%
    false-positive) and never on a known-accepted id (Decision 3 fallback)."""
    return row.verdict == "mismatch" and row.rotation_id not in known_accepted


def run_degraded(error_count: int, scanned: int) -> bool:
    return error_count > max(DEGRADED_ERROR_FLOOR, DEGRADED_ERROR_FRACTION * scanned)


def make_pause_probe(conn, schema: str, lookback_seconds: float, pause_ms: float,
                     max_pause_ms: float = LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT,
                     on_pause=None, on_budget_exhausted=None):
    """Cooperative pause (BS#735): zero-arg callable for the engine's
    ``before_row`` hook. Ports ``shared/database/src/live-activity.ts`` — the
    literal ``'track'`` predicate is what lets the planner match migration
    0050's partial index; keep it inline rather than parameterised.

    ``now()`` freshness requires ``conn`` to be in autocommit mode: inside a
    psycopg implicit transaction now() is transaction_timestamp(), frozen at
    the transaction's first statement, so one track logged after that instant
    keeps the probe live forever (BS#1636 — Run 1 wedged 34h this way).
    ``max_pause_ms`` is the second guard: cumulative wall-clock this probe may
    spend in its pause loop across the whole run. At the default (30 min) no
    clock or data shape can wedge the run — on exhaustion it fires
    ``on_budget_exhausted`` once and every later call returns immediately.
    ``0`` opts out of that ceiling (uncapped): the autocommit fix still bars the
    frozen-clock wedge, but under a genuinely sustained live show the loop then
    pauses for as long as DJs keep adding tracks, so keep a non-zero budget in
    production."""
    sql = (
        f'SELECT 1 FROM "{schema}"."flowsheet" '
        "WHERE \"entry_type\" = 'track' "
        "AND \"add_time\" > now() - (interval '1 second' * %s) LIMIT 1"
    )
    state = {"paused_s": 0.0, "exhausted": False}

    def probe() -> None:
        if lookback_seconds <= 0 or state["exhausted"]:
            return
        while True:
            loop_start = time.monotonic()
            with conn.cursor() as cur:
                cur.execute(sql, (lookback_seconds,))
                live = cur.fetchone() is not None
            if not live:
                return
            if max_pause_ms > 0 and state["paused_s"] * 1000.0 >= max_pause_ms:
                state["exhausted"] = True
                if on_budget_exhausted is not None:
                    on_budget_exhausted(state["paused_s"])
                return
            if on_pause is not None:
                on_pause()
            if pause_ms > 0:
                time.sleep(pause_ms / 1000.0)
            # Accrue measured wall-clock (from loop top, so a pause_ms=0
            # misconfiguration still accrues query time and stays bounded).
            state["paused_s"] += time.monotonic() - loop_start

    return probe


def emit_alert(kind: str, rotation_id: int, message: str, extras: dict[str, object], dry_run: bool) -> None:
    if dry_run:
        log("info", "would_alert", message, kind=kind, rotation_id=rotation_id, **extras)
        return
    import sentry_sdk  # lazy: --self-test and DRY_RUN paths never need the SDK

    with sentry_sdk.new_scope() as scope:
        scope.fingerprint = fingerprint_for(kind, rotation_id)
        scope.set_tag("kind", kind)
        scope.set_tag("rotation_id", str(rotation_id))
        for key, value in extras.items():
            scope.set_extra(key, value)
        sentry_sdk.capture_message(message, level="warning")


def run(conn, client: LmlReleaseClient, dry_run: bool, pause_probe=None) -> dict[str, int]:
    """One full check. Returns the counter dict for the ``finished`` log line.
    Invariant: ``scanned == ok + suspect + mismatch + error``; ``alerted`` and
    ``suppressed`` partition the mismatch bucket; ``provenance_anomalies`` is
    independent of the scanned set (it includes killed rows)."""
    # Detection 2 first: SQL-only, so it still reports when LML is down.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM wxyc_schema.rotation WHERE discogs_release_id_source = 'discogs_direct_backfill'"
        )
        stamped = [row[0] for row in cur.fetchall()]
    anomalies = provenance_anomalies(stamped, PROVENANCE_BASELINE)
    for rotation_id in anomalies:
        emit_alert(
            "provenance",
            rotation_id,
            f"rotation {rotation_id}: new discogs_direct_backfill stamp after the #1521 retirement "
            "(no sanctioned writer emits this source; a writer has regressed)",
            {"issue": "https://github.com/WXYC/Backend-Service/issues/1521"},
            dry_run,
        )

    # Detection 1: the #1517 mismatch audit over the active candidate set.
    rows = fetch_candidates(conn, DEFAULT_SOURCES, include_killed=False)
    audit(rows, client, before_row=pause_probe)

    counters = {"scanned": len(rows), "ok": 0, "suspect": 0, "mismatch": 0, "error": 0,
                "alerted": 0, "suppressed": 0, "provenance_anomalies": len(anomalies)}
    for row in rows:
        counters[row.verdict] += 1
        if row.verdict != "mismatch":
            continue
        if not should_alert_mismatch(row, KNOWN_ACCEPTED_ROTATION_IDS):
            counters["suppressed"] += 1
            log("info", "suppressed", f"rotation {row.rotation_id}: known-accepted mismatch suppressed",
                rotation_id=row.rotation_id)
            continue
        counters["alerted"] += 1
        emit_alert(
            "mismatch",
            row.rotation_id,
            f"rotation {row.rotation_id}: stored release {row.discogs_release_id} title "
            f"{row.release_title!r} scores {row.album_score} against reference {row.ref_album!r} — "
            "possible wrong-album pollution (#1517 recipe applies)",
            {
                "source": row.source,
                "title_source": row.title_source,
                "ref_artist": row.ref_artist,
                "ref_album": row.ref_album,
                "discogs_release_id": row.discogs_release_id,
                "release_title": row.release_title,
                "album_score": row.album_score,
                "note": row.note,
                "runbook": "jobs/rotation-release-id-pollution-check/README.md",
            },
            dry_run,
        )

    if run_degraded(counters["error"], counters["scanned"]):
        emit_alert(
            "run-degraded", 0,
            f"{JOB_NAME}: {counters['error']}/{counters['scanned']} rows errored — LML likely "
            "degraded; this run's mismatch coverage is incomplete",
            {"error_count": counters["error"], "scanned": counters["scanned"]},
            dry_run,
        )
    return counters


def self_test() -> int:
    """Pure-function checks; no DB, LML, or Sentry needed (run at Docker build
    time and from the jest shell-out in tests/unit/jobs/)."""
    failures = 0

    def check(label: str, actual, expected) -> None:
        nonlocal failures
        ok = actual == expected
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}: {label} = {actual!r} (expected {expected!r})")

    check("fingerprint_for mismatch", fingerprint_for("mismatch", 21529),
          ["rotation-release-id-pollution-check", "mismatch", "21529"])
    check("fingerprint_for provenance", fingerprint_for("provenance", 99999),
          ["rotation-release-id-pollution-check", "provenance", "99999"])

    # Provenance: in-baseline ids never alert; unknown ids do; shrinkage is silent.
    check("provenance in-baseline quiet", provenance_anomalies([7960, 43162], PROVENANCE_BASELINE), [])
    check("provenance new id alerts", provenance_anomalies([7960, 99999], PROVENANCE_BASELINE), [99999])
    check("provenance empty set quiet", provenance_anomalies([], PROVENANCE_BASELINE), [])
    check("provenance sorted + deduped", provenance_anomalies([5, 99999, 5], frozenset([1])), [5, 99999])
    # The #1528 leaves (8276/8277/15726) and repoints (incl. 43164) were flipped
    # to md_verified in the go-live session, so they are OUT of the stamped set
    # and correctly absent from the corrected baseline.
    check("provenance baseline excludes md_verified rows", {8276, 8277, 15726, 43164} & PROVENANCE_BASELINE, set())
    check("provenance baseline size (2026-07-06 prod snapshot)", len(PROVENANCE_BASELINE), 203)

    def mk(verdict: str, rotation_id: int = 1) -> AuditRow:
        return AuditRow(rotation_id=rotation_id, artist_name="", album_title="",
                        discogs_release_id=1, source="test", verdict=verdict)

    check("mismatch alerts", should_alert_mismatch(mk("mismatch"), frozenset()), True)
    check("suspect never alerts", should_alert_mismatch(mk("suspect"), frozenset()), False)
    check("error never alerts", should_alert_mismatch(mk("error"), frozenset()), False)
    check("known-accepted suppressed", should_alert_mismatch(mk("mismatch", 8276), frozenset([8276])), False)

    check("degraded above floor", run_degraded(6, 10), True)
    check("degraded needs > floor even when tiny scan", run_degraded(5, 10), False)
    check("degraded fraction on big scan", run_degraded(50, 168), True)
    check("healthy big scan not degraded", run_degraded(10, 168), False)

    check("env_truthy true", env_truthy("true"), True)
    check("env_truthy TRUE", env_truthy("TRUE"), True)
    check("env_truthy 1", env_truthy("1"), True)
    check("env_truthy unset", env_truthy(None), False)
    check("env_non_negative default", env_non_negative(None, 60), 60)
    check("env_non_negative parse", env_non_negative("30", 60), 30.0)
    check("env_non_negative invalid falls back", env_non_negative("nope", 60), 60)
    check("env_non_negative negative falls back", env_non_negative("-5", 60), 60)

    base_env = {"DB_HOST": "h", "DB_USERNAME": "u", "DB_PASSWORD": "p", "DB_NAME": "d",
                "LIBRARY_METADATA_URL": "http://lml", "LML_API_KEY": "k"}
    check("missing env requires SENTRY_DSN", missing_required_env(dict(base_env)), ["SENTRY_DSN"])
    check("missing env ok with dsn", missing_required_env({**base_env, "SENTRY_DSN": "x"}), [])
    check("missing env dry-run waives dsn", missing_required_env({**base_env, "DRY_RUN": "true"}), [])
    check("missing env flags blank db", missing_required_env({**base_env, "DB_HOST": " ", "SENTRY_DSN": "x"}),
          ["DB_HOST"])

    # run() wiring against stubs: 1 ok + 1 mismatch + 1 known-accepted mismatch
    # scanned; one out-of-baseline stamped id -> exactly one provenance anomaly.
    class _StubCursor:
        def __init__(self, owner):
            self._owner = owner

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            self._rows = self._owner.stamped if "discogs_direct_backfill" in sql else self._owner.candidates

        def fetchall(self):
            return self._rows

    class _StubConn:
        def __init__(self, stamped, candidates):
            self.stamped = stamped
            self.candidates = candidates

        def cursor(self):
            return _StubCursor(self)

    class _StubLml:
        def get_release(self, release_id):
            # 100 -> title matches reference "Match"; anything else mismatches.
            return {"title": "Match" if release_id == 100 else "Other Thing Entirely", "artists": []}, ""

    known_id = next(iter(PROVENANCE_BASELINE))
    candidates = [
        # (id, artist_name, album_title, discogs_release_id, source, album_id, lib_artist, lib_album)
        (1, "A", "Match", 100, "discogs_direct_backfill", None, None, None),
        (2, "B", "Match", 200, "discogs_direct_backfill", None, None, None),
    ]
    conn = _StubConn(stamped=[(known_id,), (99999,)], candidates=candidates)
    counters = run(conn, _StubLml(), dry_run=True, pause_probe=None)
    check("run scanned", counters["scanned"], 2)
    check("run ok", counters["ok"], 1)
    check("run mismatch", counters["mismatch"], 1)
    check("run alerted", counters["alerted"], 1)
    check("run suppressed", counters["suppressed"], 0)
    check("run provenance anomalies", counters["provenance_anomalies"], 1)
    check("run invariant", counters["scanned"],
          counters["ok"] + counters["suspect"] + counters["mismatch"] + counters["error"])

    # make_pause_probe behavior against stub connections (BS#1636: Run 1 wedged
    # for 34h when a frozen now() made the liveness SQL true forever — the
    # cumulative budget must bound the loop no matter what the SQL returns).
    class _ProbeCursor:
        def __init__(self, owner):
            self._owner = owner

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            self._owner.executes += 1

        def fetchone(self):
            return (1,) if self._owner.live else None

    class _ProbeConn:
        def __init__(self, live: bool):
            self.live = live
            self.executes = 0

        def cursor(self):
            return _ProbeCursor(self)

    events = {"pauses": 0, "exhausted": 0}
    quiet = _ProbeConn(live=False)
    probe = make_pause_probe(
        quiet, "wxyc_schema", 60.0, 1.0, max_pause_ms=50.0,
        on_pause=lambda: events.__setitem__("pauses", events["pauses"] + 1),
        on_budget_exhausted=lambda _s: events.__setitem__("exhausted", events["exhausted"] + 1),
    )
    probe()
    check("probe not-live returns after one query, no pause", (quiet.executes, events["pauses"]), (1, 0))

    events = {"pauses": 0, "exhausted": 0}
    busy = _ProbeConn(live=True)
    probe = make_pause_probe(
        busy, "wxyc_schema", 60.0, 1.0, max_pause_ms=5.0,
        on_pause=lambda: events.__setitem__("pauses", events["pauses"] + 1),
        on_budget_exhausted=lambda _s: events.__setitem__("exhausted", events["exhausted"] + 1),
    )
    probe()
    check("probe exhausts budget on persistent liveness", events["exhausted"], 1)
    check("probe paused at least once before exhausting", events["pauses"] >= 1, True)
    executes_at_exhaustion = busy.executes
    probe()
    check("exhausted probe stops querying", busy.executes, executes_at_exhaustion)
    check("exhausted probe does not re-fire the callback", events["exhausted"], 1)

    disabled = _ProbeConn(live=True)
    probe = make_pause_probe(disabled, "wxyc_schema", 0.0, 1.0, max_pause_ms=5.0)
    probe()
    check("probe lookback 0 short-circuits without querying", disabled.executes, 0)

    return 1 if failures else 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()

    dry_run = env_truthy(os.environ.get("DRY_RUN"))
    missing = missing_required_env(dict(os.environ))
    if missing:
        log("error", "failed", f"missing required env: {', '.join(missing)}; aborting before any rows are scanned")
        return 2

    if not dry_run:
        import sentry_sdk

        sentry_sdk.init(
            dsn=os.environ["SENTRY_DSN"],
            release=os.environ.get("SENTRY_RELEASE"),
            environment=os.environ.get("NODE_ENV", "production"),
        )
        sentry_sdk.set_tag("repo", "Backend-Service")
        sentry_sdk.set_tag("tool", JOB_NAME)
        sentry_sdk.set_tag("run_id", _RUN_ID)

    rate_per_min = env_non_negative(os.environ.get("BACKFILL_LML_RATE_PER_MIN"), 20.0)
    timeout_s = env_non_negative(os.environ.get("BACKFILL_LML_RESOLVE_TIMEOUT_MS"), 15000.0) / 1000.0
    lookback_s = env_non_negative(os.environ.get("LIVE_ACTIVITY_LOOKBACK_SECONDS"), 60.0)
    pause_ms = env_non_negative(os.environ.get("LIVE_ACTIVITY_PAUSE_MS"), 30000.0)
    max_pause_ms = env_non_negative(
        os.environ.get("LIVE_ACTIVITY_MAX_PAUSE_MS"), LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT)
    schema = (os.environ.get("WXYC_SCHEMA_NAME") or "wxyc_schema").replace('"', '""')

    log("info", "init", f"{JOB_NAME} initialized", dry_run=dry_run, rate_per_min=rate_per_min,
        live_activity_lookback_seconds=lookback_s)

    import psycopg  # lazy: keeps --self-test driver-free

    exit_code = 0
    conn = psycopg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ["DB_USERNAME"],
        password=os.environ["DB_PASSWORD"],
        dbname=os.environ["DB_NAME"],
        application_name=f"wxyc-{JOB_NAME}",
        # autocommit is load-bearing, not a preference: the cooperative-pause
        # probe compares flowsheet.add_time against now(), which inside a psycopg
        # implicit transaction is transaction_timestamp() — frozen at the first
        # statement. Without this the probe stays live forever once any track is
        # logged after the run starts (BS#1636). Read-only job; nothing to batch.
        autocommit=True,
        # Short SELECTs only; a wedged query must not hold the weekly run open.
        options="-c statement_timeout=60000",
    )
    try:
        client = LmlReleaseClient(
            os.environ["LIBRARY_METADATA_URL"], os.environ.get("LML_API_KEY"), rate_per_min, timeout_s
        )
        probe = make_pause_probe(
            conn, schema, lookback_s, pause_ms, max_pause_ms,
            on_pause=lambda: log("info", "live_activity_pause", "live flowsheet activity detected; pausing"),
            on_budget_exhausted=lambda paused_s: log(
                "warning", "live_activity_pause_budget_exhausted",
                "cooperative-pause budget exhausted; proceeding without further pauses",
                paused_seconds=round(paused_s, 1), max_pause_ms=max_pause_ms),
        )
        counters = run(conn, client, dry_run, pause_probe=probe)
        log("info", "finished", f"{JOB_NAME} done", dry_run=dry_run, **counters)
    except Exception as err:  # noqa: BLE001 — single boundary; Sentry gets the details
        log("error", "failed", f"{JOB_NAME} failed", error_type=type(err).__name__, error_message=str(err))
        if not dry_run:
            import sentry_sdk

            sentry_sdk.capture_exception(err)
        exit_code = 1
    finally:
        conn.close()
        if not dry_run:
            import sentry_sdk

            sentry_sdk.flush(timeout=2.0)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
