"""Unit tests for the orchestration/decision layer (pipeline.py). These are
pure, offline tests over synthetic search-result and fetched-page records --
they do not call WebSearch/WebFetch. The live spike run (run_live_search.md
process, results under data/) exercises the real tools; this file exercises
the decision logic those results are fed into.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pipeline import FetchedPage, evaluate_fetched_candidate, shortlist_candidates, Verdict  # noqa: E402


def test_shortlist_drops_excluded_and_retail_and_keeps_order():
    results = [
        {"url": "https://www.discogs.com/release/1", "title": "Discogs listing"},
        {"url": "https://www.amazon.com/dp/B1", "title": "Buy on Amazon"},
        {"url": "https://maximumrocknroll.com/reviews/x", "title": "X reviewed"},
        {"url": "https://someblog.example.com/reviews/x", "title": "X, reviewed at length"},
    ]
    shortlist = shortlist_candidates(results)
    assert [c["url"] for c in shortlist] == [
        "https://maximumrocknroll.com/reviews/x",
        "https://someblog.example.com/reviews/x",
    ]


def test_shortlist_respects_max_candidates():
    results = [{"url": f"https://blog{i}.example.com/reviews/x"} for i in range(10)]
    shortlist = shortlist_candidates(results, max_candidates=3)
    assert len(shortlist) == 3


def test_accepts_when_editorial_and_exact_match():
    fetched = FetchedPage(
        url="https://maximumrocknroll.com/reviews/22-beaches",
        source_name="Maximum Rocknroll",
        is_editorial_review=True,
        found_artist="22 Beaches",
        found_album="Dust: Recordings 1980-1984",
        article_text=(
            "This is a killer archival document of early-80s DIY minimal wave, "
            "unearthed and remastered with real care for the source tapes.\n\n"
            "More body text follows here for padding purposes."
        ),
    )
    decision = evaluate_fetched_candidate(
        target_artist="22 Beaches", target_album="Dust: Recordings 1980-1984", fetched=fetched
    )
    assert decision.verdict == Verdict.ATTACHED
    assert decision.snippet.startswith("This is a killer archival document")
    assert decision.source == "Maximum Rocknroll"


def test_rejects_when_llm_says_not_editorial():
    fetched = FetchedPage(
        url="https://someshop.example.com/product/1",
        source_name="Some Shop",
        is_editorial_review=False,
        found_artist="22 Beaches",
        found_album="Dust: Recordings 1980-1984",
        article_text="Buy this record today, ships worldwide.",
    )
    decision = evaluate_fetched_candidate(
        target_artist="22 Beaches", target_album="Dust: Recordings 1980-1984", fetched=fetched
    )
    assert decision.verdict == Verdict.REJECTED_NOT_EDITORIAL
    assert decision.snippet is None


def test_rejects_decosimo_trap_even_if_llm_says_editorial():
    # The LLM can be fooled or sloppy about which release an article covers;
    # the code-level exact-match guard is the backstop, not a formality.
    fetched = FetchedPage(
        url="https://someblog.example.com/reviews/decosimo",
        source_name="Some Blog",
        is_editorial_review=True,
        found_artist="Joseph Decosimo",
        found_album="Beehive Cathedral",
        article_text="Decosimo's latest is a warm, front-porch record full of old-time fiddle tunes.",
    )
    decision = evaluate_fetched_candidate(
        target_artist="Joseph Decosimo", target_album="Sequatchie Valley", fetched=fetched
    )
    assert decision.verdict == Verdict.REJECTED_MISMATCH
    assert decision.snippet is None
    assert "Decosimo" in decision.reason or "album" in decision.reason.lower()


def test_no_candidates_found_is_not_found_verdict():
    from pipeline import no_candidates_decision

    decision = no_candidates_decision()
    assert decision.verdict == Verdict.NOT_FOUND
