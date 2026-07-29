"""First-paragraph extraction for the spike.

Note this is deliberately more generous than the production snippet cap:
`jobs/album-critic-reviews-etl/extract.ts` enforces the real ≤300-char
fair-use ceiling (MAX_SNIPPET) on the *persisted* snippet, downstream of
whatever this pipeline hands it, with its own sentence/word-boundary trim
logic. This module's job is only "find the first real paragraph of body
text," not "produce the final stored snippet" -- so its default cap is
looser and exists mainly to keep pathological inputs bounded.
"""
from __future__ import annotations

import re

_SENTENCE_BOUNDARY_RE = re.compile(r"[.!?]\s")


def _is_substantial(paragraph: str) -> bool:
    """Filters out bylines, dateliness, and other short furniture that
    trafilatura-style extraction sometimes leaves as a leading 'paragraph'."""
    stripped = paragraph.strip()
    if len(stripped) < 40:
        return False
    # A line that's just "By NAME" or a bare date is furniture, not prose.
    if re.match(r"^(by\s+[\w.\-' ]{2,40})$", stripped, re.IGNORECASE):
        return False
    return True


def extract_first_paragraph(text: str, max_chars: int = 600) -> str:
    if not text or not text.strip():
        return ""

    # Split on blank-line paragraph breaks first; fall back to single
    # newlines if the source has no double-newline structure.
    candidates = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(candidates) <= 1:
        candidates = [p.strip() for p in text.split("\n") if p.strip()]

    paragraph = next((p for p in candidates if _is_substantial(p)), "")
    if not paragraph:
        return ""

    paragraph = re.sub(r"\s+", " ", paragraph).strip()
    if len(paragraph) <= max_chars:
        return paragraph

    cut = paragraph[:max_chars]
    boundaries = list(_SENTENCE_BOUNDARY_RE.finditer(cut))
    if boundaries:
        end = boundaries[-1].start() + 1
        return cut[:end].strip()
    last_space = cut.rfind(" ")
    return (cut[:last_space] if last_space > 0 else cut).strip()
