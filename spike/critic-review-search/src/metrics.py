"""Scoring for the spike's validation run: editorial-detection precision/
recall, exact-match precision (false-attach count), and automated
findable-rate -- the three headline numbers issue #1873 asks for.

"attached" is the only automated verdict that ever surfaces a review to a
user (everything else -- not_found, rejected_mismatch, rejected_not_editorial,
rejected_robots -- is "no card shown," which is always the safe default per
ADR 0012). So the confusion matrix is simple: did we attach, and should we
have?
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ScoreResult:
    sample_size: int
    true_positives: int
    false_positives: int
    true_negatives: int
    false_negatives: int
    precision: float | None
    recall: float | None
    findable_rate: float
    exact_match_false_attach_count: int


def score(items: list[dict]) -> ScoreResult:
    tp = fp = tn = fn = 0
    for item in items:
        is_editorial = item["ground_truth"] == "editorial"
        attached = item["automated"] == "attached"
        if attached and is_editorial:
            tp += 1
        elif attached and not is_editorial:
            fp += 1
        elif not attached and is_editorial:
            fn += 1
        else:
            tn += 1

    precision = tp / (tp + fp) if (tp + fp) > 0 else None
    recall = tp / (tp + fn) if (tp + fn) > 0 else None
    findable_rate = tp / len(items) if items else 0.0

    return ScoreResult(
        sample_size=len(items),
        true_positives=tp,
        false_positives=fp,
        true_negatives=tn,
        false_negatives=fn,
        precision=precision,
        recall=recall,
        findable_rate=findable_rate,
        exact_match_false_attach_count=fp,
    )
