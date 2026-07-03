"""Audit stored ``rotation.discogs_release_id`` values for wrong-album pollution (#1517).

Motivation: ``jobs/rotation-release-id-backfill`` persisted LML lookup answers
without a ``search_type`` trust gate until #1516/#1519, so an artist-fallback
answer (``search_type: "alternative"``) could store a *different album's*
Discogs release id on a rotation row. Tier 1 of ``resolveRotationPickerSource``
then serves that id deterministically — the runtime #1351 gate never re-checks
stored ids. Confirmed instance: rotation row 21529 ("Yenbett" by Noura Mint
Seymali) stored 5879935 = "Tzenni" (2014); see #1515.

Nothing in the schema records which ``search_type`` produced a stored id, so
pollution is detected by comparing each stored release's *actual* Discogs
title/artist (via LML's ``GET /api/v1/discogs/release/{id}``, which fronts the
discogs-cache — never the Discogs API directly) against the rotation row's
``album_title``/``artist_name``.

Verdict buckets (album-title similarity, 0-100, after normalization):
    ok        >= 80  (consistent with LML's ``_ALBUM_MATCH_FLOOR = 80.0``)
    suspect   60-79  (triage by hand: diacritics, edition suffixes, split titles)
    mismatch  <  60  (candidate for remediation per #1517)

A parenthetical-stripped secondary score is taken when it improves the match,
so "Tzenni (Deluxe Edition)" vs "Tzenni" lands in ``ok`` rather than
``suspect``.

Read-only: never issues UPDATE / DELETE. Remediation is a separate, manual,
row-by-row step gated on #1516 having merged (an ungated backfill re-run would
re-pollute NULLed rows).

LML pacing follows the BACKFILL_LML_* safety story (BS#995): sequential calls,
default 20/min token spacing, per-call timeout. For the few-hundred-row active
rotation set that is ~15 min wall time.

Output:
    CSV, one row per audited rotation row:
        rotation_id, artist_name, album_title, discogs_release_id, source,
        release_title, release_artists, album_score, artist_score, verdict, note
    Markdown summary: bucket counts per source + the full mismatch/suspect lists.

Usage:
    DB_HOST=... DB_PORT=5432 DB_USERNAME=... DB_PASSWORD=... DB_NAME=wxyc_db \\
    LIBRARY_METADATA_URL=https://library-metadata-lookup-production.up.railway.app \\
    LML_API_KEY=... \\
    python3 scripts/audit/bs_rotation_release_id_pollution.py \\
        --csv audit/rotation_release_id_pollution.csv \\
        --summary audit/rotation_release_id_pollution.md

    # Source buckets audited by default (priority order per #1517):
    #   lml_offline_backfill     (ungated LML writer, priority 1)
    #   discogs_direct_backfill  (2026-05-29 bypass-LML rescue, priority 2)
    # Add MD-verified paste rows too with:
    #   --sources lml_offline_backfill,discogs_direct_backfill,tubafrenzy_paste
    # Include killed rotation rows with --include-killed.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from difflib import SequenceMatcher

# psycopg imported lazily so the scoring helpers are unit-testable without a driver.

logger = logging.getLogger("rotation_release_id_pollution")

DEFAULT_SOURCES = "lml_offline_backfill,discogs_direct_backfill"
ALBUM_MATCH_FLOOR = 80.0  # mirrors LML lookup/orchestrator.py _ALBUM_MATCH_FLOOR
SUSPECT_FLOOR = 60.0

_PAREN_RE = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]\s*")
_WS_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Casefold, strip diacritics (NFKD), collapse whitespace.

    Mirrors the normalization family used across the org's matching code so a
    diacritic-only difference (e.g. "Guereh" vs "Guéreh") never lands a row in
    ``suspect``.
    """
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _WS_RE.sub(" ", stripped).casefold().strip()


def strip_parentheticals(text: str) -> str:
    """Drop (…) / […] runs so edition suffixes don't depress the score."""
    return _WS_RE.sub(" ", _PAREN_RE.sub(" ", text)).strip()


