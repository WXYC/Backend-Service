"""Mojibake detection for Backend-Service PostgreSQL (M0.1 audit).

Adapted from /tmp/mojibake_scan_v2.py (PyMySQL flavor). Scans the
name-bearing columns in the BS schema for double-encoded UTF-8 strings,
emits a CSV of fix proposals, and writes a markdown summary.

Read-only: never issues UPDATE / DELETE.

Usage:
    DB_HOST=localhost DB_PORT=5434 DB_USER=postgres DB_PASSWORD=postgres \\
    DB_NAME=wxyc_db WXYC_SCHEMA_NAME=wxyc_schema \\
    python3 scripts/audit/bs_mojibake_scan.py \\
        --csv audit/bs_mojibake_audit.csv \\
        --summary audit/bs_mojibake_summary.md
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, Optional

# psycopg is imported lazily so the detection helpers can be unit-tested
# without a database driver present.


# (table, primary_key_columns, [text_columns_to_scan])
SCAN_TARGETS: list[tuple[str, tuple[str, ...], tuple[str, ...]]] = [
    ('artists',                    ('id',),                   ('artist_name', 'alphabetical_name')),
    ('library',                    ('id',),                   ('alternate_artist_name', 'album_artist', 'album_title', 'label')),
    ('compilation_track_artist',   ('id',),                   ('artist_name', 'track_title')),
    ('rotation',                   ('id',),                   ('artist_name', 'album_title', 'record_label')),
    ('flowsheet',                  ('id',),                   ('track_title', 'album_title', 'artist_name', 'record_label', 'message', 'dj_name', 'artist_bio')),
    ('shows',                      ('id',),                   ('legacy_dj_name', 'show_name')),
    ('labels',                     ('id',),                   ('label_name',)),
    ('genres',                     ('id',),                   ('genre_name', 'description')),
    ('reviews',                    ('id',),                   ('review', 'author')),
    ('specialty_shows',            ('id',),                   ('specialty_name', 'description')),
    ('bins',                       ('id',),                   ('track_title',)),
    ('artist_crossreference',      ('source_artist_id', 'target_artist_id'), ('comment',)),
    ('artist_library_crossreference', ('artist_id', 'library_id'),           ('comment',)),
]


# -----------------------------------------------------------------------------
# Detection helpers (pure functions — unit-tested in tests/audit/)
# -----------------------------------------------------------------------------


def try_fix(s: Optional[str]) -> Optional[str]:
    """Recover a string via latin1 -> utf-8 round-trip.

    Returns None when:
    - s is empty/None,
    - the round-trip raises (string has codepoints > U+00FF),
    - the round-trip is a no-op,
    - the decoded form contains U+FFFD (lossy).
    """
    if not s:
        return None
    try:
        fixed = s.encode('latin1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None
    if fixed == s:
        return None
    if '\ufffd' in fixed:
        return None
    return fixed


def has_latin1_supplement(s: Optional[str]) -> bool:
    """True if any codepoint falls in 0x80-0xFF (the mojibake fingerprint range)."""
    if not s:
        return False
    return any(0x80 <= ord(c) <= 0xFF for c in s)


def script_of(s: str) -> str:
    """Return the dominant Unicode block name of letters in s, or 'NONE'."""
    blocks: dict[str, int] = defaultdict(int)
    for c in s:
        if c.isascii() or not c.isalpha():
            continue
        try:
            name = unicodedata.name(c, '')
        except (ValueError, KeyError):
            continue
        if not name:
            continue
        blocks[name.split()[0]] += 1
    if not blocks:
        return 'NONE'
    return max(blocks.items(), key=lambda kv: kv[1])[0]


def confidence(current: str, fixed: str) -> int:
    """0-100 score. >= 90 is auto-apply territory."""
    sc = script_of(fixed)
    has_high = any(ord(c) > 0x024F for c in fixed)
    if has_high and sc not in ('LATIN', 'NONE'):
        return 95
    if any(0x100 <= ord(c) <= 0x024F for c in fixed):
        return 85
    if has_latin1_supplement(fixed) and ('\u00c3' in current or '\u00c2' in current):
        return 80
    return 50


def classify(value: str) -> str:
    """Classify a single non-ASCII string as 'round_trip', 'lossy', or 'clean'.

    'clean' means the value contains non-ASCII codepoints but does not look
    double-encoded (no successful round-trip and no '?' in latin1-supplement
    context).
    """
    if not has_latin1_supplement(value):
        return 'clean'
    if try_fix(value) is not None:
        return 'round_trip'
    if '?' in value:
        return 'lossy'
    return 'clean'


# -----------------------------------------------------------------------------
# Database scan
# -----------------------------------------------------------------------------


@dataclass
class Finding:
    table: str
    column: str
    primary_key: str  # JSON-ish "{id=42}" form
    current: str
    proposed: str
    confidence: int
    kind: str  # 'round_trip' | 'lossy'
    row_count: int  # how many rows share this exact value


def _conn_kwargs_from_env() -> dict[str, object]:
    return {
        'host': os.environ.get('DB_HOST', 'localhost'),
        'port': int(os.environ.get('DB_PORT', '5432')),
        'user': os.environ.get('DB_USERNAME') or os.environ.get('DB_USER', 'postgres'),
        'password': os.environ.get('DB_PASSWORD', ''),
        'dbname': os.environ.get('DB_NAME', 'wxyc_db'),
    }


def scan_database(
    schema: str,
    targets: Iterable[tuple[str, tuple[str, ...], tuple[str, ...]]] = SCAN_TARGETS,
) -> tuple[list[Finding], dict[tuple[str, str], dict[str, int]]]:
    """Connect to PG and emit Findings + per-(table,column) coverage stats.

    Returns:
        findings: list of Finding rows (one per distinct value × column).
        stats: {(table, col): {'distinct_nonascii': int, 'rows_nonascii': int,
                                'distinct_round_trip': int, 'rows_round_trip': int,
                                'distinct_lossy': int, 'rows_lossy': int}}
    """
    import psycopg  # local import — keeps unit tests driver-free

    findings: list[Finding] = []
    stats: dict[tuple[str, str], dict[str, int]] = {}

    with psycopg.connect(**_conn_kwargs_from_env()) as conn:
        with conn.cursor() as cur:
            # Discover which tables/columns actually exist in this schema.
            cur.execute(
                """
                SELECT table_name, column_name
                FROM information_schema.columns
                WHERE table_schema = %s
                """,
                (schema,),
            )
            existing: set[tuple[str, str]] = {(r[0], r[1]) for r in cur.fetchall()}

            for table, pk_cols, cols in targets:
                if not any((table, c) in existing for c in cols):
                    continue
                # ARRAY_AGG of a ROW() constructor handles both single and
                # composite primary keys uniformly (psycopg returns a tuple).
                pk_row = 'ROW(' + ', '.join(f'"{c}"' for c in pk_cols) + ')'
                for col in cols:
                    if (table, col) not in existing:
                        continue
                    key = (table, col)
                    stats[key] = {
                        'distinct_nonascii': 0,
                        'rows_nonascii': 0,
                        'distinct_round_trip': 0,
                        'rows_round_trip': 0,
                        'distinct_lossy': 0,
                        'rows_lossy': 0,
                    }
                    # Aggregate by distinct value: char_length != octet_length means non-ASCII.
                    cur.execute(
                        f'''
                        SELECT "{col}" AS v,
                               COUNT(*) AS n,
                               (ARRAY_AGG({pk_row}))[1] AS sample_pk
                        FROM "{schema}"."{table}"
                        WHERE "{col}" IS NOT NULL
                          AND "{col}" <> ''
                          AND char_length("{col}") <> octet_length("{col}")
                        GROUP BY "{col}"
                        '''
                    )
                    for row in cur.fetchall():
                        v, n, sample_pk = row[0], row[1], row[2]
                        stats[key]['distinct_nonascii'] += 1
                        stats[key]['rows_nonascii'] += n
                        kind = classify(v)
                        if kind == 'clean':
                            continue
                        proposed = try_fix(v) if kind == 'round_trip' else ''
                        conf = confidence(v, proposed) if proposed else 0
                        if kind == 'round_trip':
                            stats[key]['distinct_round_trip'] += 1
                            stats[key]['rows_round_trip'] += n
                        else:
                            stats[key]['distinct_lossy'] += 1
                            stats[key]['rows_lossy'] += n
                        pk_repr = _format_pk(pk_cols, sample_pk)
                        findings.append(
                            Finding(
                                table=table,
                                column=col,
                                primary_key=pk_repr,
                                current=v,
                                proposed=proposed or '',
                                confidence=conf,
                                kind=kind,
                                row_count=n,
                            )
                        )
    return findings, stats


def _format_pk(pk_cols: tuple[str, ...], pk_value) -> str:
    # ROW(...) → psycopg returns a tuple, even for a single-column key.
    if not isinstance(pk_value, tuple):
        pk_value = (pk_value,)
    return ','.join(f'{c}={v}' for c, v in zip(pk_cols, pk_value))


# -----------------------------------------------------------------------------
# Output formatting
# -----------------------------------------------------------------------------


def write_csv(findings: list[Finding], path: str) -> None:
    findings_sorted = sorted(
        findings,
        key=lambda f: (f.kind != 'round_trip', -f.row_count, f.table, f.column, f.current),
    )
    with open(path, 'w', newline='') as fp:
        w = csv.writer(fp)
        w.writerow(['table', 'column', 'primary_key', 'current', 'proposed', 'confidence', 'kind', 'row_count'])
        for f in findings_sorted:
            w.writerow([f.table, f.column, f.primary_key, f.current, f.proposed, f.confidence, f.kind, f.row_count])


def write_summary(findings: list[Finding], stats: dict[tuple[str, str], dict[str, int]], path: str) -> None:
    rt = [f for f in findings if f.kind == 'round_trip']
    lossy = [f for f in findings if f.kind == 'lossy']
    rt_rows = sum(f.row_count for f in rt)
    lossy_rows = sum(f.row_count for f in lossy)
    auto_apply = [f for f in rt if f.confidence >= 90]
    review = [f for f in rt if 70 <= f.confidence < 90]
    ambig = [f for f in rt if f.confidence < 70]

    lines: list[str] = []
    lines.append('# Backend-Service mojibake audit (M0.1)\n')
    lines.append(f'- Round-trippable distinct values: **{len(rt)}** covering **{rt_rows}** rows')
    lines.append(f'  - Auto-apply (conf ≥ 90): {len(auto_apply)} pairs / {sum(f.row_count for f in auto_apply)} rows')
    lines.append(f'  - Manual review (70-89):  {len(review)} pairs / {sum(f.row_count for f in review)} rows')
    lines.append(f'  - Ambiguous (< 70):       {len(ambig)} pairs / {sum(f.row_count for f in ambig)} rows')
    lines.append(f'- Lossy distinct values:           **{len(lossy)}** covering **{lossy_rows}** rows')
    lines.append('')
    lines.append('## Per-(table, column) coverage')
    lines.append('')
    lines.append('| table | column | distinct non-ASCII | rows non-ASCII | distinct round-trip | rows round-trip | distinct lossy | rows lossy |')
    lines.append('|---|---|---:|---:|---:|---:|---:|---:|')
    for (table, col), s in sorted(stats.items()):
        lines.append(
            f'| {table} | {col} | {s["distinct_nonascii"]} | {s["rows_nonascii"]} '
            f'| {s["distinct_round_trip"]} | {s["rows_round_trip"]} '
            f'| {s["distinct_lossy"]} | {s["rows_lossy"]} |'
        )
    lines.append('')
    lines.append('## Top 50 round-trippable values')
    lines.append('')
    lines.append('| rows | conf | table.column | current → proposed |')
    lines.append('|---:|---:|---|---|')
    for f in sorted(rt, key=lambda f: -f.row_count)[:50]:
        cur_disp = f.current.replace('|', '\\|')[:60]
        prop_disp = f.proposed.replace('|', '\\|')[:60]
        lines.append(f'| {f.row_count} | {f.confidence} | {f.table}.{f.column} | `{cur_disp}` → `{prop_disp}` |')
    lines.append('')
    if lossy:
        lines.append('## Top 25 lossy values (require LML or external recovery)')
        lines.append('')
        lines.append('| rows | table.column | current |')
        lines.append('|---:|---|---|')
        for f in sorted(lossy, key=lambda f: -f.row_count)[:25]:
            cur_disp = f.current.replace('|', '\\|')[:80]
            lines.append(f'| {f.row_count} | {f.table}.{f.column} | `{cur_disp}` |')
        lines.append('')
    with open(path, 'w') as fp:
        fp.write('\n'.join(lines))


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    p.add_argument('--csv', default='audit/bs_mojibake_audit.csv')
    p.add_argument('--summary', default='audit/bs_mojibake_summary.md')
    p.add_argument('--schema', default=os.environ.get('WXYC_SCHEMA_NAME', 'wxyc_schema'))
    args = p.parse_args(argv)

    findings, stats = scan_database(args.schema)
    os.makedirs(os.path.dirname(args.csv) or '.', exist_ok=True)
    os.makedirs(os.path.dirname(args.summary) or '.', exist_ok=True)
    write_csv(findings, args.csv)
    write_summary(findings, stats, args.summary)

    rt = sum(1 for f in findings if f.kind == 'round_trip')
    lossy = sum(1 for f in findings if f.kind == 'lossy')
    print(f'Wrote {args.csv} ({len(findings)} rows: {rt} round-trip, {lossy} lossy).', file=sys.stderr)
    print(f'Wrote {args.summary}.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
