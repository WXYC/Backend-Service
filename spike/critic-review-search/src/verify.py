"""Exact-release verification -- the mis-attribution guard (ADR 0012's
"never mis-attribute" posture; issue #1873's "Decosimo trap").

Deliberately mirrors jobs/album-critic-reviews-etl's match.ts posture rather
than inventing a new one: normalized-exact match first, one narrow
decoration-strip retry (trailing "(deluxe edition)" / "(remastered)" / etc.
clauses), and NO broad fuzzy/pg_trgm matching. The album-critic-reviews-etl
README calls that ceiling deliberate -- "it avoids ever attaching a review to
the wrong album" -- and this spike keeps the same ceiling rather than
loosening it for search-sourced candidates, which are noisier and need the
guard more, not less.

Both artist AND album must match. That symmetry is the point: matching only
the album lets a same-titled-different-artist record through; matching only
the artist is the Decosimo trap (right artist, wrong album).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

# A narrow, literal trailing-clause strip -- verbatim in spirit with the ETL's
# stripAlbumDecoration. Not a general normalizer.
_DECORATION_RE = re.compile(
    r"\s*[\(\[]\s*(reissue|deluxe(\s+edition)?|remaster(ed)?|expanded(\s+edition)?|"
    r"ep|special\s+edition)\s*[\)\]]\s*$",
    re.IGNORECASE,
)

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def strip_decoration(title: str) -> str:
    return _DECORATION_RE.sub("", title).strip()


def normalize_title(s: str) -> str:
    """Casefold, strip diacritics, drop punctuation, collapse whitespace.
    Deliberately not a fuzzy/semantic normalizer -- purely mechanical so the
    exact-match ceiling stays predictable."""
    decomposed = unicodedata.normalize("NFKD", s)
    without_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    no_punct = _PUNCT_RE.sub(" ", without_marks)
    return _WS_RE.sub(" ", no_punct).strip().casefold()


_EXACT_MATCH_THRESHOLD = 0.92


def titles_match(a: str, b: str, threshold: float = _EXACT_MATCH_THRESHOLD) -> bool:
    if not a or not b:
        return False
    na, nb = normalize_title(a), normalize_title(b)
    if na == nb:
        return True
    # One narrow retry: strip a trailing decoration clause from either side.
    na2, nb2 = normalize_title(strip_decoration(a)), normalize_title(strip_decoration(b))
    if na2 == nb2:
        return True
    ratio = SequenceMatcher(None, na, nb).ratio()
    return ratio >= threshold


@dataclass(frozen=True)
class VerifyResult:
    is_exact_match: bool
    reason: str


def verify_exact_release(
    target_artist: str,
    target_album: str,
    found_artist: str | None,
    found_album: str | None,
) -> VerifyResult:
    """When uncertain, drop the candidate -- never guess (issue #1873's hard
    constraint). A None found_artist/found_album means the page didn't
    clearly state one, which is itself a reason to reject."""
    if not found_album:
        return VerifyResult(False, "no album title recovered from the candidate page -- dropping, not guessing")
    if not found_artist:
        return VerifyResult(False, "no artist name recovered from the candidate page -- dropping, not guessing")

    album_ok = titles_match(target_album, found_album)
    artist_ok = titles_match(target_artist, found_artist)

    if album_ok and artist_ok:
        return VerifyResult(True, "artist and album both match after normalization")
    if artist_ok and not album_ok:
        # The Decosimo trap: right artist, wrong release.
        return VerifyResult(
            False,
            f"album mismatch (Decosimo trap): wanted {target_album!r}, page is about {found_album!r}",
        )
    if album_ok and not artist_ok:
        return VerifyResult(
            False,
            f"artist mismatch: wanted {target_artist!r}, page is about {found_artist!r}",
        )
    return VerifyResult(False, "neither artist nor album match")