def similarity(a: str, b: str) -> float:
    """0-100 similarity on normalized strings; best of raw and paren-stripped."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    raw = SequenceMatcher(None, na, nb).ratio() * 100
    pa, pb = strip_parentheticals(na), strip_parentheticals(nb)
    if pa and pb and (pa != na or pb != nb):
        stripped = SequenceMatcher(None, pa, pb).ratio() * 100
        return max(raw, stripped)
    return raw


def verdict_for(album_score: float) -> str:
    if album_score >= ALBUM_MATCH_FLOOR:
        return "ok"
    if album_score >= SUSPECT_FLOOR:
        return "suspect"
    return "mismatch"


@dataclass
class AuditRow:
    rotation_id: int
    artist_name: str
    album_title: str
    discogs_release_id: int
    source: str
    release_title: str = ""
    release_artists: str = ""
    album_score: float = 0.0
    artist_score: float = 0.0
    verdict: str = "error"
    note: str = ""


def fetch_candidates(conn, sources: list[str], include_killed: bool) -> list[AuditRow]:
    predicate = "" if include_killed else "AND (r.kill_date IS NULL OR r.kill_date > CURRENT_DATE)"
    sql = f"""
        SELECT r.id, r.artist_name, r.album_title, r.discogs_release_id,
               r.discogs_release_id_source
        FROM wxyc_schema.rotation r
        WHERE r.discogs_release_id IS NOT NULL
          AND r.discogs_release_id_source = ANY(%s)
          {predicate}
        ORDER BY r.id ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql, (sources,))
        rows = cur.fetchall()
    return [
        AuditRow(
            rotation_id=row[0],
            artist_name=row[1] or "",
            album_title=row[2] or "",
            discogs_release_id=row[3],
            source=row[4],
        )
        for row in rows
    ]


class LmlReleaseClient:
    """Minimal LML release fetcher with bearer auth, timeout, and rate spacing."""

    def __init__(self, base_url: str, api_key: str | None, rate_per_min: float, timeout_s: float):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.min_interval = 60.0 / rate_per_min if rate_per_min > 0 else 0.0
        self.timeout_s = timeout_s
        self._last_call = 0.0

    def get_release(self, release_id: int) -> tuple[dict | None, str]:
        """Returns (payload, note). payload None => note explains (404 vs error)."""
        wait = self.min_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

        request = urllib.request.Request(f"{self.base_url}/api/v1/discogs/release/{release_id}")
        if self.api_key:
            request.add_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                return json.loads(response.read().decode("utf-8")), ""
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None, "release_not_found_in_lml"
            return None, f"lml_http_{err.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            return None, f"lml_error:{type(err).__name__}"


def extract_release_fields(payload: dict) -> tuple[str, str]:
    """Pull (title, joined artist names) defensively from the LML release payload."""
    title = payload.get("title") or ""
    artists = payload.get("artists") or []
    names = []
    for artist in artists:
        if isinstance(artist, dict):
            name = artist.get("name") or artist.get("artist_name") or ""
        else:
            name = str(artist)
        if name:
            names.append(name)
    return title, ", ".join(names)


def audit(rows: list[AuditRow], client: LmlReleaseClient) -> None:
    total = len(rows)
    for index, row in enumerate(rows, start=1):
        payload, note = client.get_release(row.discogs_release_id)
        if payload is None:
            row.verdict = "error"
            row.note = note
            logger.warning(
                "[%d/%d] rotation_id=%d release_id=%d -> %s",
                index, total, row.rotation_id, row.discogs_release_id, note,
            )
            continue
        row.release_title, row.release_artists = extract_release_fields(payload)
        row.album_score = round(similarity(row.album_title, row.release_title), 1)
        row.artist_score = round(similarity(row.artist_name, row.release_artists), 1)
        row.verdict = verdict_for(row.album_score)
        if row.verdict != "ok":
            logger.info(
                "[%d/%d] rotation_id=%d %s: typed=%r stored release=%r album_score=%.1f",
                index, total, row.rotation_id, row.verdict.upper(),
                row.album_title, row.release_title, row.album_score,
            )
        elif index % 25 == 0:
            logger.info("[%d/%d] progress: last ok rotation_id=%d", index, total, row.rotation_id)


def write_csv(rows: list[AuditRow], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "rotation_id", "artist_name", "album_title", "discogs_release_id", "source",
            "release_title", "release_artists", "album_score", "artist_score", "verdict", "note",
        ])
        for row in rows:
            writer.writerow([
                row.rotation_id, row.artist_name, row.album_title, row.discogs_release_id,
                row.source, row.release_title, row.release_artists, row.album_score,
                row.artist_score, row.verdict, row.note,
            ])


