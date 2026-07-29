"""Unit tests for first-paragraph extraction (extract.py)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from extract import extract_first_paragraph  # noqa: E402


def test_picks_first_substantial_paragraph():
    text = (
        "By Jane Critic | March 3, 2026\n\n"
        "Some Artist's new record opens with a shudder and never quite "
        "settles, which is exactly the point -- eleven tracks of restless, "
        "gorgeous unease that reward repeat listens.\n\n"
        "The album was recorded over two years in a barn in upstate New York."
    )
    para = extract_first_paragraph(text)
    assert para.startswith("Some Artist's new record opens with a shudder")


def test_skips_byline_and_date_fragments():
    text = "Jane Critic\nMarch 3, 2026\n\nThis is the real first paragraph of substantial length here."
    para = extract_first_paragraph(text)
    assert para.startswith("This is the real first paragraph")


def test_caps_length_at_sentence_boundary():
    long_sentence_para = "This is a review. " * 40  # well over any reasonable cap
    para = extract_first_paragraph(long_sentence_para, max_chars=100)
    assert len(para) <= 100
    assert para.endswith(".")


def test_empty_text_returns_empty_string():
    assert extract_first_paragraph("") == ""


def test_whitespace_only_text_returns_empty_string():
    assert extract_first_paragraph("   \n\n  \n") == ""
