#!/usr/bin/env python3
"""Compute the three headline metrics (issue #1873) from data/results.json
and print + write a summary. Run from the spike root:

    python3 scripts/compute_metrics.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from metrics import score  # noqa: E402


def main() -> None:
    results = json.loads((ROOT / "data" / "results.json").read_text())
    items = results["items"]
    result = score(items)

    miss_reasons: dict[str, int] = {}
    for item in items:
        if item["automated"] != "attached" and item["ground_truth"] == "editorial":
            reason = item.get("miss_reason") or "unclassified"
            miss_reasons[reason] = miss_reasons.get(reason, 0) + 1

    summary = {
        "sample_size": result.sample_size,
        "editorial_detection": {
            "true_positives": result.true_positives,
            "false_positives": result.false_positives,
            "true_negatives": result.true_negatives,
            "false_negatives": result.false_negatives,
            "precision": result.precision,
            "recall": result.recall,
        },
        "exact_match_false_attach_count": result.exact_match_false_attach_count,
        "exact_match_precision": (
            1.0
            if (result.true_positives + result.false_positives) == 0
            else result.true_positives / (result.true_positives + result.false_positives)
        ),
        "automated_findable_rate": result.findable_rate,
        "manual_findable_rate_baseline": 27 / 40,
        "false_negative_breakdown": miss_reasons,
        "bonus_guardrail_trial": results.get("bonus_guardrail_trial"),
    }

    print(json.dumps(summary, indent=2))
    (ROOT / "data" / "metrics_summary.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()
