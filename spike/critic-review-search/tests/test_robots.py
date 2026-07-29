"""Unit tests for the robots.txt / AI-opt-out checker (robots.py).

Hermetic: a fake fetcher is injected so these run offline. robots.py's
default fetcher does a real HTTP GET, exercised only by the live spike run,
not by this test suite.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from robots import check_robots  # noqa: E402


def _fetcher(text):
    return lambda robots_url: text


def test_allowed_when_no_robots_txt():
    # A missing/empty robots.txt is an allow-by-default, per RFC 9309.
    decision = check_robots("https://example.com/reviews/some-album", fetcher=_fetcher(""))
    assert decision.allowed is True


def test_blocked_by_wildcard_disallow_all():
    robots_txt = "User-agent: *\nDisallow: /\n"
    decision = check_robots("https://example.com/reviews/some-album", fetcher=_fetcher(robots_txt))
    assert decision.allowed is False
    assert "robots.txt" in decision.reason.lower() or "*" in decision.reason


def test_blocked_by_claudebot_specific_rule():
    robots_txt = "User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    decision = check_robots("https://example.com/reviews/some-album", fetcher=_fetcher(robots_txt))
    assert decision.allowed is False
    assert "claudebot" in decision.reason.lower() or "ai" in decision.reason.lower()


def test_blocked_by_anthropic_ai_specific_rule():
    robots_txt = "User-agent: anthropic-ai\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    decision = check_robots("https://example.com/reviews/some-album", fetcher=_fetcher(robots_txt))
    assert decision.allowed is False


def test_allowed_when_only_unrelated_bot_is_blocked():
    robots_txt = "User-agent: SomeOtherScraperBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    decision = check_robots("https://example.com/reviews/some-album", fetcher=_fetcher(robots_txt))
    assert decision.allowed is True


def test_path_scoped_disallow_only_blocks_that_path():
    robots_txt = "User-agent: *\nDisallow: /wp-admin/\nAllow: /\n"
    decision = check_robots("https://example.com/reviews/some-album", fetcher=_fetcher(robots_txt))
    assert decision.allowed is True
    blocked = check_robots("https://example.com/wp-admin/secret", fetcher=_fetcher(robots_txt))
    assert blocked.allowed is False


def test_fetch_failure_defaults_to_allowed_but_flags_uncertain():
    def raising_fetcher(_url):
        raise OSError("connection refused")

    decision = check_robots("https://example.com/reviews/some-album", fetcher=raising_fetcher)
    assert decision.allowed is True
    assert decision.fetch_failed is True
