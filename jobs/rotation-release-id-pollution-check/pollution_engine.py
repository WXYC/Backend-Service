"""Audit stored ``rotation.discogs_release_id`` values for wrong-album pollution (#1517).

Canonical home (#1522): this module lives inside ``jobs/rotation-release-id-pollution-check``
so the weekly scheduled check (``job.py``) imports the scoring literally — never a copy —
and so engine edits mark the job affected for auto-deploy (Turborepo only tracks files
inside the package dir) and are gated by the Dockerfile's build-time ``--self-test`` run.
Ad-hoc/manual usage is preserved by the thin wrapper left behind at
``scripts/audit/bs_rotation_release_id_pollution.py``.

Motivation: ``jobs/rotation-release-id-backfill`` persisted LML lookup answers
without a ``search_type`` trust gate until #1516/#1519, so an artist-fallback
answer (``search_type: "alternative"``) could store a *different album's*
Discogs release id on a rotation row. Tier 1 of ``resolveRotationPickerSource``
then serves that id deterministically — the runtime #1351 gate never re-checks
stored ids. Confirmed instance: rotation row 21529 ("Yenbett" by Noura Mint
Seymali) stored 5879935 = "Tzenni" (2014); see #1515.

Nothing in the schema records which ``search_type`` produced a stored id, so
pollution is detected by comparing each stored release's *actual* Discogs title
(via LML's ``GET /api/v1/discogs/release/{id}``, which fronts the discogs-cache
— never the Discogs API directly) against the rotation row's album title.

Reference resolution (#1523 defect 1): the rotation row's identity lives in one
of two places. Rows added with a free-text form carry ``artist_name`` /
``album_title`` directly; catalog-linked rows leave those NULL and identify the
album only through ``album_id -> library.id``. The first prod run compared an
empty free-text title for the 115/208 catalog-linked ``discogs_direct_backfill``
rows and flagged every one as a spurious mismatch. We therefore resolve the
reference title as ``COALESCE(NULLIF(btrim(rotation.album_title), ''),
library.album_title)`` via a LEFT JOIN on ``album_id`` (the ``title_source``
column records ``freetext`` vs ``catalog``).

Artist axis (#1523 defect 2): the discogs-cache-backed release payload carries
no artist for the releases these rows point at (``artist: ''``, ``artists: []``),
so the right-artist/wrong-album cross-check cannot fire. Rather than emit a
misleading ``artist_score = 0.0`` for every row, ``artist_score`` is left blank
(with a ``release_no_artist`` note) whenever the payload has no artist. The
reference artist is still sourced from ``rotation.artist_name`` / catalog so the
axis lights up automatically if a future cache re-warm ever populates it.
Album-title similarity is the load-bearing signal.

Verdict buckets (album-title similarity, 0-100, after normalization):
    ok        >= 80  (consistent with LML's ``_ALBUM_MATCH_FLOOR = 80.0``)
    suspect   60-79  (advisory-only: in the 2026-07-05 calibration this band was
                      100% false-positive — non-Latin romanization appended to
                      the Discogs title and edition/mixtape suffixes. #1522's
                      recurring alert should fire on ``mismatch`` only.)
    mismatch  <  60  (candidate for remediation per #1517)
    error            (LML fetch failed, or neither side has a title to compare)

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
        rotation_id, source, album_id, artist_name, album_title,
        ref_artist, ref_album, title_source, discogs_release_id,
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


def resolve_reference(
    rot_artist: str | None,
    rot_album: str | None,
    lib_artist: str | None,
    lib_album: str | None,
) -> tuple[str, str, str]:
    """Resolve the (artist, album, title_source) to score a stored release against.

    Rotation free-text wins when present; otherwise fall back to the catalog row
    reached via ``rotation.album_id -> library.id`` (#1523 defect 1). Without the
    catalog fallback, the 115/208 audited ``discogs_direct_backfill`` rows that
    carry ``artist_name = album_title = NULL`` scored an empty string against the
    release title and were flagged as false mismatches.

    Returns ``title_source`` = ``"freetext"`` | ``"catalog"`` | ``"none"``.
    """
    rot_album_s = (rot_album or "").strip()
    lib_album_s = (lib_album or "").strip()
    if rot_album_s:
        ref_album, title_source = rot_album_s, "freetext"
    elif lib_album_s:
        ref_album, title_source = lib_album_s, "catalog"
    else:
        ref_album, title_source = "", "none"
    ref_artist = (rot_artist or "").strip() or (lib_artist or "").strip()
    return ref_artist, ref_album, title_source


def _append_note(existing: str, addition: str) -> str:
    return f"{existing}; {addition}" if existing else addition


@dataclass
class AuditRow:
    rotation_id: int
    artist_name: str  # raw rotation.artist_name (may be blank for catalog-linked rows)
    album_title: str  # raw rotation.album_title (may be blank for catalog-linked rows)
    discogs_release_id: int
    source: str
    album_id: int | None = None
    ref_artist: str = ""  # scored artist: rotation free-text else library.artist_name (#1523 defect 2)
    ref_album: str = ""  # scored album: rotation free-text else library.album_title (#1523 defect 1)
    title_source: str = ""  # "freetext" | "catalog" | "none"
    release_title: str = ""
    release_artists: str = ""
    album_score: float = 0.0
    artist_score: float | None = None  # None => release payload carried no artist (#1523 defect 2)
    verdict: str = "error"
    note: str = ""


def fetch_candidates(conn, sources: list[str], include_killed: bool) -> list[AuditRow]:
    predicate = "" if include_killed else "AND (r.kill_date IS NULL OR r.kill_date > CURRENT_DATE)"
    # LEFT JOIN library so catalog-linked rows (artist_name = album_title = NULL,
    # identity via album_id) get a reference title to score against (#1523 defect 1).
    sql = f"""
        SELECT r.id, r.artist_name, r.album_title, r.discogs_release_id,
               r.discogs_release_id_source, r.album_id,
               l.artist_name AS lib_artist, l.album_title AS lib_album
        FROM wxyc_schema.rotation r
        LEFT JOIN wxyc_schema.library l ON l.id = r.album_id
        WHERE r.discogs_release_id IS NOT NULL
          AND r.discogs_release_id_source = ANY(%s)
          {predicate}
        ORDER BY r.id ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql, (sources,))
        rows = cur.fetchall()
    audit_rows: list[AuditRow] = []
    for row in rows:
        rot_id, rot_artist, rot_album, release_id, source, album_id, lib_artist, lib_album = row
        ref_artist, ref_album, title_source = resolve_reference(rot_artist, rot_album, lib_artist, lib_album)
        audit_rows.append(
            AuditRow(
                rotation_id=rot_id,
                artist_name=rot_artist or "",
                album_title=rot_album or "",
                discogs_release_id=release_id,
                source=source,
                album_id=album_id,
                ref_artist=ref_artist,
                ref_album=ref_album,
                title_source=title_source,
            )
        )
    return audit_rows


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
    """Pull (title, joined artist names) defensively from the LML release payload.

    The discogs-cache-backed ``GET /api/v1/discogs/release/{id}`` payload does not
    carry artist for the releases these rotation rows point at — ``artists`` is
    ``[]`` and the scalar ``artist`` is ``''`` (#1523 defect 2). We still read
    every plausible artist field so the axis lights up if a future cache re-warm
    populates it, but an empty return means "no release-side artist available",
    which the caller must treat as blank rather than a zero-similarity signal.
    """
    title = payload.get("title") or ""
    names = []
    for artist in payload.get("artists") or []:
        if isinstance(artist, dict):
            name = artist.get("name") or artist.get("artist_name") or ""
        else:
            name = str(artist)
        if name:
            names.append(name)
    if not names:
        scalar = payload.get("artist") or payload.get("artist_name") or ""
        if isinstance(scalar, str) and scalar.strip():
            names.append(scalar.strip())
    return title, ", ".join(names)


