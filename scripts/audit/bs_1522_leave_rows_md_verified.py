"""Flip the 3 confirmed-correct #1528 "leave" rows to `md_verified` provenance (#1522).

Companion to `bs_1528_md_remediation.py`. That run's LEAVE verdicts (8276, 8277
Tarantula s/t EP -> 736836; 15726 Gunther Doug EP -> 14607567) confirmed the
stored ids correct but wrote nothing, so the rows still carry
`discogs_direct_backfill` — and their free-text references are degenerate
("s/t"-style), so they score below the mismatch floor *by construction* and
would stand as 3 permanent false `mismatch` alerts in the #1522 weekly check.

These rows meet `md_verified`'s definition exactly (schema comment, migration
0109: written only by operator-run remediation after a human verified the id
against Discogs — which is precisely what the #1528 MD pass did). Flipping the
source removes them from the check's default candidate set data-side, the same
way the 4 #1528 repoints dropped out, with zero standing job config.

Semantics of the write:
  - ONLY `discogs_release_id_source` changes ('discogs_direct_backfill' ->
    'md_verified'). The release id is untouched, so `lml_identity_id` is NOT
    cleared — the BS#1380 invariant applies to changes of the *effective id*,
    and an identity minted against an id that stays put remains valid.
  - rotation-etl's ON CONFLICT CASE preserves the flip against subsequent
    ticks (it only reverts to 'tubafrenzy_paste' when tubafrenzy contributes a
    non-NULL id), same as the existing 4 md_verified rows.

Idempotent: a row already flipped no longer matches the
`source = 'discogs_direct_backfill'` guard and is reported as already-done. A
row whose stored id drifted from the verified value is SKIPPED loudly — never
stamp `md_verified` on an id no human verified.

Read-only by default (--dry-run behavior): SELECT + plan print, no UPDATE.
--execute: per-row guarded UPDATE (WHERE id = ? AND discogs_release_id =
<verified id> AND source = 'discogs_direct_backfill'), rowcount==1 check,
per-row commit, SELECT-after verification.

Usage (prod EC2, per the established runbook — creds parsed in Python from
`docker inspect backend`, never shell-sourced):
    python3 bs_1522_leave_rows_md_verified.py              # dry-run
    python3 bs_1522_leave_rows_md_verified.py --execute
    python3 bs_1522_leave_rows_md_verified.py --self-test
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

logger = logging.getLogger("bs_1522_leave_rows_md_verified")

# (rotation_id, verified_discogs_release_id, note) — verdicts settled on #1528;
# do not re-litigate here.
PLAN = [
    (8276, 736836, "Tarantula s/t EP — 2004 self-released 5-track CD verified correct in #1528"),
    (8277, 736836, "Tarantula s/t EP — duplicate rotation row, same verified release"),
    (15726, 14607567, "Gunther Doug EP — verified correct in #1528"),
]


def classify_row(entry, db_state) -> tuple[str, str]:
    """Pure decision for one plan row against the row's current DB state.

    ``db_state`` is ``(discogs_release_id, discogs_release_id_source)`` or
    ``None`` when the row wasn't found. Returns ``(decision, reason)`` with
    decision in {"apply", "already_done", "skip"}.
    """
    rid, verified_id, _note = entry
    if db_state is None:
        return "skip", f"rotation_id={rid} not found"
    current_id, source = db_state
    if current_id != verified_id:
        return "skip", (
            f"stored id {current_id} != verified {verified_id} — state drifted since #1528; "
            "re-verify manually before stamping md_verified"
        )
    if source == "md_verified":
        return "already_done", "already md_verified (idempotent re-run)"
    if source != "discogs_direct_backfill":
        return "skip", f"unexpected source {source!r} — expected discogs_direct_backfill; investigate"
    return "apply", "id matches verified value; flip source to md_verified"


def self_test() -> int:
    failures = 0

    def check(label: str, actual, expected) -> None:
        nonlocal failures
        ok = actual == expected
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}: {label} = {actual!r} (expected {expected!r})")

    entry = PLAN[0]  # (8276, 736836, ...)
    check("apply on expected state", classify_row(entry, (736836, "discogs_direct_backfill"))[0], "apply")
    check("idempotent re-run", classify_row(entry, (736836, "md_verified"))[0], "already_done")
    check("id drift skips", classify_row(entry, (999, "discogs_direct_backfill"))[0], "skip")
    check("NULLed id skips", classify_row(entry, (None, "tubafrenzy_paste"))[0], "skip")
    check("unexpected source skips", classify_row(entry, (736836, "library_identity"))[0], "skip")
    check("missing row skips", classify_row(entry, None)[0], "skip")
    check("plan ids are the #1528 leaves", sorted(e[0] for e in PLAN), [8276, 8277, 15726])
    check("plan ids unique", len({e[0] for e in PLAN}), len(PLAN))
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--execute", action="store_true", help="issue guarded UPDATEs (default is dry-run)")
    ap.add_argument("--self-test", action="store_true", help="run classification self-tests and exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.self_test:
        return self_test()

    import psycopg

    conn = psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USERNAME", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
        dbname=os.environ.get("DB_NAME", "wxyc_db"),
        autocommit=False,
    )
    try:
        plan_ids = [e[0] for e in PLAN]
        with conn.cursor() as cur:
            # Fail fast with a readable message if migration 0109 isn't applied.
            cur.execute(
                """SELECT 1 FROM pg_enum e
                     JOIN pg_type t ON t.oid = e.enumtypid
                    WHERE t.typname = 'discogs_release_id_source_enum'
                      AND e.enumlabel = 'md_verified'"""
            )
            if cur.fetchone() is None:
                logger.error("enum value 'md_verified' missing — apply migration 0109 before running this script")
                return 2
            cur.execute(
                """SELECT id, discogs_release_id, discogs_release_id_source, lml_identity_id,
                          artist_name, album_title, kill_date
                     FROM wxyc_schema.rotation
                    WHERE id = ANY(%s)
                    ORDER BY id ASC""",
                (plan_ids,),
            )
            before = {row[0]: row for row in cur.fetchall()}
        # Don't hold the read txn open (idle-in-transaction / VACUUM pinning).
        conn.rollback()

        print("\nSELECT-before:")
        print("| rotation_id | release_id | source | lml_identity_id | artist | free-text | kill_date |")
        print("|---|---|---|---|---|---|---|")
        for rid in plan_ids:
            row = before.get(rid)
            if row is None:
                print(f"| {rid} | NOT FOUND | | | | | |")
                continue
            print("| " + " | ".join("" if v is None else str(v) for v in row) + " |")

        decisions = []
        for entry in PLAN:
            row = before.get(entry[0])
            db_state = None if row is None else (row[1], row[2])
            decision, reason = classify_row(entry, db_state)
            decisions.append((entry, decision))
            level = logging.INFO if decision != "skip" else logging.WARNING
            logger.log(level, "[plan] rotation_id=%d decision=%s %s", entry[0], decision, reason)

        applies = [d for d in decisions if d[1] == "apply"]
        logger.info(
            "PLAN SUMMARY: %d apply, %d already done, %d skipped",
            len(applies),
            sum(1 for d in decisions if d[1] == "already_done"),
            sum(1 for d in decisions if d[1] == "skip"),
        )

        if not args.execute:
            logger.info("DRY-RUN: no UPDATEs issued. Re-run with --execute to apply.")
            return 0

        failures = 0
        with conn.cursor() as cur:
            for (rid, verified_id, _note), decision in decisions:
                if decision != "apply":
                    continue
                cur.execute(
                    """UPDATE wxyc_schema.rotation
                          SET discogs_release_id_source = 'md_verified'
                        WHERE id = %s AND discogs_release_id = %s
                          AND discogs_release_id_source = 'discogs_direct_backfill'""",
                    (rid, verified_id),
                )
                if cur.rowcount != 1:
                    logger.error("rotation_id=%d guard matched %d rows (expected 1); rolling back this row", rid, cur.rowcount)
                    conn.rollback()
                    failures += 1
                    continue
                conn.commit()
                logger.info("rotation_id=%d flipped to md_verified", rid)

        with conn.cursor() as cur:
            cur.execute(
                """SELECT id, discogs_release_id, discogs_release_id_source, lml_identity_id
                     FROM wxyc_schema.rotation
                    WHERE id = ANY(%s)
                    ORDER BY id ASC""",
                (plan_ids,),
            )
            after = cur.fetchall()
        conn.rollback()
        print("\nSELECT-after:")
        for row in after:
            print("  " + " | ".join("" if v is None else str(v) for v in row))

        return 1 if failures else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
