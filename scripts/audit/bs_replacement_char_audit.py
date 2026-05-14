"""Phase 1 audit: enumerate Backend-Service PG rows whose user-visible columns
contain U+FFFD (REPLACEMENT CHARACTER) bytes (#863).

This is the byte-level lossy form: `0xef 0xbf 0xbd` is the 3-byte UTF-8
encoding of U+FFFD itself, written into the data because an upstream component
already replaced an undecodable byte with U+FFFD and persisted the
replacement character verbatim. Cannot be recovered by re-decoding — needs
canonical-string injection (the V015/V016 pattern on tubafrenzy's MySQL
side).

Distinct from `scripts/audit/bs_mojibake_scan.py`, which targets the
`Ã?`/`Â`/Latin-1-supplement double-encoded forms and the `?`-substituted
lossy form. The two scripts can run side-by-side; they detect different
shapes of corruption.

Target columns per #863:

    wxyc_schema.rotation.{artist_name, album_title, record_label}
    wxyc_schema.library.{artist_name, album_title, label}
    wxyc_schema.flowsheet.{artist_name, track_title, album_title, record_label}

Read-only: never issues UPDATE / DELETE.

Output:
    CSV with one row per (table, column, lossy_value):
        table, column, lossy_value, row_count, sample_primary_key

Usage:
    DB_HOST=localhost DB_PORT=5432 DB_USERNAME=postgres DB_PASSWORD=postgres \\
    DB_NAME=wxyc_db WXYC_SCHEMA_NAME=wxyc_schema \\
    python3 scripts/audit/bs_replacement_char_audit.py \\
        --csv audit/bs_replacement_char_audit.csv \\
        --summary audit/bs_replacement_char_summary.md
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

# psycopg imported lazily so detection helpers are unit-testable without a driver.

REPLACEMENT_CHAR = '�'

# (table, primary_key_columns, [text_columns_to_scan]).
# Scope matches #863 exactly — three tables, the user-visible name columns.
SCAN_TARGETS: list[tuple[str, tuple[str, ...], tuple[str, ...]]] = [
    ('rotation',  ('id',), ('artist_name', 'album_title', 'record_label')),
    ('library',   ('id',), ('artist_name', 'album_title', 'label')),
    ('flowsheet', ('id',), ('artist_name', 'track_title', 'album_title', 'record_label')),
]


# -----------------------------------------------------------------------------
# Detection helpers (pure functions — unit-tested in tests/audit/)
# -----------------------------------------------------------------------------


def has_replacement_char(value: str | None) -> bool:
    """True if the string contains a literal U+FFFD codepoint."""
    if not value:
        return False
    return REPLACEMENT_CHAR in value


def count_replacement_chars(value: str | None) -> int:
    """Number of U+FFFD occurrences in the string. Zero for empty/None."""
    if not value:
        return 0
    return value.count(REPLACEMENT_CHAR)


# -----------------------------------------------------------------------------
# DB scan
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class LossyFinding:
    table: str
    column: str
    lossy_value: str
    row_count: int  # how many rows share this exact lossy_value
    sample_primary_key: str  # JSON-ish "{id=42}" form for one representative row
    fffd_count: int  # how many U+FFFD codepoints appear inside lossy_value


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
    *,
    logger: logging.Logger | None = None,
) -> tuple[list[LossyFinding], dict[tuple[str, str], dict[str, int]]]:
    """Connect to PG and emit findings + per-(table, column) coverage stats.

    Returns:
        findings: one LossyFinding per (table, column, distinct lossy_value).
        stats: {(table, col): {'rows_lossy': int, 'distinct_lossy': int}}
    """
    import psycopg  # local import — keeps unit tests driver-free

    log = logger or logging.getLogger(__name__)
    findings: list[LossyFinding] = []
    stats: dict[tuple[str, str], dict[str, int]] = {}

    log.info('Connecting to %s@%s:%s/%s schema=%s',
             _conn_kwargs_from_env()['user'],
             _conn_kwargs_from_env()['host'],
             _conn_kwargs_from_env()['port'],
             _conn_kwargs_from_env()['dbname'],
             schema)

    with psycopg.connect(**_conn_kwargs_from_env()) as conn:
        with conn.cursor() as cur:
            # Discover which (table, column) pairs actually exist in this schema.
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
                    log.warning('skipping %s.%s: table or columns missing', schema, table)
                    continue
                pk_row = 'ROW(' + ', '.join(f'"{c}"' for c in pk_cols) + ')'
                for col in cols:
                    if (table, col) not in existing:
                        log.warning('skipping %s.%s.%s: column missing', schema, table, col)
                        continue
                    key = (table, col)
                    stats[key] = {'rows_lossy': 0, 'distinct_lossy': 0}
                    # POSITION(...) on the literal U+FFFD codepoint is the
                    # simplest match. Aggregating by the distinct lossy value
                    # keeps the proposals CSV small and avoids duplicate LML
                    # lookups in Phase 2.
                    cur.execute(
                        f'''
                        SELECT "{col}" AS lossy_value,
                               COUNT(*) AS row_count,
                               (ARRAY_AGG({pk_row}))[1] AS sample_pk
                        FROM "{schema}"."{table}"
                        WHERE "{col}" IS NOT NULL
                          AND POSITION(%s IN "{col}") > 0
                        GROUP BY "{col}"
                        ORDER BY row_count DESC, lossy_value ASC
                        ''',
                        (REPLACEMENT_CHAR,),
                    )
                    for row in cur.fetchall():
                        v, n, sample_pk = row[0], row[1], row[2]
                        stats[key]['distinct_lossy'] += 1
                        stats[key]['rows_lossy'] += n
                        findings.append(
                            LossyFinding(
                                table=table,
                                column=col,
                                lossy_value=v,
                                row_count=n,
                                sample_primary_key=_format_pk(pk_cols, sample_pk),
                                fffd_count=count_replacement_chars(v),
                            )
                        )
                    log.info(
                        'scan %s.%s: distinct=%d rows=%d',
                        table, col, stats[key]['distinct_lossy'], stats[key]['rows_lossy']
                    )
    return findings, stats


def _format_pk(pk_cols: tuple[str, ...], pk_value) -> str:
    # ROW(...) → psycopg returns a tuple even for a single-column key.
    if not isinstance(pk_value, tuple):
        pk_value = (pk_value,)
    return ','.join(f'{c}={v}' for c, v in zip(pk_cols, pk_value))


# -----------------------------------------------------------------------------
# Output formatting
# -----------------------------------------------------------------------------


def write_csv(findings: list[LossyFinding], path: str) -> None:
    """Phase 1 audit CSV. One row per distinct lossy value.

    Sorted by (table, column, row_count DESC) so the highest-frequency rows
    surface first within each column scope — that's the order a reviewer
    wants to triage in.
    """
    findings_sorted = sorted(
        findings,
        key=lambda f: (f.table, f.column, -f.row_count, f.lossy_value),
    )
    with open(path, 'w', newline='') as fp:
        w = csv.writer(fp)
        w.writerow(['table', 'column', 'lossy_value', 'row_count', 'fffd_count', 'sample_primary_key'])
        for f in findings_sorted:
            w.writerow([f.table, f.column, f.lossy_value, f.row_count, f.fffd_count, f.sample_primary_key])


def write_summary(
    findings: list[LossyFinding],
    stats: dict[tuple[str, str], dict[str, int]],
    path: str,
) -> None:
    """Markdown summary of the audit run, suitable to drop into a PR body."""
    total_distinct = len(findings)
    total_rows = sum(f.row_count for f in findings)
    by_table: dict[str, int] = defaultdict(int)
    for f in findings:
        by_table[f.table] += f.row_count

    lines: list[str] = []
    lines.append('# Backend-Service U+FFFD-form mojibake audit (#863, Phase 1)\n')
    lines.append(f'- Distinct lossy values: **{total_distinct}**')
    lines.append(f'- Rows affected:         **{total_rows}**')
    lines.append('')
    lines.append('Recovery approach (Phase 2): query LML for canonical candidates per distinct value; threshold confidence >= 0.80 per the V015/V016 lml-fuzzy convention. Human review of the candidates CSV gates any migration. No UPDATE / DELETE generated at this phase.')
    lines.append('')
    lines.append('## Per-(table, column) coverage')
    lines.append('')
    lines.append('| table | column | distinct lossy | rows lossy |')
    lines.append('|---|---|---:|---:|')
    for (table, col), s in sorted(stats.items()):
        lines.append(
            f'| {table} | {col} | {s["distinct_lossy"]} | {s["rows_lossy"]} |'
        )
    lines.append('')
    if findings:
        lines.append('## Top 50 lossy values by row_count')
        lines.append('')
        lines.append('| rows | table.column | lossy_value |')
        lines.append('|---:|---|---|')
        for f in sorted(findings, key=lambda x: -x.row_count)[:50]:
            v_disp = f.lossy_value.replace('|', '\\|')[:80]
            lines.append(f'| {f.row_count} | {f.table}.{f.column} | `{v_disp}` |')
        lines.append('')
    with open(path, 'w') as fp:
        fp.write('\n'.join(lines))


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    p.add_argument('--csv', default='audit/bs_replacement_char_audit.csv')
    p.add_argument('--summary', default='audit/bs_replacement_char_summary.md')
    p.add_argument('--schema', default=os.environ.get('WXYC_SCHEMA_NAME', 'wxyc_schema'))
    p.add_argument('--log-level', default='INFO', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'])
    args = p.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format='%(asctime)s [%(levelname)s] %(message)s',
        stream=sys.stderr,
    )
    log = logging.getLogger('bs_replacement_char_audit')

    try:
        findings, stats = scan_database(args.schema, logger=log)
    except Exception:
        log.exception('audit scan failed')
        return 1

    os.makedirs(os.path.dirname(args.csv) or '.', exist_ok=True)
    os.makedirs(os.path.dirname(args.summary) or '.', exist_ok=True)
    write_csv(findings, args.csv)
    write_summary(findings, stats, args.summary)

    total_rows = sum(f.row_count for f in findings)
    log.info('wrote %s (%d distinct lossy values, %d rows)', args.csv, len(findings), total_rows)
    log.info('wrote %s', args.summary)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