def audit(rows: list[AuditRow], client: LmlReleaseClient, before_row=None) -> None:
    """Score each row's stored release against its reference title.

    ``before_row`` (#1522): optional zero-arg callback invoked before each row's
    LML fetch. The scheduled job injects its cooperative-pause probe (BS#735)
    here so the engine stays free of DB/pause concerns and remains importable
    and self-testable unchanged. Default is a no-op.
    """
    total = len(rows)
    for index, row in enumerate(rows, start=1):
        if before_row is not None:
            before_row()
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
        row.album_score = round(similarity(row.ref_album, row.release_title), 1)
        if row.ref_artist and row.release_artists:
            row.artist_score = round(similarity(row.ref_artist, row.release_artists), 1)
        else:
            # A missing artist on either side — a blank reference (both rotation
            # and library artist NULL) or a payload with no artist (see
            # extract_release_fields) — leaves the axis blank rather than a
            # misleading 0.0 (#1523 defect 2).
            row.artist_score = None
            row.note = _append_note(
                row.note, "release_no_artist" if not row.release_artists else "reference_no_artist"
            )
        if not row.ref_album:
            # No free-text and no catalog title — unauditable, not a mismatch.
            row.verdict = "error"
            row.note = _append_note(row.note, "no_reference_title")
        elif not row.release_title:
            # Fetched, but the cached release carries no title — unverifiable,
            # not a mismatch (symmetric to the no_reference_title guard, #1523).
            row.verdict = "error"
            row.note = _append_note(row.note, "release_no_title")
        else:
            row.verdict = verdict_for(row.album_score)
        if row.verdict != "ok":
            logger.info(
                "[%d/%d] rotation_id=%d %s: ref=%r (%s) stored release=%r album_score=%.1f",
                index, total, row.rotation_id, row.verdict.upper(),
                row.ref_album, row.title_source, row.release_title, row.album_score,
            )
        elif index % 25 == 0:
            logger.info("[%d/%d] progress: last ok rotation_id=%d", index, total, row.rotation_id)


