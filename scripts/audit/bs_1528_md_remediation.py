"""Execute the BS#1528 MD-decided remediation of the 11 held rotation rows.

Companion to `bs_rotation_release_id_remediation.py` (#1517 / #1529), which
remediated the 31 confirmed wrong-album rows via LML trust-gated resolution.
The 11 rows here were deliberately held out of that run because their free-text
references are degenerate (self-titled / catalog code / artist-as-title /
single letter) and needed a human verdict. The verdicts were settled by the
row-by-row verification pass posted on #1528 (Discogs API + prod-clone
label/add_date context + 2026 release calendar) and are embedded in PLAN below
— this script performs NO resolution of its own:

  leave (3)    8276, 8277 (Tarantula s/t EP -> 736836), 15726 (Gunther Doug EP
               -> 14607567): stored ids verified correct. SELECT + confirm the
               stored id still matches; never UPDATE.
  null (4)     8247, 8248, 8267, 8268 (Killing Frost "s/t" -> 388101, which is
               Killing Joke's 1980 debut — wrong ARTIST): NULL the id and reset
               source to `tubafrenzy_paste`. No repoint target exists — Killing
               Frost has no self-titled release on Discogs (their 2005 release
               is the "Frozen To Death" cassette). The trust-gated re-resolve
               paths refuse non-direct answers, so these correctly stay NULL.
  repoint (4)  21583 -> 37372443 (Setting s/t, Thrill Jockey THRILL 647, 2026;
               stored 28630006 is the 2023 Paradise of Bachelors album),
               21533 -> 35937175 (Beau Wanzer "BW07"; stored 7544374 is the
               BW 03 Corporate Park split),
               21574 -> 37412646 (underscores "U", Mom + Pop MP940; stored
               22854122 is 2021's Fishmonger),
               43164 -> 36996060 (Wendy Eisenberg s/t, Joyful Noise JNR514;
               stored 12502729 is 2018's Time Machine).
               Written with source = 'md_verified' (migration 0109): these ids
               are human-verified, not LML-resolved.

Every write also clears `lml_identity_id` (BS#1380 invariant: an identity
minted against the old id is stale once the effective discogs_release_id
changes). The repointed rows re-enter the daily identity-mint sweep
(`lml_identity_id IS NULL AND discogs_release_id IS NOT NULL`) and regenerate
against the correct id within ~24h; the NULLed rows correctly leave the
identity pipeline.

RETRO_SCRUB_IDS is the paired retroactive fix: the 2026-07-06 #1517 run
NULL-and-reset 31 rows without clearing `lml_identity_id`, stranding stale
wrong-release identities that (a) keep feeding `rotation-artist-backfill`
(reads DISTINCT non-NULL lml_identity_id on active rows) and (b) sit
permanently outside the identity-mint sweep, whose predicate requires a
non-NULL discogs_release_id. The scrub clears `lml_identity_id` on exactly
those 31 ids, and only where the remediated state is still intact
(`discogs_release_id IS NULL AND source = 'tubafrenzy_paste' AND
lml_identity_id IS NOT NULL`) — rows already consistent or since re-resolved
match 0 rows and are skipped.

Read-only by default (dry-run): prints the SELECT-before state (including
43164's add_date, unverifiable offline because the local clone snapshot
predates the row), the per-row decisions, and the retro-scrub candidates.
--execute: per-row guarded UPDATE (WHERE id = ? AND discogs_release_id = <old>
AND source = 'discogs_direct_backfill'), rowcount == 1 check, SELECT-after,
per-row commit. Re-running is safe and idempotent: an already-remediated row
no longer matches its guard and is reported as state-drift/skip.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

logger = logging.getLogger("bs_1528_md_remediation")

LEAVE, NULL, REPOINT = "leave", "null", "repoint"
MUTATION_GUARD_SOURCE = "discogs_direct_backfill"

# (rotation_id, expected_old_id, action, new_id, note) — verdicts from the
# #1528 verification comment (2026-07-06), independently re-verified against
# the Discogs API the same day.
PLAN = [
    (8247, 388101, NULL, None, "Killing Frost s/t — stored is Killing Joke (wrong artist); no s/t exists on Discogs"),
    (8248, 388101, NULL, None, "Killing Frost s/t — same as 8247"),
    (8267, 388101, NULL, None, "Killing Frost s/t — same as 8247"),
    (8268, 388101, NULL, None, "Killing Frost s/t — same as 8247"),
    (8276, 736836, LEAVE, None, "Tarantula s/t EP — 2004 self-released 5-track CD is correct"),
    (8277, 736836, LEAVE, None, "Tarantula s/t EP — same as 8276"),
    (15726, 14607567, LEAVE, None, "Gunther Doug S/T — the 2013 self-released EP is correct"),
    (21533, 7544374, REPOINT, 35937175, "Beau Wanzer BW07 — stored is the BW 03 Corporate Park split; r35937175 is the real BW07"),
    (21574, 22854122, REPOINT, 37412646, "underscores U — Mom + Pop MP940 (master 4170004); stored is 2021's Fishmonger"),
    (21583, 28630006, REPOINT, 37372443, "Setting s/t — Thrill Jockey THRILL 647 (2026); stored is the 2023 PoB album"),
    (43164, 12502729, REPOINT, 36996060, "Wendy Eisenberg s/t — Joyful Noise JNR514; stored is 2018's Time Machine"),
]

# The 31 rows NULL-and-reset by the 2026-07-06 #1517 remediation run (see the
# remediation report comment on #1517), whose stale lml_identity_id this
# script retroactively clears.
RETRO_SCRUB_IDS = [
    8187, 11325, 11326, 11327, 14824, 14825, 14826, 21456, 21474, 21491, 21492,
    21496, 21497, 21500, 21504, 21509, 21510, 21511, 21525, 21527, 21532, 21536,
    21539, 21540, 21552, 21565, 21567, 21572, 21573, 43155, 43156,
]


def classify_row(entry, db_state) -> tuple[str, str]:
    """Decide what to do with one PLAN entry given the row's live state.

    entry: (rotation_id, expected_old_id, action, new_id, note).
    db_state: (discogs_release_id, discogs_release_id_source, lml_identity_id)
    or None when the row doesn't exist.
    Returns (decision, reason); decision in {apply, confirm_leave, skip}.
    Mutations require the exact audited state — expected old id AND the
    discogs_direct_backfill source — so a raced/already-remediated row is
    skipped, never blindly rewritten (#1517 convention).
    """
    rid, expected_old, action, _new_id, _note = entry
    if db_state is None:
        return "skip", f"rotation_id={rid} not found"
    old_id, source, _ident = db_state
    if action == LEAVE:
        if old_id == expected_old:
            return "confirm_leave", f"stored id {old_id} matches verified-correct id — not touching"
        return "skip", f"state drift (id={old_id}, expected {expected_old}) — re-verify before touching"
    if old_id != expected_old:
        return "skip", f"state drift (id={old_id}, expected {expected_old}) — not touching"
    if source != MUTATION_GUARD_SOURCE:
        return "skip", f"state drift (source={source}, expected {MUTATION_GUARD_SOURCE}) — not touching"
    return "apply", ""


def self_test() -> int:
    """Pure checks, no DB: PLAN/RETRO table integrity + every classify_row branch."""
    failures = 0

    def check(label: str, actual, expected) -> None:
        nonlocal failures
        ok = actual == expected
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}: {label} = {actual!r} (expected {expected!r})")

    plan_ids = [e[0] for e in PLAN]
    check("plan has 11 rows", len(PLAN), 11)
    check("plan ids unique", len(set(plan_ids)), len(plan_ids))
    check(
        "plan ids are the #1528 held set",
        sorted(plan_ids),
        [8247, 8248, 8267, 8268, 8276, 8277, 15726, 21533, 21574, 21583, 43164],
    )
    check("actions valid", all(e[2] in (LEAVE, NULL, REPOINT) for e in PLAN), True)
    check("action split 3 leave / 4 null / 4 repoint",
          [sum(1 for e in PLAN if e[2] == a) for a in (LEAVE, NULL, REPOINT)], [3, 4, 4])
    check("expected_old_id positive everywhere", all(isinstance(e[1], int) and e[1] > 0 for e in PLAN), True)
    check(
        "repoint entries carry a positive new_id",
        all(isinstance(e[3], int) and e[3] > 0 for e in PLAN if e[2] == REPOINT),
        True,
    )
    check("non-repoint entries carry no new_id", all(e[3] is None for e in PLAN if e[2] != REPOINT), True)
    check(
        "repoint new_id differs from old",
        all(e[3] != e[1] for e in PLAN if e[2] == REPOINT),
        True,
    )
    check("retro set is the 31 #1517-remediated ids", len(RETRO_SCRUB_IDS), 31)
    check("retro ids unique", len(set(RETRO_SCRUB_IDS)), 31)
    check("retro ids disjoint from plan ids", set(RETRO_SCRUB_IDS) & set(plan_ids), set())

    repoint_entry = next(e for e in PLAN if e[2] == REPOINT)
    null_entry = next(e for e in PLAN if e[2] == NULL)
    leave_entry = next(e for e in PLAN if e[2] == LEAVE)

    # apply: exact audited state (expected old id + direct_backfill source)
    decision, _ = classify_row(repoint_entry, (repoint_entry[1], MUTATION_GUARD_SOURCE, 555))
    check("repoint exact-state decision", decision, "apply")
    decision, _ = classify_row(null_entry, (null_entry[1], MUTATION_GUARD_SOURCE, None))
    check("null exact-state decision", decision, "apply")

    # leave: confirmed when the stored id matches; drift otherwise
    decision, _ = classify_row(leave_entry, (leave_entry[1], MUTATION_GUARD_SOURCE, 7))
    check("leave confirmed decision", decision, "confirm_leave")
    decision, reason = classify_row(leave_entry, (999, MUTATION_GUARD_SOURCE, 7))
    check("leave drift decision", decision, "skip")
    check("leave drift reason mentions drift", "state drift" in reason, True)

    # mutation drift: wrong id, wrong source, already-nulled, missing row
    decision, _ = classify_row(repoint_entry, (999, MUTATION_GUARD_SOURCE, 7))
    check("repoint id-drift decision", decision, "skip")
    decision, _ = classify_row(repoint_entry, (repoint_entry[1], "tubafrenzy_paste", 7))
    check("repoint source-drift decision", decision, "skip")
    decision, _ = classify_row(null_entry, (None, "tubafrenzy_paste", None))
    check("null already-remediated decision", decision, "skip")
    decision, _ = classify_row(null_entry, None)
    check("missing row decision", decision, "skip")

    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--execute", action="store_true", help="issue guarded UPDATEs (default is dry-run)")
    ap.add_argument("--self-test", action="store_true", help="run plan-integrity/classification self-tests and exit")
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
        with conn.cursor() as cur:
            # The 4 repoints write 'md_verified' — fail fast with a readable
            # message if migration 0109 hasn't been applied here yet.
            cur.execute(
                """SELECT 1 FROM pg_enum e
                     JOIN pg_type t ON t.oid = e.enumtypid
                    WHERE t.typname = 'discogs_release_id_source_enum'
                      AND e.enumlabel = 'md_verified'"""
            )
            if cur.fetchone() is None:
                logger.error("enum value 'md_verified' missing — apply migration 0109 before running this script")
                return 2

            plan_ids = [e[0] for e in PLAN]
            cur.execute(
                """
                SELECT id, discogs_release_id, discogs_release_id_source, lml_identity_id,
                       artist_name, album_title, record_label, add_date, kill_date
                FROM wxyc_schema.rotation
                WHERE id = ANY(%s)
                ORDER BY id ASC
                """,
                (plan_ids,),
            )
            before = {row[0]: row for row in cur.fetchall()}

            cur.execute(
                """
                SELECT id, discogs_release_id, discogs_release_id_source, lml_identity_id
                FROM wxyc_schema.rotation
                WHERE id = ANY(%s)
                ORDER BY id ASC
                """,
                (RETRO_SCRUB_IDS,),
            )
            retro_before = {row[0]: row for row in cur.fetchall()}
        # End the read transaction: with autocommit=False the SELECTs opened a
        # txn; don't hold it idle (idle_in_transaction_session_timeout risk on
        # managed PG, and it needlessly pins a snapshot against VACUUM).
        conn.rollback()

        print("\nSELECT-before (the 11 held rows):")
        print("| rotation_id | release_id | source | lml_identity_id | artist | free-text | label | add_date | kill_date |")
        print("|---|---|---|---|---|---|---|---|---|")
        for rid in plan_ids:
            row = before.get(rid)
            if row is None:
                print(f"| {rid} | NOT FOUND | | | | | | | |")
                continue
            print("| " + " | ".join("" if v is None else str(v) for v in row) + " |")

        decisions = []
        for entry in PLAN:
            rid = entry[0]
            row = before.get(rid)
            db_state = None if row is None else (row[1], row[2], row[3])
            decision, reason = classify_row(entry, db_state)
            decisions.append((entry, decision, reason))
            level = logging.INFO if decision != "skip" else logging.WARNING
            logger.log(level, "[plan] rotation_id=%d action=%s decision=%s %s", rid, entry[2], decision, reason)

        retro_candidates = [
            rid
            for rid in RETRO_SCRUB_IDS
            if rid in retro_before
            and retro_before[rid][1] is None
            and retro_before[rid][2] == "tubafrenzy_paste"
            and retro_before[rid][3] is not None
        ]
        retro_skipped = [rid for rid in RETRO_SCRUB_IDS if rid not in retro_candidates]
        print(f"\nRetro identity scrub: {len(retro_candidates)} of {len(RETRO_SCRUB_IDS)} rows carry a stale lml_identity_id")
        for rid in retro_candidates:
            print(f"  {rid}: lml_identity_id={retro_before[rid][3]} (release NULL / tubafrenzy_paste) -> clear")
        if retro_skipped:
            print(f"  already consistent or state changed (skipped): {retro_skipped}")

        applies = [d for d in decisions if d[1] == "apply"]
        leaves = [d for d in decisions if d[1] == "confirm_leave"]
        skips = [d for d in decisions if d[1] == "skip"]
        logger.info(
            "PLAN SUMMARY: %d apply (%d repoint / %d null), %d leave-confirmed, %d skipped; retro scrub %d",
            len(applies),
            sum(1 for e, *_ in applies if e[2] == REPOINT),
            sum(1 for e, *_ in applies if e[2] == NULL),
            len(leaves),
            len(skips),
            len(retro_candidates),
        )

        if not args.execute:
            logger.info("DRY-RUN: no UPDATEs issued. Re-run with --execute to apply.")
            return 0

        applied = []
        try:
            with conn.cursor() as cur:
                for entry, decision, _ in decisions:
                    rid, old_id, action, new_id, _note = entry
                    if decision != "apply":
                        continue
                    if action == REPOINT:
                        cur.execute(
                            """UPDATE wxyc_schema.rotation
                                  SET discogs_release_id = %s,
                                      discogs_release_id_source = 'md_verified',
                                      lml_identity_id = NULL
                                WHERE id = %s AND discogs_release_id = %s
                                  AND discogs_release_id_source = 'discogs_direct_backfill'""",
                            (new_id, rid, old_id),
                        )
                    else:
                        cur.execute(
                            """UPDATE wxyc_schema.rotation
                                  SET discogs_release_id = NULL,
                                      discogs_release_id_source = 'tubafrenzy_paste',
                                      lml_identity_id = NULL
                                WHERE id = %s AND discogs_release_id = %s
                                  AND discogs_release_id_source = 'discogs_direct_backfill'""",
                            (rid, old_id),
                        )
                    matched = cur.rowcount
                    if matched != 1:
                        conn.rollback()
                        logger.error("rotation_id=%d guard matched %d rows (expected 1) — rolled back this row", rid, matched)
                        applied.append((rid, action, old_id, new_id, "RACED/GUARD_FAIL"))
                        continue
                    cur.execute(
                        """SELECT discogs_release_id, discogs_release_id_source, lml_identity_id
                             FROM wxyc_schema.rotation WHERE id = %s""",
                        (rid,),
                    )
                    after = cur.fetchone()
                    conn.commit()
                    applied.append((rid, action, old_id, new_id, f"after={after[0]}/{after[1]}/ident={after[2]}"))
                    logger.info("[applied] rotation_id=%d %s old=%s -> %s", rid, action.upper(), old_id, after)

                for rid in retro_candidates:
                    cur.execute(
                        """UPDATE wxyc_schema.rotation
                              SET lml_identity_id = NULL
                            WHERE id = %s AND discogs_release_id IS NULL
                              AND discogs_release_id_source = 'tubafrenzy_paste'
                              AND lml_identity_id IS NOT NULL""",
                        (rid,),
                    )
                    if cur.rowcount != 1:
                        # 0 is fine here — idempotent predicate; the row became
                        # consistent (or was re-resolved) between read and write.
                        conn.rollback()
                        logger.warning("[retro] rotation_id=%d predicate matched %d rows — skipped", rid, cur.rowcount)
                        applied.append((rid, "retro_scrub", None, None, "PREDICATE_MISS"))
                        continue
                    conn.commit()
                    applied.append((rid, "retro_scrub", None, None, "lml_identity_id cleared"))
                    logger.info("[applied] rotation_id=%d RETRO_SCRUB lml_identity_id cleared", rid)
        finally:
            # Always surface what was mutated: if a mid-loop DB error aborts the
            # run, the applied-so-far list is the provenance the operator needs.
            print("\nApplied:")
            for row in applied:
                print(f"  {row}")

        logger.info("EXECUTE DONE: %d writes processed", len(applied))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
