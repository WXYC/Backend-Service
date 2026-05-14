"""Unit tests for scripts/audit/bs_replacement_char_audit.py (#863 Phase 1).

Pure-function coverage of the detection helpers. The DB-touching `scan_database`
is exercised manually against a prod-clone snapshot per the audit workflow;
no Postgres in the unit suite.

Run from repo root:
    python3 -m pytest tests/audit -q
"""

from __future__ import annotations

import csv
import os
import sys

# Make scripts/audit importable.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'audit'))

from bs_replacement_char_audit import (  # noqa: E402
    LossyFinding,
    REPLACEMENT_CHAR,
    count_replacement_chars,
    has_replacement_char,
    write_csv,
    write_summary,
)


# -----------------------------------------------------------------------------
# has_replacement_char
# -----------------------------------------------------------------------------


def test_has_replacement_char_true_for_literal_fffd():
    # The "Csillagrablók" exemplar from the #863 issue: U+FFFD in place of ó.
    s = 'Csillagrabl' + REPLACEMENT_CHAR + 'k'
    assert has_replacement_char(s) is True


def test_has_replacement_char_false_for_clean_unicode():
    assert has_replacement_char('Csillagrablók') is False
    assert has_replacement_char('Stereolab') is False
    assert has_replacement_char('Nilüfer Yanya') is False


def test_has_replacement_char_false_for_question_mark_lossy():
    # The `?`-form lossy mojibake (tubafrenzy V015/V016 target) is NOT this
    # script's concern; `bs_mojibake_scan.py` handles that shape.
    assert has_replacement_char('Astrid Ã?ster Mortenson') is False


def test_has_replacement_char_false_for_empty_and_none():
    assert has_replacement_char('') is False
    assert has_replacement_char(None) is False


# -----------------------------------------------------------------------------
# count_replacement_chars
# -----------------------------------------------------------------------------


def test_count_replacement_chars_counts_all_occurrences():
    assert count_replacement_chars('a' + REPLACEMENT_CHAR + 'b' + REPLACEMENT_CHAR + 'c') == 2
    assert count_replacement_chars('') == 0
    assert count_replacement_chars(None) == 0
    assert count_replacement_chars('clean') == 0
    assert count_replacement_chars(REPLACEMENT_CHAR) == 1


# -----------------------------------------------------------------------------
# write_csv
# -----------------------------------------------------------------------------


def test_write_csv_columns_and_sort_order(tmp_path):
    """CSV header is fixed and rows sort by (table, column, -row_count, lossy_value)."""
    findings = [
        LossyFinding('rotation',  'artist_name', 'Csillagrabl' + REPLACEMENT_CHAR + 'k', row_count=3, sample_primary_key='id=21464', fffd_count=1),
        LossyFinding('flowsheet', 'artist_name', 'Nil' + REPLACEMENT_CHAR + 'fer',       row_count=15, sample_primary_key='id=100',  fffd_count=1),
        LossyFinding('flowsheet', 'artist_name', 'Ander' + REPLACEMENT_CHAR + 's',        row_count=15, sample_primary_key='id=200',  fffd_count=1),
        LossyFinding('library',   'album_title', 'Edits-' + REPLACEMENT_CHAR,            row_count=1, sample_primary_key='id=42',   fffd_count=1),
    ]
    path = tmp_path / 'audit.csv'
    write_csv(findings, str(path))

    with open(path, newline='') as fp:
        r = list(csv.reader(fp))

    assert r[0] == ['table', 'column', 'lossy_value', 'row_count', 'fffd_count', 'sample_primary_key']
    # flowsheet rows come before library/rotation alphabetically.
    assert r[1][0] == 'flowsheet'
    # Within flowsheet.artist_name, both rows have row_count=15 so tie-broken
    # by lossy_value ASC: 'Anders...' < 'Nilüfer...'.
    assert r[1][2].startswith('Ander')
    assert r[2][2].startswith('Nil')
    assert r[3][0] == 'library'
    assert r[4][0] == 'rotation'


# -----------------------------------------------------------------------------
# write_summary
# -----------------------------------------------------------------------------


def test_write_summary_renders_totals_and_table(tmp_path):
    findings = [
        LossyFinding('rotation', 'artist_name', 'Csillagrabl' + REPLACEMENT_CHAR + 'k', row_count=3, sample_primary_key='id=21464', fffd_count=1),
        LossyFinding('library',  'album_title', 'Edits-' + REPLACEMENT_CHAR,            row_count=1, sample_primary_key='id=42',   fffd_count=1),
    ]
    stats = {
        ('rotation', 'artist_name'): {'rows_lossy': 3, 'distinct_lossy': 1},
        ('library',  'album_title'): {'rows_lossy': 1, 'distinct_lossy': 1},
    }
    path = tmp_path / 'summary.md'
    write_summary(findings, stats, str(path))

    body = path.read_text()
    assert 'Distinct lossy values: **2**' in body
    assert 'Rows affected:         **4**' in body
    assert '| rotation | artist_name | 1 | 3 |' in body
    assert '| library | album_title | 1 | 1 |' in body
    # The pipe character in lossy values is escaped.
    assert '|' in body
