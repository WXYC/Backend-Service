"""Unit tests for scripts/audit/bs_mojibake_scan.py.

Tests the pure detection helpers against fixed inputs — no DB.

Run from repo root:
    python3 -m pytest tests/audit -q
"""

from __future__ import annotations

import os
import sys

# Make scripts/ importable as a package root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'audit'))

from bs_mojibake_scan import (  # noqa: E402
    classify,
    confidence,
    has_latin1_supplement,
    script_of,
    try_fix,
)


# -----------------------------------------------------------------------------
# try_fix
# -----------------------------------------------------------------------------


def test_try_fix_returns_none_for_empty():
    assert try_fix(None) is None
    assert try_fix('') is None


def test_try_fix_returns_none_for_pure_ascii():
    # No latin1-supplement byte → round-trip is a no-op → None.
    assert try_fix('Stereolab') is None


def test_try_fix_recovers_latin_extended_b_mu_ziq():
    # μ-Ziq, originally UTF-8 (CE BC) misinterpreted as latin1 → "Î¼-Ziq"
    mojibake = 'Î¼-Ziq'
    assert try_fix(mojibake) == 'μ-Ziq'


def test_try_fix_recovers_latin1_supplement_diacritics():
    # "Édith" UTF-8 bytes (C3 89 64 69 74 68) misread as latin1 yields
    # U+00C3 followed by U+0089 (a C1 control char). V003-style mojibake.
    mojibake = '\u00c3\u0089dith'
    assert try_fix(mojibake) == 'Édith'


def test_try_fix_returns_none_for_already_clean_unicode():
    # Genuine UTF-8 string with codepoints > 0xFF cannot be re-encoded as latin1.
    assert try_fix('μ-Ziq') is None
    assert try_fix('Édith') is None


def test_try_fix_returns_none_for_lossy_replacement():
    # If the round-trip introduced U+FFFD, treat as lossy and reject.
    # Build a string whose latin1 bytes decode to a string containing U+FFFD.
    # 0xC3 alone followed by ASCII is invalid UTF-8 — the strict decode raises,
    # so try_fix already returns None there. Use a real lossy case from the
    # tubafrenzy data: a literal `?` substitute means data was lost in MySQL,
    # not a recoverable double-encoding.
    assert try_fix('Astrid Ã?ster Mortenson') is None


# -----------------------------------------------------------------------------
# has_latin1_supplement / script_of
# -----------------------------------------------------------------------------


def test_has_latin1_supplement():
    assert has_latin1_supplement('Ã‰') is True
    assert has_latin1_supplement('plain ascii') is False
    assert has_latin1_supplement('μ-Ziq') is False  # codepoints > 0xFF
    assert has_latin1_supplement('') is False
    assert has_latin1_supplement(None) is False


def test_script_of_greek():
    assert script_of('μ-Ziq') == 'GREEK'


def test_script_of_cjk():
    # 繭/米/士 — all CJK Unified Ideographs.
    assert script_of('繭') == 'CJK'


def test_script_of_latin():
    assert script_of('Édith Piaf') == 'LATIN'


def test_script_of_no_letters():
    assert script_of('123 ?') == 'NONE'


# -----------------------------------------------------------------------------
# confidence
# -----------------------------------------------------------------------------


def test_confidence_high_for_non_latin_high_codepoints():
    # Greek μ → conf 95.
    assert confidence('Î¼-Ziq', 'μ-Ziq') == 95


def test_confidence_85_for_latin_extended():
    # Croatian "Š" (U+0160) → conf 85.
    assert confidence('Å ', 'Š') == 85


def test_confidence_80_for_diacritic_with_marker():
    # "Édith" decoded — has Ã marker in original (latin1 byte form).
    assert confidence('\u00c3\u0089dith', 'Édith') == 80


def test_confidence_50_for_ambiguous():
    # Decoded string has only Latin-1 supplement chars but no Ã/Â marker.
    # Synthetic: latin1-encoded but original lacks the double-encoding fingerprint.
    # In practice rare; assert that the lowest-confidence path returns 50.
    assert confidence('xx', 'é') == 50  # fixed has 0xE9, no marker in current


# -----------------------------------------------------------------------------
# classify
# -----------------------------------------------------------------------------


def test_classify_clean_for_pure_ascii():
    assert classify('Stereolab') == 'clean'


def test_classify_clean_for_genuine_unicode():
    # Already-decoded Greek — has codepoints > 0xFF, fails has_latin1_supplement.
    assert classify('μ-Ziq') == 'clean'


def test_classify_round_trip_for_double_encoded():
    assert classify('Î¼-Ziq') == 'round_trip'
    assert classify('\u00c3\u0089dith') == 'round_trip'  # latin1 mojibake of Édith


def test_classify_lossy_for_question_mark_in_latin1_context():
    # tubafrenzy mojibake_lossy.csv exemplar.
    assert classify('Astrid Ã?ster Mortenson') == 'lossy'


def test_classify_clean_for_question_mark_in_normal_text():
    # "Why?" — has '?' but no latin1-supplement byte → not lossy mojibake.
    assert classify('Why?') == 'clean'
