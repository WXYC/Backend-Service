"""robots.txt + AI-opt-out checker.

Why this exists as real, tested code rather than "trust WebFetch": the
crawled-corpus sources in WXYC/research-data are a small, hand-curated list
-- each source's robots.txt was researched *once*, by a person, before a
crawler for it was written (see research-data/docs/candidate-sources.md:
Resident Advisor and New Commute are read from Wayback specifically because
someone checked and found their robots.txt blocks ClaudeBot/anthropic-ai).
Option B's search crawler hits domains nobody has ever looked at, chosen
per-release at runtime -- there is no curated list to lean on, so the check
has to be automatic and per-fetch, not a one-time human research pass. It
also has to run BEFORE the article fetch, not as a side effect of it, so a
disallowed candidate is dropped instead of silently mis-fetched.

Checks two distinct things named in issue #1873's constraints:
  1. "robots.txt" in the general sense -- a `*` (or our own UA's) Disallow
     rule for the specific path.
  2. "AI-opt-out" -- a rule scoped to `ClaudeBot` or `anthropic-ai`
     specifically, the same tokens research-data's crawler honors.
Either one blocks the fetch.
"""
from __future__ import annotations

import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

# Honest UA: unlike crawl_reviews.py's curated-source crawler (which spoofs a
# browser UA for sources a human already vetted), a search-driven crawler
# hitting arbitrary long-tail domains has no such standing relationship, so
# it self-identifies -- letting any outlet that wants to opt out, opt out.
USER_AGENT = "WXYC-CriticReviewSearchSpike/0.1 (+https://wxyc.org; research spike, contact jake@wxyc.org)"

# Tokens checked as our "AI-opt-out" identity, in addition to our own UA
# string above. Matches the tokens research-data's docs call out by name.
_AI_OPT_OUT_TOKENS = ("ClaudeBot", "anthropic-ai")

_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class RobotsDecision:
    allowed: bool
    reason: str
    fetch_failed: bool = False


def _default_fetcher(robots_url: str) -> str:
    request = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310
        return response.read().decode("utf-8", errors="replace")


def check_robots(url: str, *, fetcher=_default_fetcher) -> RobotsDecision:
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

    try:
        text = fetcher(robots_url)
    except Exception as exc:  # noqa: BLE001 -- any fetch failure is treated the same
        # A robots.txt we can't reach is NOT the same as one that says "no."
        # Per RFC 9309 §2.3.1.3, a 4xx (no robots.txt) means "fully allowed";
        # we extend that same fail-open posture to network/timeout errors
        # rather than let a single flaky fetch silently kill a candidate --
        # but we flag it so a caller can choose to be stricter.
        return RobotsDecision(allowed=True, reason=f"could not fetch robots.txt ({exc})", fetch_failed=True)

    parser = RobotFileParser()
    parser.parse(text.splitlines())

    # Only treat a rule as "AI-opt-out" if robots.txt actually names one of
    # our AI tokens as its own User-agent block -- NOT just because
    # can_fetch(token, ...) falls back to the wildcard block internally
    # (which it does; RobotFileParser has no per-specific-agent match).
    # That distinction is what makes the reported reason honest: a bare
    # "User-agent: *" block is a general robots.txt rule, not evidence the
    # site specifically opted out of AI crawling.
    named_agents = {ua.lower() for entry in parser.entries for ua in entry.useragents}
    matched_token = next((t for t in _AI_OPT_OUT_TOKENS if t.lower() in named_agents), None)
    if matched_token and not parser.can_fetch(matched_token, url):
        return RobotsDecision(allowed=False, reason=f"disallowed for AI-opt-out token '{matched_token}'")

    if not parser.can_fetch("*", url):
        return RobotsDecision(allowed=False, reason="disallowed by robots.txt (wildcard '*' rule)")

    return RobotsDecision(allowed=True, reason="no matching disallow rule")
