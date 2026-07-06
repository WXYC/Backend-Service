"""Remediate the #1517 confirmed wrong-album rotation.discogs_release_id rows.

Companion to the read-only auditor `bs_rotation_release_id_pollution.py` (#1520).
This is the committed provenance of the 2026-07-06 remediation run: the 31 rows
in REMEDIATE_IDS were resolved and, because LML returned a non-`direct` answer
(`alternative`/`fallback`) for every one — it has no trusted direct match for
these (artist, album) pairs — the run produced **0 repoint / 31 null**, i.e.
all 31 were NULL-and-reset to `tubafrenzy_paste`. Verified: the stale wrong id
is gone from tier-1 for every remediated row, so the picker re-resolves through
the trust-gated tier-3 (`requireSearchType: 'direct'`; album-only for
Various-Artists rows per library.service.ts `isVariousArtistsName`) and returns
either a fresh trusted `direct` match or `[]` — never the old wrong id. (The
non-VA rows resolve `alternative`/`fallback` → `[]`; the 3 VA rows 21491/21527/
21552 take the picker's album-only path, still under the same gate.) Re-running
is safe and idempotent — a row whose id was already cleared no longer matches the
`source = 'discogs_direct_backfill'` guard and is skipped.

Trust-gated repoint (per the #1517 "repoint where unambiguous" decision):
  For each of the 31 confirmed wrong-album rows (the 42 mismatch bucket minus
  the 11 degenerate-reference rows held for MD in #1528), resolve the correct
  release via the SAME path the sanctioned #1519 gated backfill uses:
    POST /api/v1/lookup {raw_message, artist, album}  ->  search_type must be
    'direct' (BS#1516 gate) and results[0].artwork.release_id must be present.
  Extra safety beyond the job: fetch GET /discogs/release/{new_id} and require
  its title to clear the 80 album-match floor before repointing — so a 'direct'
  answer that still points somewhere wrong is distrusted and the row is NULLed
  instead. Outcome per row:
    repoint -> discogs_release_id = <new>, source = 'lml_offline_backfill'
    null    -> discogs_release_id = NULL,  source = 'tubafrenzy_paste'
              (virtual default; the gated backfill / trust-gated tier-3 re-resolves)

Read-only by default (--dry-run): resolves + prints the plan, no UPDATE.
--execute: per-row guarded UPDATE (WHERE id=? AND discogs_release_id=<old>
AND source='discogs_direct_backfill'), SELECT-after, per-row commit.
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from difflib import SequenceMatcher

logger = logging.getLogger("remediate_rotation_release_id")

# Any network/parse failure while resolving or verifying a candidate resolves the
# row to `null` — the stored id is already confirmed wrong, so a transient LML
# hiccup must never crash the run and leave rows unprocessed. Covers
# URLError/HTTPError, socket/OS timeouts (OSError), JSON + UTF-8 decode failures
# (ValueError, parent of JSONDecodeError and UnicodeDecodeError), and a truncated
# body (IncompleteRead, an HTTPException — not an OSError).
_LML_ERRORS = (urllib.error.URLError, OSError, ValueError, http.client.IncompleteRead)

# 42 mismatch (fresh 2026-07-06 run) minus 11 degenerate-reference held for MD
# (8247/8248/8267/8268 Killing Frost, 8276/8277 Tarantula, 15726 Gunther Doug,
#  21533 Beau Wanzer, 21574 underscores, 21583 Setting, 43164 Wendy Eisenberg).
REMEDIATE_IDS = [
    8187, 11325, 11326, 11327, 14824, 14825, 14826, 21456, 21474, 21491, 21492,
    21496, 21497, 21500, 21504, 21509, 21510, 21511, 21525, 21527, 21532, 21536,
    21539, 21540, 21552, 21565, 21567, 21572, 21573, 43155, 43156,
]
ALBUM_MATCH_FLOOR = 80.0

_PAREN_RE = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]\s*")
_WS_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _WS_RE.sub(" ", stripped).casefold().strip()


def strip_parentheticals(text: str) -> str:
    return _WS_RE.sub(" ", _PAREN_RE.sub(" ", text)).strip()


def similarity(a: str, b: str) -> float:
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    raw = SequenceMatcher(None, na, nb).ratio() * 100
    pa, pb = strip_parentheticals(na), strip_parentheticals(nb)
    if pa and pb and (pa != na or pb != nb):
        return max(raw, SequenceMatcher(None, pa, pb).ratio() * 100)
    return raw


# Mirror jobs/rotation-release-id-backfill/lml-fetch.ts decodeHtmlEntities so the
# LML hop sees the same text the sanctioned writer would.
NAMED_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " "}
HTML_ENTITY_RE = re.compile(r"&(#x[0-9a-f]+|#[0-9]+|[a-z]+);", re.IGNORECASE)


def decode_html_entities(text: str) -> str:
    def repl(m: re.Match) -> str:
        body = m.group(1)
        if body[0] != "#":
            return NAMED_ENTITIES.get(body.lower(), m.group(0))
        is_hex = body[1] in ("x", "X")
        cp = int(body[2:], 16) if is_hex else int(body[1:])
        if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
            return m.group(0)
        return chr(cp)

    return HTML_ENTITY_RE.sub(repl, text)


class Lml:
    def __init__(self, base_url: str, api_key: str | None, rate_per_min: float, timeout_s: float):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.min_interval = 60.0 / rate_per_min if rate_per_min > 0 else 0.0
        self.timeout_s = timeout_s
        # -inf so the first _pace() never sleeps (monotonic()'s zero point is
        # arbitrary; seeding 0.0 can spuriously sleep on a freshly-booted host).
        self._last = float("-inf")

    def _pace(self) -> None:
        wait = self.min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def lookup(self, artist: str, album: str) -> dict:
        self._pace()
        raw = " - ".join(x for x in (artist, album) if x)
        body = {"raw_message": raw}
        if artist:
            body["artist"] = artist
        if album:
            body["album"] = album
        req = urllib.request.Request(
            f"{self.base_url}/api/v1/lookup",
            data=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def get_release(self, release_id: int) -> dict | None:
        self._pace()
        req = urllib.request.Request(
            f"{self.base_url}/api/v1/discogs/release/{release_id}", headers=self._headers()
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise


def resolve_plan(ref_artist: str, ref_album: str, lml: Lml) -> tuple[str, int | None, str]:
    """Returns (action, new_release_id, reason). action in {repoint, null}.

    The current stored id is already confirmed wrong-album (the #1517 audit), so
    every outcome that is not a *trusted* direct repoint resolves to `null`:
    trust_rejected (artist-fallback), no_match, sub-80 distrust, or any LML error
    (timeout/network). Leaving a confirmed-wrong id in place is never correct.
    """
    try:
        resp = lml.lookup(decode_html_entities(ref_artist), decode_html_entities(ref_album))
    except _LML_ERRORS as err:
        return "null", None, f"lml_error:{type(err).__name__}"
    if not isinstance(resp, dict):
        # A valid-JSON but non-object body (null / array / scalar error envelope)
        # can't carry a trusted match — degrade to null rather than AttributeError.
        return "null", None, f"lml_bad_response:{type(resp).__name__}"
    search_type = resp.get("search_type")
    # Fully shape-guarded: a truthy-but-wrong-shape `results`/`artwork` (LML
    # returns an object where a list is expected, or a scalar artwork) must
    # degrade to null, not raise KeyError/AttributeError past _LML_ERRORS.
    results = resp.get("results")
    new_id = None
    if isinstance(results, list) and results and isinstance(results[0], dict):
        artwork = results[0].get("artwork")
        if isinstance(artwork, dict):
            new_id = artwork.get("release_id")
    if search_type != "direct":
        return "null", None, f"trust_rejected (search_type={search_type or 'absent'})"
    # `is None or <= 0` (not falsy `not new_id`): 0 is LML's BS#1185 streaming-only
    # sentinel and rotation's CHECK rejects 0/negatives, so neither may be written.
    if not isinstance(new_id, int) or new_id <= 0:
        return "null", None, f"no_match (direct but release_id={new_id})"
    try:
        payload = lml.get_release(new_id)
    except _LML_ERRORS as err:
        return "null", None, f"lml_error_on_verify:{type(err).__name__} (direct->{new_id})"
    title = payload.get("title") if isinstance(payload, dict) else None
    new_title = title if isinstance(title, str) else ""
    score = round(similarity(ref_album, new_title), 1)
    if score >= ALBUM_MATCH_FLOOR:
        return "repoint", new_id, f"direct->{new_id} {new_title!r} score={score}"
    return "null", None, f"distrust direct->{new_id} {new_title!r} score={score}<80"


def self_test() -> int:
    """Unit checks (no DB/LML): every resolve_plan branch with a stubbed Lml —
    including the repoint (accept) and 80-floor distrust paths the 2026-07-06
    run never exercised (it was 0-repoint) — plus similarity + entity-decode."""
    failures = 0

    def check(label: str, actual, expected) -> None:
        nonlocal failures
        ok = actual == expected
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}: {label} = {actual!r} (expected {expected!r})")

    # similarity: empty input floors to 0; parenthetical fallback clears 80.
    check("similarity empty -> 0", similarity("", "DOGA"), 0.0)
    check("similarity paren-fallback >= 80", similarity("Tzenni", "Tzenni (Deluxe Edition)") >= 80.0, True)

    # decode_html_entities: named + numeric decode; surrogate / overflow rejected.
    check("decode named amp", decode_html_entities("Rome&amp;o"), "Rome&o")
    check("decode numeric combining", decode_html_entities("Rome&#769;o"), "Roméo")
    check("decode surrogate rejected", decode_html_entities("x&#xD800;y"), "x&#xD800;y")
    check("decode overflow rejected", decode_html_entities("x&#x110000;y"), "x&#x110000;y")

    class StubLml:
        """Structurally matches Lml.lookup / Lml.get_release for resolve_plan."""

        def __init__(self, lookup_resp=None, release_payload=None, lookup_exc=None, release_exc=None):
            self._lookup_resp = lookup_resp
            self._release_payload = release_payload
            self._lookup_exc = lookup_exc
            self._release_exc = release_exc

        def lookup(self, artist, album):
            if self._lookup_exc:
                raise self._lookup_exc
            return self._lookup_resp

        def get_release(self, release_id):
            if self._release_exc:
                raise self._release_exc
            return self._release_payload

    def direct(rid):
        return {"search_type": "direct", "results": [{"artwork": {"release_id": rid}}]}

    # direct + verified title >= 80 -> repoint to the new id
    action, new_id, _ = resolve_plan("Juana Molina", "DOGA", StubLml(direct(111), {"title": "DOGA"}))
    check("direct high-score action", action, "repoint")
    check("direct high-score new_id", new_id, 111)

    # direct + verified title < 80 -> distrust -> null
    action, new_id, reason = resolve_plan("Yenbett", "Yenbett", StubLml(direct(222), {"title": "Tzenni"}))
    check("direct low-score action", action, "null")
    check("direct low-score new_id", new_id, None)
    check("direct low-score reason", "distrust" in reason, True)

    # non-direct search_type -> trust_rejected -> null (never persist a fallback)
    action, _, reason = resolve_plan("A", "B", StubLml({"search_type": "alternative", "results": [{"artwork": {"release_id": 333}}]}))
    check("alternative action", action, "null")
    check("alternative reason", "trust_rejected" in reason, True)

    # direct but no release_id -> no_match -> null
    action, _, reason = resolve_plan("A", "B", StubLml({"search_type": "direct", "results": [{"artwork": {"release_id": None}}]}))
    check("no-release-id action", action, "null")
    check("no-release-id reason", "no_match" in reason, True)

    # lookup throws -> lml_error -> null (leave the confirmed-wrong id NULLed)
    action, _, reason = resolve_plan("A", "B", StubLml(lookup_exc=TimeoutError("t")))
    check("lookup-error action", action, "null")
    check("lookup-error reason", "lml_error" in reason, True)

    # verify (get_release) throws -> lml_error_on_verify -> null
    action, _, reason = resolve_plan("A", "B", StubLml(direct(444), release_exc=TimeoutError("t")))
    check("verify-error action", action, "null")
    check("verify-error reason", "lml_error_on_verify" in reason, True)

    # non-object lookup body (JSON null / array) -> null, no AttributeError crash
    action, _, reason = resolve_plan("A", "B", StubLml(None))
    check("null-response action", action, "null")
    check("null-response reason", "lml_bad_response" in reason, True)
    action, _, _ = resolve_plan("A", "B", StubLml(["not", "an", "object"]))
    check("array-response action", action, "null")

    # direct with release_id 0 (BS#1185 sentinel) or negative -> no_match -> null
    action, _, reason = resolve_plan("A", "B", StubLml(direct(0)))
    check("sentinel-zero action", action, "null")
    check("sentinel-zero reason", "no_match" in reason, True)
    action, _, _ = resolve_plan("A", "B", StubLml(direct(-5)))
    check("negative-id action", action, "null")

    # direct + non-dict release payload -> empty title -> distrust null, no crash
    action, _, _ = resolve_plan("A", "B", StubLml(direct(555), release_payload=["oops"]))
    check("non-dict-payload action", action, "null")

    # malformed truthy shapes: non-list results, scalar artwork -> null, no crash
    action, _, _ = resolve_plan("A", "B", StubLml({"search_type": "direct", "results": {"0": {}}}))
    check("non-list-results action", action, "null")
    action, _, _ = resolve_plan("A", "B", StubLml({"search_type": "direct", "results": [{"artwork": "oops"}]}))
    check("scalar-artwork action", action, "null")

    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--execute", action="store_true", help="issue guarded UPDATEs (default is dry-run)")
    ap.add_argument("--rate-per-min", type=float, default=20.0)
    ap.add_argument("--timeout-s", type=float, default=30.0)
    ap.add_argument("--self-test", action="store_true", help="run resolve/scoring self-tests and exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.self_test:
        return self_test()

    lml_url = os.environ.get("LIBRARY_METADATA_URL")
    if not lml_url:
        logger.error("LIBRARY_METADATA_URL required")
        return 2

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
        lml = Lml(lml_url, os.environ.get("LML_API_KEY"), args.rate_per_min, args.timeout_s)

        # SELECT-before: live current state + reference (freetext else catalog).
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT r.id, r.discogs_release_id, r.discogs_release_id_source,
                       COALESCE(NULLIF(btrim(r.artist_name), ''), l.artist_name) AS ref_artist,
                       COALESCE(NULLIF(btrim(r.album_title), ''), l.album_title) AS ref_album
                FROM wxyc_schema.rotation r
                LEFT JOIN wxyc_schema.library l ON l.id = r.album_id
                WHERE r.id = ANY(%s)
                ORDER BY r.id ASC
                """,
                (REMEDIATE_IDS,),
            )
            rows = cur.fetchall()
        # End the read transaction before the multi-minute, rate-limited LML loop.
        # With autocommit=False the SELECT above opened a txn; holding it idle across
        # the network phase risks a managed-PG idle_in_transaction_session_timeout
        # killing the session (aborting the first --execute UPDATE) and needlessly
        # pins a snapshot against VACUUM.
        conn.rollback()

        found = {row[0] for row in rows}
        missing = [i for i in REMEDIATE_IDS if i not in found]
        if missing:
            logger.warning("ids not found in rotation: %s", missing)

        plans, skipped = [], []
        for rid, old_id, source, ref_artist, ref_album in rows:
            if source != "discogs_direct_backfill" or old_id is None:
                skipped.append((rid, f"state changed (source={source}, id={old_id}) — not touching"))
                continue
            action, new_id, reason = resolve_plan(ref_artist or "", ref_album or "", lml)
            plans.append((rid, old_id, new_id, action, ref_artist, ref_album, reason))
            logger.info("[plan] rotation_id=%d %s: %s (%s — %s)", rid, action.upper(), reason, ref_artist, ref_album)

        repoint = [p for p in plans if p[3] == "repoint"]
        nulls = [p for p in plans if p[3] == "null"]
        logger.info("PLAN SUMMARY: %d repoint, %d null, %d skipped (of %d)", len(repoint), len(nulls), len(skipped), len(rows))
        for rid, why in skipped:
            logger.warning("  skipped rotation_id=%d: %s", rid, why)

        if not args.execute:
            logger.info("DRY-RUN: no UPDATEs issued. Re-run with --execute to apply.")
            _print_plan_table(plans, skipped)
            return 0

        applied = []
        try:
            with conn.cursor() as cur:
                for rid, old_id, new_id, action, *_ in plans:
                    if action == "repoint":
                        cur.execute(
                            """UPDATE wxyc_schema.rotation
                                  SET discogs_release_id = %s, discogs_release_id_source = 'lml_offline_backfill'
                                WHERE id = %s AND discogs_release_id = %s
                                  AND discogs_release_id_source = 'discogs_direct_backfill'""",
                            (new_id, rid, old_id),
                        )
                    else:
                        cur.execute(
                            """UPDATE wxyc_schema.rotation
                                  SET discogs_release_id = NULL, discogs_release_id_source = 'tubafrenzy_paste'
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
                        "SELECT discogs_release_id, discogs_release_id_source FROM wxyc_schema.rotation WHERE id = %s", (rid,)
                    )
                    after = cur.fetchone()
                    conn.commit()
                    applied.append((rid, action, old_id, new_id, f"after={after[0]}/{after[1]}"))
                    logger.info("[applied] rotation_id=%d %s old=%s -> %s", rid, action.upper(), old_id, after)
        finally:
            # Always surface what was mutated: if a mid-loop DB error aborts the run,
            # the applied-so-far list is the provenance the operator needs.
            _print_plan_table(plans, skipped, applied)

        logger.info("EXECUTE DONE: %d rows processed", len(applied))
        return 0
    finally:
        conn.close()


def _print_plan_table(plans, skipped, applied=None) -> None:
    print("\n| rotation_id | action | old_id | new_id | reference | reason |")
    print("|---|---|---|---|---|---|")
    for rid, old_id, new_id, action, ref_artist, ref_album, reason in plans:
        print(f"| {rid} | {action} | {old_id} | {new_id or ''} | {ref_artist} — {ref_album} | {reason} |")
    if skipped:
        print("\nSkipped:")
        for rid, why in skipped:
            print(f"  {rid}: {why}")
    if applied:
        print("\nApplied:")
        for row in applied:
            print(f"  {row}")


if __name__ == "__main__":
    sys.exit(main())
