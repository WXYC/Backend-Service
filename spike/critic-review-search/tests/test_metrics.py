"""Unit tests for metrics.py's scoring logic, over a small synthetic set so
the arithmetic is hand-checkable. The real numbers (over the live 16-item
run) are computed by scripts/compute_metrics.py against data/results.json
and reported in REPORT.md -- this file only proves the scoring function
itself is correct.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from metrics import score  # noqa: E402


def test_score_basic_confusion_matrix_and_findable_rate():
    items = [
        {"ground_truth": "editorial", "automated": "attached"},  # TP
        {"ground_truth": "editorial", "automated": "attached"},  # TP
        {"ground_truth": "editorial", "automated": "not_found"},  # FN
        {"ground_truth": "retail", "automated": "not_found"},  # TN
        {"ground_truth": "retail", "automated": "not_found"},  # TN
        {"ground_truth": "nothing", "automated": "not_found"},  # TN
    ]
    result = score(items)
    assert result.true_positives == 2
    assert result.false_positives == 0
    assert result.false_negatives == 1
    assert result.true_negatives == 3
    assert result.precision == 1.0
    assert round(result.recall, 4) == round(2 / 3, 4)
    assert result.findable_rate == 2 / 6
    assert result.sample_size == 6


def test_score_flags_a_false_attach_as_precision_loss():
    items = [
        {"ground_truth": "editorial", "automated": "attached"},  # TP
        {"ground_truth": "retail", "automated": "attached"},  # FP -- would be a mis-attribution
    ]
    result = score(items)
    assert result.false_positives == 1
    assert result.precision == 0.5
    assert result.exact_match_false_attach_count == result.false_positives


def test_score_with_zero_attachments_has_undefined_precision_reported_as_none():
    items = [
        {"ground_truth": "editorial", "automated": "not_found"},
        {"ground_truth": "retail", "automated": "not_found"},
    ]
    result = score(items)
    assert result.true_positives == 0
    assert result.false_positives == 0
    assert result.precision is None  # 0/0 -- not "1.0", not "0.0", genuinely undefined
