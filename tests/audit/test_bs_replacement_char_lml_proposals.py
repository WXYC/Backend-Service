"""Unit tests for scripts/audit/bs_replacement_char_lml_proposals.py
(#863 Phase 2 candidate generator).

Pure-function coverage of the probe-builder, score normalizer, candidate
parser, and CSV writer. LML I/O is exercised manually with `--lml-url`
pointed at a staging instance; no HTTP in the unit suite.

Run from repo root:
    python3 -m pytest tests/audit -q
"""

from __future__ import annotations

import csv
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'audit'))

from bs_replacement_char_lml_proposals import (  # noqa: E402
    LmlCandidate,
    ProposalRow,
    REPLACEMENT_CHAR,
    build_raw_message,
    parse_candidates,
    score_to_confidence,
    strip_replacement_chars,
    write_proposals_csv,
)


# -----------------------------------------------------------------------------
# strip_replacement_chars
# -----------------------------------------------------------------------------


def test_strip_replacement_chars_removes_all_occurrences():
    assert strip_replacement_chars('Csillagrabl' + REPLACEMENT_CHAR + 'k') == 'Csillagrablk'
    assert strip_replacement_chars(REPLACEMENT_CHAR + 'foo' + REPLACEMENT_CHAR + 'bar') == 'foobar'


def test_strip_replacement_chars_is_noop_for_clean_string():
    assert strip_replacement_chars('Stereolab') == 'Stereolab'
    assert strip_replacement_chars('') == ''


# -----------------------------------------------------------------------------
# build_raw_message
# -----------------------------------------------------------------------------


def test_build_raw_message_artist_column_returns_stripped_value():
    raw = build_raw_message('rotation', 'artist_name', 'Csillagrabl' + REPLACEMENT_CHAR + 'k')
    assert raw == 'Csillagrablk'


def test_build_raw_message_track_column_returns_stripped_value():
    raw = build_raw_message('flowsheet', 'track_title', 'la parad' + REPLACEMENT_CHAR + 'ja')
    assert raw == 'la paradja'


def test_build_raw_message_album_or_label_returns_stripped_value():
    assert build_raw_message('library', 'album_title', 'A' + REPLACEMENT_CHAR + 'B') == 'AB'
    assert build_raw_message('library', 'label', 'L' + REPLACEMENT_CHAR + 'X') == 'LX'
    assert build_raw_message('flowsheet', 'record_label', 'R' + REPLACEMENT_CHAR) == 'R'


def test_build_raw_message_empty_after_strip_returns_empty():
    # All-U+FFFD value strips to empty; the driver skips these rather than
    # asking LML to parse a blank message.
    assert build_raw_message('rotation', 'artist_name', REPLACEMENT_CHAR * 3) == ''


# -----------------------------------------------------------------------------
# score_to_confidence
# -----------------------------------------------------------------------------


def test_score_to_confidence_passes_through_valid_floats():
    assert score_to_confidence(0.0) == 0.0
    assert score_to_confidence(0.85) == 0.85
    assert score_to_confidence(1.0) == 1.0


def test_score_to_confidence_clamps_out_of_range():
    assert score_to_confidence(-0.5) == 0.0
    assert score_to_confidence(2.5) == 1.0


def test_score_to_confidence_handles_none_and_garbage():
    assert score_to_confidence(None) == 0.0
    assert score_to_confidence('not-a-number') == 0.0


# -----------------------------------------------------------------------------
# parse_candidates
# -----------------------------------------------------------------------------


def test_parse_candidates_round_trips_canonical_fields():
    matches = [
        {
            'artist_name': 'Csillagrablók',
            'album_title': 'Csillagrablók',
            'match_score': 0.92,
            'matched_via': 'lml-fuzzy',
        }
    ]
    out = parse_candidates(matches)
    assert out == [
        LmlCandidate(
            canonical_artist='Csillagrablók',
            canonical_album='Csillagrablók',
            confidence=0.92,
            source='lml-fuzzy',
        )
    ]


def test_parse_candidates_falls_back_to_confidence_and_source_keys():
    # Older LML responses used `confidence`/`source` instead of
    # `match_score`/`matched_via`. Accept either.
    matches = [
        {
            'canonical_artist': 'Nilüfer Yanya',
            'canonical_album': 'PAINLESS',
            'confidence': 0.81,
            'source': 'lml-library',
        }
    ]
    out = parse_candidates(matches)
    assert out[0].canonical_artist == 'Nilüfer Yanya'
    assert out[0].confidence == 0.81
    assert out[0].source == 'lml-library'


def test_parse_candidates_drops_non_dict_entries():
    out = parse_candidates([{'artist_name': 'X', 'match_score': 0.9}, 'garbage', None])
    assert len(out) == 1
    assert out[0].canonical_artist == 'X'


def test_parse_candidates_defaults_source_to_lml_fuzzy():
    out = parse_candidates([{'artist_name': 'X', 'match_score': 0.9}])
    assert out[0].source == 'lml-fuzzy'


# -----------------------------------------------------------------------------
# write_proposals_csv
# -----------------------------------------------------------------------------


def test_write_proposals_csv_columns_and_sort_order(tmp_path):
    proposals = [
        ProposalRow(
            table='rotation', column='artist_name',
            lossy_value='Csillagrabl' + REPLACEMENT_CHAR + 'k',
            row_count=3,
            canonical_artist='Csillagrablók', canonical_album='', confidence=0.92,
            source='lml-fuzzy',
        ),
        ProposalRow(
            table='flowsheet', column='artist_name',
            lossy_value='Nil' + REPLACEMENT_CHAR + 'fer',
            row_count=10,
            canonical_artist='Nilüfer Yanya', canonical_album='', confidence=0.88,
            source='lml-fuzzy',
        ),
        ProposalRow(
            table='flowsheet', column='artist_name',
            lossy_value='Hermanos Guti' + REPLACEMENT_CHAR + 'rrez',
            row_count=20,
            canonical_artist='Hermanos Gutiérrez', canonical_album='', confidence=0.95,
            source='lml-library',
        ),
    ]
    path = tmp_path / 'proposals.csv'
    write_proposals_csv(proposals, str(path))

    with open(path, newline='') as fp:
        r = list(csv.reader(fp))

    assert r[0] == [
        'table', 'column', 'lossy_value', 'row_count',
        'canonical_artist', 'canonical_album', 'confidence', 'source', 'approved',
    ]
    # flowsheet rows sort before rotation alphabetically.
    # Within flowsheet.artist_name, higher row_count first.
    assert r[1][0] == 'flowsheet'
    assert r[1][3] == '20'  # Hermanos Gutiérrez (rc=20)
    assert r[2][3] == '10'  # Nilüfer (rc=10)
    assert r[3][0] == 'rotation'
    # `approved` column is blank — reviewer fills in y/n.
    assert r[1][-1] == ''
    # Confidence is rendered with 4 decimal places.
    assert r[1][6] == '0.9500'
