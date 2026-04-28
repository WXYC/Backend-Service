#!/usr/bin/env python3
"""Convert a (artist_name, album_title, library_id) stamps CSV into a single
transactional SQL script that joins the stamps to wxyc_schema.flowsheet on
exact text equality and writes album_id + linkage metadata.

Used by the B-2.2 sister scripts (discogs-bridge-flowsheet.sql and
fuzzy-trigram-flowsheet.sql) to ship locally-computed stamps to prod RDS
without round-tripping through scripts/query-flowsheet.sh — the resulting
SQL is too large for ssh's inline command buffer, so we emit a file, scp
it to EC2, and feed it to psql via docker mount.

The output starts with ROLLBACK so the first run is a dry-run; pass
--commit to flip it to COMMIT.

Usage:
  python3 scripts/build-flowsheet-stamps-sql.py \
      --csv /tmp/discogs-bridge-stamps.csv \
      --linkage-source discogs_local_bridge \
      --confidence 0.9 \
      > /tmp/discogs-bridge-update.sql

  python3 scripts/build-flowsheet-stamps-sql.py \
      --csv /tmp/fuzzy-trigram-stamps.csv \
      --linkage-source fuzzy_trigram_match \
      --confidence 0.85 \
      --commit \
      > /tmp/fuzzy-trigram-update.sql

Input CSV columns: artist_name, album_title, library_id (header row required).
"""
from __future__ import annotations

import argparse
import csv
import sys


def pg_quote(s: str) -> str:
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--csv", required=True, help="path to stamps CSV")
    ap.add_argument(
        "--linkage-source",
        required=True,
        help="value to write into flowsheet.linkage_source (e.g. discogs_local_bridge)",
    )
    ap.add_argument(
        "--confidence",
        required=True,
        type=float,
        help="value to write into flowsheet.linkage_confidence (0.0–1.0)",
    )
    ap.add_argument(
        "--commit",
        action="store_true",
        help="emit COMMIT instead of ROLLBACK at the end (default: dry-run)",
    )
    args = ap.parse_args()

    if not (0.0 <= args.confidence <= 1.0):
        sys.exit(f"--confidence must be in [0, 1], got {args.confidence}")

    rows: list[tuple[str, str, int]] = []
    with open(args.csv, newline="") as fh:
        reader = csv.DictReader(fh)
        required = {"artist_name", "album_title", "library_id"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            sys.exit(f"CSV missing required columns: {sorted(missing)}")
        for r in reader:
            rows.append((r["artist_name"], r["album_title"], int(r["library_id"])))

    if not rows:
        sys.exit("CSV had no data rows; refusing to emit an empty UPDATE")

    out = sys.stdout

    out.write("SET statement_timeout = '600s';\n")
    out.write("BEGIN;\n")
    out.write(
        "CREATE TEMP TABLE stamps "
        "(artist_name TEXT, album_title TEXT, library_id INT) "
        "ON COMMIT DROP;\n"
    )
    out.write("INSERT INTO stamps (artist_name, album_title, library_id) VALUES\n")
    out.write(
        ",\n".join(
            f"  ({pg_quote(a)}, {pg_quote(b)}, {lib})" for a, b, lib in rows
        )
    )
    out.write(";\n")

    out.write("SELECT 'temp_rows' AS step, count(*) FROM stamps;\n")

    out.write(
        "UPDATE wxyc_schema.flowsheet f\n"
        f"SET album_id = s.library_id,\n"
        f"    linkage_source = {pg_quote(args.linkage_source)},\n"
        f"    linkage_confidence = {args.confidence},\n"
        f"    linked_at = now()\n"
        "FROM stamps s\n"
        "WHERE f.artist_name = s.artist_name\n"
        "  AND f.album_title = s.album_title\n"
        "  AND f.album_id IS NULL\n"
        "  AND f.entry_type = 'track';\n"
    )

    out.write(
        "SELECT linkage_source, count(*) AS n\n"
        "FROM wxyc_schema.flowsheet\n"
        "WHERE linkage_source IS NOT NULL\n"
        "GROUP BY 1\n"
        "ORDER BY 1;\n"
    )

    out.write("COMMIT;\n" if args.commit else "ROLLBACK;\n")


if __name__ == "__main__":
    main()
