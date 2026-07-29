"""Orchestration: raw search results -> shortlist -> (robots + fetch, done by
the caller) -> classification decision. This module contains no network
code; `robots.py` and the live WebSearch/WebFetch tool calls the caller makes
are the only things that touch the network. Keeping this layer pure is what
makes it unit-testable without mocking HTTP.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from classify import Category, classify_url
from extract import extract_first_paragraph
from verify import verify_exact_release


def shortlist_candidates(search_results: list[dict], max_candidates: int = 5) -> list[dict]:
    """Drop excluded-domain and likely-retail results; keep the rest in the
    search engine's original relevance order, capped at max_candidates so we
    don't fetch every long-tail blog that mentions the artist in passing."""
    kept = []
    for result in search_results:
        classification = classify_url(result.get("url", ""), result.get("title"), result.get("snippet"))
        if classification.category == Category.EDITORIAL_CANDIDATE:
            kept.append(result)
        if len(kept) >= max_candidates:
            break
    return kept


class Verdict(str, Enum):
    ATTACHED = "attached"
    REJECTED_NOT_EDITORIAL = "rejected_not_editorial"
    REJECTED_MISMATCH = "rejected_mismatch"
    REJECTED_ROBOTS = "rejected_robots"
    NOT_FOUND = "not_found"


@dataclass(frozen=True)
class FetchedPage:
    """The structured result of fetching + LLM-classifying one candidate URL.
    In the live run this is populated from a WebFetch call whose prompt asks
    for exactly these fields as JSON -- see README.md 'Live search protocol'.
    """

    url: str
    source_name: str
    is_editorial_review: bool
    found_artist: str | None
    found_album: str | None
    article_text: str


@dataclass(frozen=True)
class PipelineDecision:
    verdict: Verdict
    reason: str
    source: str | None = None
    source_url: str | None = None
    snippet: str | None = None


def evaluate_fetched_candidate(target_artist: str, target_album: str, fetched: FetchedPage) -> PipelineDecision:
    if not fetched.is_editorial_review:
        return PipelineDecision(
            verdict=Verdict.REJECTED_NOT_EDITORIAL,
            reason="fetched-page classifier says this is not an editorial review",
            source_url=fetched.url,
        )

    match = verify_exact_release(
        target_artist=target_artist,
        target_album=target_album,
        found_artist=fetched.found_artist,
        found_album=fetched.found_album,
    )
    if not match.is_exact_match:
        return PipelineDecision(
            verdict=Verdict.REJECTED_MISMATCH,
            reason=match.reason,
            source_url=fetched.url,
        )

    snippet = extract_first_paragraph(fetched.article_text)
    return PipelineDecision(
        verdict=Verdict.ATTACHED,
        reason="editorial review, exact release match",
        source=fetched.source_name,
        source_url=fetched.url,
        snippet=snippet,
    )


def robots_blocked_decision(url: str, reason: str) -> PipelineDecision:
    return PipelineDecision(verdict=Verdict.REJECTED_ROBOTS, reason=reason, source_url=url)


def no_candidates_decision() -> PipelineDecision:
    return PipelineDecision(verdict=Verdict.NOT_FOUND, reason="no editorial-candidate URLs survived the shortlist")
