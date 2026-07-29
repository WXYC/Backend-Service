"""Heuristic editorial-vs-retail/listing classifier.

This is the fast, deterministic half of the hybrid classifier the ADR
recommends. It does one job: cheaply throw out URLs that are *obviously* not
an editorial review, before we spend a fetch (and, in production, an LLM
call) on them. Anything it can't rule out becomes an EDITORIAL_CANDIDATE and
is escalated to the fetch + verify stage -- this module never itself decides
"yes, this is a review"; it only decides "no, this clearly isn't."

Domain rules mirror the exclusion list named explicitly in Backend-Service
issue #1873: Discogs, Bandcamp *store* (not Bandcamp Daily), Spotify/Apple
Music, RateYourMusic, Last.fm, Genius, and generic retailer/listing pages.
Radio-chart trackers (CMJ etc.) are treated as retail-like: they're about
airplay rank, not editorial judgment of the record.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from urllib.parse import urlparse


class Category(str, Enum):
    EDITORIAL_CANDIDATE = "editorial_candidate"
    EXCLUDED_DOMAIN = "excluded_domain"
    LIKELY_RETAIL = "likely_retail"


@dataclass(frozen=True)
class ClassificationResult:
    category: Category
    reason: str


# Domains that are never an editorial review, full stop -- named in #1873.
_EXCLUDED_EXACT_DOMAINS = {
    "discogs.com",
    "open.spotify.com",
    "music.apple.com",
    "rateyourmusic.com",
    "last.fm",
    "genius.com",
    "genius.it",
}

# Domains that host both editorial and pure-listing/retail content; treated
# as retail unless a later, more specific rule says otherwise. Seeded from
# the ticket's named examples plus record-shop domains empirically observed
# during the spike's live validation run against the labeled 40-sample --
# illustrative, not exhaustive. The fetch+LLM stage (pipeline.py) is the
# real backstop for shop domains this list hasn't seen yet.
_RETAIL_DOMAINS = {
    "amazon.com",
    "ebay.com",
    "discogs.com",  # marketplace listings; also caught by exact-domain above
    "insound.com",
    "roughtrade.com",
    "turntablelab.com",
    "bullmoosemusic.com",
    "cmj.com",  # radio-chart tracker, not editorial
    "mediabase.com",  # radio-chart tracker
    "mrbongo.com",
    "boomkat.com",
    "piccadillyrecords.com",
    "decks.de",
    "musicmaniarecords.be",
    "strandedrecords.com",
    "rushhour.nl",
    "recordstoreday.com",
    "wordandsound.net",
}

_RETAIL_TEXT_MARKERS = re.compile(
    r"\b(buy now|add to cart|in stock|out of stock|ships within|pre-?order|"
    r"checkout|free shipping|price:\s*\$|\$\d+\.\d{2})\b",
    re.IGNORECASE,
)

_RETAIL_PATH_MARKERS = re.compile(r"/(shop|store|products?|cart|checkout)(/|$)", re.IGNORECASE)


def _host(url: str) -> str:
    netloc = urlparse(url).netloc.lower()
    return netloc[4:] if netloc.startswith("www.") else netloc


def _registrable_domain(host: str) -> str:
    """Best-effort eTLD+1 for our small, known domain sets (not a full PSL
    implementation -- good enough for amazon.com/www.amazon.com/smile.amazon.com
    style variance without pulling in a dependency)."""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def classify_url(url: str, title: str | None = None, snippet: str | None = None) -> ClassificationResult:
    host = _host(url)
    domain = _registrable_domain(host)

    # Bandcamp is split: the artist storefront (`<artist>.bandcamp.com`, or
    # bare `bandcamp.com`) is retail; `daily.bandcamp.com` is Bandcamp Daily,
    # an editorial desk, and is deliberately NOT excluded (per #1873).
    if domain == "bandcamp.com":
        if host == "daily.bandcamp.com":
            pass  # fall through to generic checks below
        else:
            return ClassificationResult(Category.EXCLUDED_DOMAIN, f"bandcamp store page ({host})")
    elif domain in _EXCLUDED_EXACT_DOMAINS or host in _EXCLUDED_EXACT_DOMAINS:
        return ClassificationResult(Category.EXCLUDED_DOMAIN, f"excluded domain ({domain})")

    if domain in _RETAIL_DOMAINS or host in _RETAIL_DOMAINS:
        return ClassificationResult(Category.LIKELY_RETAIL, f"retail/listing domain ({domain})")

    haystack = " ".join(part for part in (title, snippet) if part)
    if haystack and _RETAIL_TEXT_MARKERS.search(haystack):
        return ClassificationResult(Category.LIKELY_RETAIL, "retail text markers in title/snippet")

    if _RETAIL_PATH_MARKERS.search(urlparse(url).path):
        return ClassificationResult(Category.LIKELY_RETAIL, "retail path marker in URL")

    return ClassificationResult(Category.EDITORIAL_CANDIDATE, "no exclusion/retail signal matched")
