"""Thin wrapper — the auditor's canonical home moved in #1522.

The engine (scoring, fetch, audit loop, CSV/summary writers, ``--self-test``)
now lives at ``jobs/rotation-release-id-pollution-check/pollution_engine.py`` so
the weekly scheduled check imports it literally and engine edits ride the job's
auto-deploy + Docker build-time self-test gate. This wrapper preserves the
ad-hoc invocation documented throughout the #1517 saga:

    DB_HOST=... DB_PORT=5432 DB_USERNAME=... DB_PASSWORD=... DB_NAME=wxyc_db \\
    LIBRARY_METADATA_URL=... LML_API_KEY=... \\
    python3 scripts/audit/bs_rotation_release_id_pollution.py \\
        --csv audit/rotation_release_id_pollution.csv \\
        --summary audit/rotation_release_id_pollution.md

All flags (``--sources``, ``--include-killed``, ``--limit``, ``--self-test``,
...) pass through unchanged. Note for prod one-offs: prefer running the job's
Docker image on the EC2 host instead of scp'ing this file — see the runbook in
``jobs/rotation-release-id-pollution-check/README.md``.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "jobs", "rotation-release-id-pollution-check"
    ),
)

from pollution_engine import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
