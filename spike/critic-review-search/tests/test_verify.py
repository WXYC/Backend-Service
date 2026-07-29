"""Unit tests for exact-release verification (verify.py) -- the guard against
ADR 0012's cardinal sin, mis-attribution. Named for the "Decosimo trap": WXYC
rotation artist Joseph Decosimo has multiple released albums (e.g. "While You
Were Slumbering", "Beehive Cathedral", "Sequatchie Valley"); a review of the
*wrong one* by the *right artist* must be rejected, not just a review of the
wrong artist entirely.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from verify import normalize_title, titles_match, verify_exact_release  # noqa: E402


def test_normalize_strips_diacritics_and_case():
    assert normalize_title("Csillagrablók") == normalize_title("Csillagrablok".lower())


def test_normalize_collapses_punctuation_and_whitespace():
    assert normalize_title("  Some,  Album!! ") == normalize_title("some album")


def test_exact_match_after_normalization():
    assert titles_match("DOGA", "doga")


def test_decoration_stripped_retry_matches():
    # Mirrors the ETL's match.ts stripAlbumDecoration retry: a narrow,
    # literal trailing-clause strip, not a broad fuzzy normalizer.
    assert titles_match("Some Album", "Some Album (Deluxe Edition)")
    assert titles_match("Some Album", "Some Album (Remastered)")


def test_unrelated_titles_do_not_match():
    assert not titles_match("Beehive Cathedral", "While You Were Slumbering")


def test_decosimo_trap_same_artist_wrong_album_is_rejected():
    result = verify_exact_release(
        target_artist="Joseph Decosimo",
        target_album="Sequatchie Valley",
        found_artist="Joseph Decosimo",
        found_album="Beehive Cathedral",
    )
    assert result.is_exact_match is False
    assert "album" in result.reason.lower()


def test_exact_release_match_is_accepted():
    result = verify_exact_release(
        target_artist="Joseph Decosimo",
        target_album="Sequatchie Valley",
        found_artist="Joseph Decosimo",
        found_album="Sequatchie Valley",
    )
    assert result.is_exact_match is True


def test_wrong_artist_same_album_title_is_rejected():
    # Guards the symmetric trap: two different artists happen to share an
    # album title (not uncommon -- e.g. many albums titled after the band).
    result = verify_exact_release(
        target_artist="Universal Light",
        target_album="Universal Light",
        found_artist="Some Other Band",
        found_album="Universal Light",
    )
    assert result.is_exact_match is False
    assert "artist" in result.reason.lower()


def test_uncertain_extraction_is_rejected_not_guessed():
    # When the fetched page didn't clearly state an album title at all, we
    # must drop the candidate rather than guess -- "when uncertain, drop it".
    result = verify_exact_release(
        target_artist="Joseph Decosimo",
        target_album="Sequatchie Valley",
        found_artist="Joseph Decosimo",
        found_album=None,
    )
    assert result.is_exact_match is False