def write_csv(rows: list[AuditRow], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "rotation_id", "source", "album_id", "artist_name", "album_title",
            "ref_artist", "ref_album", "title_source", "discogs_release_id",
            "release_title", "release_artists", "album_score", "artist_score",
            "verdict", "note",
        ])
        for row in rows:
            writer.writerow([
                row.rotation_id, row.source, row.album_id, row.artist_name, row.album_title,
                row.ref_artist, row.ref_album, row.title_source, row.discogs_release_id,
                row.release_title, row.release_artists, row.album_score,
                "" if row.artist_score is None else row.artist_score,
                row.verdict, row.note,
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
    lines += [
        "",
        "**Reference resolution (#1523):** the album is scored against rotation free-text when present, "
        "else the catalog row via `album_id -> library` (`title_source` column records which). Rows with no "
        "reference title — or a release payload with no title — are marked `error` "
        "(`no_reference_title` / `release_no_title`), not `mismatch`.",
        "",
        "**Artist axis:** LML `GET /discogs/release/{id}` carries no artist for these discogs-cache-backed "
        "releases, so `artist_score` is blank (`release_no_artist`) rather than a misleading 0.0. Album-title "
        "similarity is the load-bearing signal.",
        "",
        "**Suspect band (60-79) is advisory-only.** In the 2026-07-05 calibration it was 100% false-positive "
        "(non-Latin romanization appended to the Discogs title; edition/mixtape suffixes). Recurring alerting "
        "(#1522) should fire on `mismatch` only.",
    ]
    for verdict in ("mismatch", "suspect", "error"):
        matching = [row for row in rows if row.verdict == verdict]
        if not matching:
            continue
        lines += ["", f"## {verdict} rows", ""]
        lines.append("| rotation_id | source | title_src | reference (artist — album) | stored release (artist — title) | album_score | note |")
        lines.append("|---|---|---|---|---|---|---|")
        for row in matching:
            release_artist = row.release_artists or "(no artist in payload)"
            lines.append(
                f"| {row.rotation_id} | {row.source} | {row.title_source} | "
                f"{row.ref_artist} — {row.ref_album} | "
                f"{release_artist} — {row.release_title} (release {row.discogs_release_id}) | "
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
    """Sanity checks (no DB/LML needed): the confirmed #1515 pair + normalization
    edge cases, the #1523 catalog-join reference fallback, the empty-release-artist
    payload shape, and the audit() classification guards that keep an unverifiable
    row out of the mismatch bucket (empty release title / blank reference artist)."""
    failures = 0

    def check(label: str, actual, expected) -> None:
        nonlocal failures
        ok = actual == expected
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}: {label} = {actual!r} (expected {expected!r})")

    # 1. scoring -> verdict buckets
    for typed, stored, expected in [
        ("Yenbett", "Tzenni", "mismatch"),
        ("Tzenni", "Tzenni", "ok"),
        ("Tzenni", "Tzenni (Deluxe Edition)", "ok"),
        ("Guereh", "Guéreh", "ok"),
        ("On Your Own Love Again", "On Your Own Love Again", "ok"),
    ]:
        score = similarity(typed, stored)
        check(f"verdict_for(similarity({typed!r}, {stored!r})={score:.1f})", verdict_for(score), expected)

    # 2. reference resolution (#1523 defect 1: album_id -> library fallback)
    for args_in, expected in [
        (("Cat Power", "Moon Pix", "Cat Power", "The Greatest"), ("Cat Power", "Moon Pix", "freetext")),
        ((None, None, "Juana Molina", "DOGA"), ("Juana Molina", "DOGA", "catalog")),
        (("  ", "  ", "Stereolab", "Dots and Loops"), ("Stereolab", "Dots and Loops", "catalog")),
        ((None, None, None, None), ("", "", "none")),
    ]:
        check(f"resolve_reference{args_in}", resolve_reference(*args_in), expected)

    # 3. release-field extraction (#1523 defect 2: empty-artist payload)
    for payload, expected in [
        ({"title": "Sun", "artists": [], "artist": ""}, ("Sun", "")),
        ({"title": "DOGA", "artists": [{"name": "Juana Molina"}]}, ("DOGA", "Juana Molina")),
        ({"title": "Edits", "artist": "Chuquimamani-Condori"}, ("Edits", "Chuquimamani-Condori")),
    ]:
        check(f"extract_release_fields({payload})", extract_release_fields(payload), expected)

    # 4. audit() classification guards (#1523): a catalog-linked hit scores ok,
    #    while an empty release title or a blank reference artist stay out of the
    #    mismatch bucket (error / blank axis) rather than firing a false positive.
    class _StubClient:
        def __init__(self, payload: dict | None):
            self._payload = payload

        def get_release(self, _release_id: int) -> tuple[dict | None, str]:
            return self._payload, ""

    def run_audit(ref_artist: str, ref_album: str, payload: dict | None) -> AuditRow:
        row = AuditRow(
            rotation_id=1, artist_name=ref_artist, album_title=ref_album,
            discogs_release_id=1, source="test",
            ref_artist=ref_artist, ref_album=ref_album, title_source="catalog",
        )
        audit([row], _StubClient(payload))  # _StubClient structurally matches LmlReleaseClient
        return row

    ok_row = run_audit("Juana Molina", "DOGA", {"title": "DOGA", "artists": [{"name": "Juana Molina"}]})
    check("audit catalog-linked verdict", ok_row.verdict, "ok")
    check("audit catalog-linked album_score", ok_row.album_score, 100.0)

    no_title = run_audit("Cat Power", "Moon Pix", {"title": "", "artists": []})
    check("audit empty-release-title verdict", no_title.verdict, "error")
    check("audit empty-release-title note", "release_no_title" in no_title.note, True)

    no_ref_artist = run_audit("", "Sun", {"title": "Sun", "artist": "Cat Power"})
    check("audit blank-reference-artist verdict", no_ref_artist.verdict, "ok")
    check("audit blank-reference-artist artist_score", no_ref_artist.artist_score, None)
    check("audit blank-reference-artist note", "reference_no_artist" in no_ref_artist.note, True)

    no_ref_title = run_audit("", "", {"title": "Dots and Loops", "artists": []})
    check("audit no-reference-title verdict", no_ref_title.verdict, "error")
    check("audit no-reference-title note", "no_reference_title" in no_ref_title.note, True)

    # 5. before_row hook (#1522): invoked exactly once per row, before the fetch.
    hook_calls = []
    hook_rows = [
        AuditRow(rotation_id=i, artist_name="a", album_title="b", discogs_release_id=i,
                 source="test", ref_artist="a", ref_album="b", title_source="freetext")
        for i in (1, 2, 3)
    ]
    audit(hook_rows, _StubClient({"title": "b", "artists": []}), before_row=lambda: hook_calls.append(1))
    check("audit before_row hook call count", len(hook_calls), 3)

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