def write_summary(rows: list[AuditRow], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    by_source: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = by_source.setdefault(row.source, {"ok": 0, "suspect": 0, "mismatch": 0, "error": 0})
        bucket[row.verdict] += 1

    lines = ["# rotation.discogs_release_id pollution audit (#1517)", ""]
    lines.append("| source | ok | suspect | mismatch | error | total |")
    lines.append("|---|---|---|---|---|---|")
    for source, bucket in sorted(by_source.items()):
        total = sum(bucket.values())
        lines.append(
            f"| {source} | {bucket['ok']} | {bucket['suspect']} | {bucket['mismatch']} | {bucket['error']} | {total} |"
        )
    for verdict in ("mismatch", "suspect", "error"):
        matching = [row for row in rows if row.verdict == verdict]
        if not matching:
            continue
        lines += ["", f"## {verdict} rows", ""]
        lines.append("| rotation_id | source | typed artist — album | stored release (artist — title) | album_score | note |")
        lines.append("|---|---|---|---|---|---|")
        for row in matching:
            lines.append(
                f"| {row.rotation_id} | {row.source} | {row.artist_name} — {row.album_title} | "
                f"{row.release_artists} — {row.release_title} (release {row.discogs_release_id}) | "
                f"{row.album_score} | {row.note} |"
            )
    lines += [
        "",
        "Remediation (manual, per #1517; blocked on #1516 being merged): repoint the row when the",
        "correct release is unambiguous, else NULL `discogs_release_id` + reset",
        "`discogs_release_id_source` to 'tubafrenzy_paste' so the trust-gated backfill re-resolves it.",
        "SELECT-before-UPDATE with `WHERE id = ? AND discogs_release_id = ?` guards.",
        "",
    ]
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def self_test() -> int:
    """Sanity checks for the pure helpers (no DB/LML needed): exercises the
    confirmed #1515 pair and the normalization edge cases the buckets rely on."""
    cases = [
        ("Yenbett", "Tzenni", "mismatch"),
        ("Tzenni", "Tzenni", "ok"),
        ("Tzenni", "Tzenni (Deluxe Edition)", "ok"),
        ("Guereh", "Guéreh", "ok"),
        ("On Your Own Love Again", "On Your Own Love Again", "ok"),
    ]
    failures = 0
    for typed, stored, expected in cases:
        score = similarity(typed, stored)
        actual = verdict_for(score)
        status = "PASS" if actual == expected else "FAIL"
        if actual != expected:
            failures += 1
        print(f"{status}: similarity({typed!r}, {stored!r}) = {score:.1f} -> {actual} (expected {expected})")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", default="audit/rotation_release_id_pollution.csv")
    parser.add_argument("--summary", default="audit/rotation_release_id_pollution.md")
    parser.add_argument("--sources", default=DEFAULT_SOURCES, help="comma-separated discogs_release_id_source values")
    parser.add_argument("--include-killed", action="store_true", help="audit killed rotation rows too")
    parser.add_argument("--rate-per-min", type=float, default=20.0, help="LML call pacing (BS#995 default 20)")
    parser.add_argument("--timeout-s", type=float, default=15.0, help="per-LML-call timeout")
    parser.add_argument("--limit", type=int, default=0, help="audit only the first N rows (0 = all)")
    parser.add_argument("--self-test", action="store_true", help="run scoring self-tests and exit")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.self_test:
        return self_test()

    lml_url = os.environ.get("LIBRARY_METADATA_URL")
    if not lml_url:
        logger.error("LIBRARY_METADATA_URL is required")
        return 2

    import psycopg  # lazy: scoring helpers stay importable without a driver

    conn = psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USERNAME", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
        dbname=os.environ.get("DB_NAME", "wxyc_db"),
    )
    try:
        sources = [source.strip() for source in args.sources.split(",") if source.strip()]
        rows = fetch_candidates(conn, sources, args.include_killed)
    finally:
        conn.close()

    if args.limit > 0:
        rows = rows[: args.limit]
    logger.info("auditing %d rotation rows (sources: %s)", len(rows), ", ".join(sources))

    client = LmlReleaseClient(lml_url, os.environ.get("LML_API_KEY"), args.rate_per_min, args.timeout_s)
    audit(rows, client)

    write_csv(rows, args.csv)
    write_summary(rows, args.summary)

    counts = {verdict: sum(1 for row in rows if row.verdict == verdict) for verdict in ("ok", "suspect", "mismatch", "error")}
    logger.info(
        "done: %d rows -> ok=%d suspect=%d mismatch=%d error=%d; csv=%s summary=%s",
        len(rows), counts["ok"], counts["suspect"], counts["mismatch"], counts["error"], args.csv, args.summary,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
