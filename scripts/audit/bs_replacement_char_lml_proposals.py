"""Phase 2 candidate generator: query LML for canonical replacements of the
U+FFFD-form lossy values surfaced by `bs_replacement_char_audit.py` (#863).

Reads the Phase 1 CSV produced by the audit, queries LML's `/api/v1/lookup`
endpoint for each distinct lossy value, and writes a candidates CSV with
match confidence scores. Threshold defaults to >= 0.80 per the V015/V016
`lml-fuzzy` convention.

STOP point per #863 plan: this script writes a candidates CSV intended for
human review. No migration SQL is generated. Reviewers approve / drop rows
in the CSV by hand before the migration script is authored.

The script is intentionally simple — single-threaded, sequential — because
LML's /lookup is rate-sensitive (Discogs cross-reference path) and the
expected distinct-value count is on the order of dozens to a few hundred.
On longer audits, throttle via `--sleep-ms` rather than adding parallelism;
LML guards Discogs throughput.

Read-only against the database. Writes only the candidates CSV.

Usage:
    LIBRARY_METADATA_URL=https://lml.example LML_API_KEY=... \\
    python3 scripts/audit/bs_replacement_char_lml_proposals.py \\
        --input audit/bs_replacement_char_audit.csv \\
        --output audit/bs_replacement_char_proposals.csv \\
        --min-confidence 0.80
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterable

REPLACEMENT_CHAR = '�'


# -----------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/audit/)
# -----------------------------------------------------------------------------


def strip_replacement_chars(value: str) -> str:
    """Drop U+FFFD codepoints from the string. Used to build a probe term
    for LML's parser — leaving U+FFFD in the raw_message would defeat any
    fuzzy match because the canonical form never contains it."""
    return value.replace(REPLACEMENT_CHAR, '')


def build_raw_message(table: str, column: str, lossy_value: str) -> str:
    """Construct the `raw_message` body for LML's /lookup endpoint.

    The strategy is column-driven:
        artist_name → probe as artist
        track_title → probe as artist + " " + track (LML's track-driven path
                      needs artist context for ranking)
        album_title / record_label / label → probe as raw text; LML's
                      raw_message parser will route.
    """
    probe = strip_replacement_chars(lossy_value).strip()
    if not probe:
        return ''
    if column == 'artist_name':
        return probe
    if column == 'track_title':
        return probe
    # album_title, record_label, label — send the cleaned text as raw_message;
    # LML's parser will treat it as a free-form description.
    return probe


def score_to_confidence(match_score: float | int | None) -> float:
    """Normalize an LML match score (0-1) to a confidence float.

    LML returns scores already in [0, 1] for fuzzy matches. Defensive
    clamp so a wonky upstream response can't break the CSV downstream.
    """
    if match_score is None:
        return 0.0
    try:
        v = float(match_score)
    except (TypeError, ValueError):
        return 0.0
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


# -----------------------------------------------------------------------------
# LML client (HTTP via urllib; avoid extra deps for an audit-only script)
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class LmlCandidate:
    canonical_artist: str
    canonical_album: str
    confidence: float
    source: str  # e.g. 'lml-fuzzy', 'lml-library', 'lml-discogs'


def query_lml(
    url: str,
    raw_message: str,
    *,
    api_key: str | None = None,
    timeout: float = 10.0,
    logger: logging.Logger | None = None,
) -> list[dict]:
    """POST /api/v1/lookup and return the parsed `library_matches` list.

    Returns an empty list on any non-2xx response or on JSON parse failure;
    Phase 2 is best-effort and a single failure shouldn't abort the audit.
    """
    log = logger or logging.getLogger(__name__)
    payload = {'raw_message': raw_message}
    body = json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'
    req = urllib.request.Request(
        url=url.rstrip('/') + '/api/v1/lookup',
        data=body,
        headers=headers,
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
            raw = resp.read()
    except urllib.error.HTTPError as e:
        log.warning('LML HTTP %s for %r: %s', e.code, raw_message, e.reason)
        return []
    except urllib.error.URLError as e:
        log.warning('LML URL error for %r: %s', raw_message, e.reason)
        return []
    except TimeoutError:
        log.warning('LML timeout for %r', raw_message)
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning('LML returned non-JSON for %r', raw_message)
        return []
    matches = parsed.get('library_matches') or parsed.get('matches') or []
    if not isinstance(matches, list):
        return []
    return matches


def parse_candidates(matches: list[dict]) -> list[LmlCandidate]:
    """Project LML's `library_matches` to the audit's LmlCandidate shape.

    Tolerant of multiple LML response shapes — the freeform `match_score` /
    `confidence` keys have rotated over LML's evolution, so we try both.
    """
    out: list[LmlCandidate] = []
    for m in matches:
        if not isinstance(m, dict):
            continue
        artist = (m.get('artist_name') or m.get('canonical_artist') or '').strip()
        album = (m.get('album_title') or m.get('canonical_album') or '').strip()
        score = m.get('match_score', m.get('confidence'))
        source = (m.get('matched_via') or m.get('source') or 'lml-fuzzy').strip() or 'lml-fuzzy'
        out.append(
            LmlCandidate(
                canonical_artist=artist,
                canonical_album=album,
                confidence=score_to_confidence(score),
                source=source,
            )
        )
    return out


# -----------------------------------------------------------------------------
# Driver
# -----------------------------------------------------------------------------


@dataclass
class ProposalRow:
    table: str
    column: str
    lossy_value: str
    row_count: int
    canonical_artist: str
    canonical_album: str
    confidence: float
    source: str


def read_audit_csv(path: str) -> list[tuple[str, str, str, int]]:
    """Returns [(table, column, lossy_value, row_count), ...]."""
    out: list[tuple[str, str, str, int]] = []
    with open(path, newline='') as fp:
        r = csv.DictReader(fp)
        for row in r:
            out.append(
                (
                    row['table'],
                    row['column'],
                    row['lossy_value'],
                    int(row['row_count']),
                )
            )
    return out


def generate_proposals(
    audit_rows: Iterable[tuple[str, str, str, int]],
    lml_url: str,
    api_key: str | None,
    min_confidence: float,
    *,
    sleep_ms: int = 0,
    logger: logging.Logger | None = None,
) -> list[ProposalRow]:
    log = logger or logging.getLogger(__name__)
    proposals: list[ProposalRow] = []
    for i, (table, column, lossy_value, row_count) in enumerate(audit_rows):
        raw_message = build_raw_message(table, column, lossy_value)
        if not raw_message:
            log.info('skip %s.%s row %r: empty probe after stripping U+FFFD',
                     table, column, lossy_value)
            continue
        log.info('[%d] %s.%s probe=%r', i + 1, table, column, raw_message)
        matches = query_lml(lml_url, raw_message, api_key=api_key, logger=log)
        candidates = parse_candidates(matches)
        if not candidates:
            log.info('  no candidates returned')
            continue
        best = max(candidates, key=lambda c: c.confidence)
        if best.confidence < min_confidence:
            log.info('  top candidate confidence %.2f < %.2f cutoff; dropping',
                     best.confidence, min_confidence)
            continue
        proposals.append(
            ProposalRow(
                table=table,
                column=column,
                lossy_value=lossy_value,
                row_count=row_count,
                canonical_artist=best.canonical_artist,
                canonical_album=best.canonical_album,
                confidence=best.confidence,
                source=best.source,
            )
        )
        log.info('  → %r / %r (conf=%.2f, src=%s)',
                 best.canonical_artist, best.canonical_album, best.confidence, best.source)
        if sleep_ms:
            time.sleep(sleep_ms / 1000.0)
    return proposals


def write_proposals_csv(proposals: list[ProposalRow], path: str) -> None:
    """Proposals CSV sorted by (table, column, -row_count, lossy_value).

    Format intentionally matches the structure a reviewer expects: lossy on
    the left, canonical recovery on the right, with row_count as the
    triage priority and confidence as the auto-apply discriminator.
    """
    proposals_sorted = sorted(
        proposals,
        key=lambda p: (p.table, p.column, -p.row_count, p.lossy_value),
    )
    with open(path, 'w', newline='') as fp:
        w = csv.writer(fp)
        w.writerow(
            [
                'table',
                'column',
                'lossy_value',
                'row_count',
                'canonical_artist',
                'canonical_album',
                'confidence',
                'source',
                'approved',  # Reviewer fills in: y/n
            ]
        )
        for p in proposals_sorted:
            w.writerow(
                [
                    p.table,
                    p.column,
                    p.lossy_value,
                    p.row_count,
                    p.canonical_artist,
                    p.canonical_album,
                    f'{p.confidence:.4f}',
                    p.source,
                    '',  # left blank for reviewer
                ]
            )


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    p.add_argument('--input', default='audit/bs_replacement_char_audit.csv',
                   help='Phase 1 audit CSV.')
    p.add_argument('--output', default='audit/bs_replacement_char_proposals.csv',
                   help='Candidates CSV (output).')
    p.add_argument('--min-confidence', type=float, default=0.80,
                   help='lml-fuzzy cutoff per V015/V016 convention.')
    p.add_argument('--lml-url', default=os.environ.get('LIBRARY_METADATA_URL'),
                   help='LML base URL (default: $LIBRARY_METADATA_URL).')
    p.add_argument('--lml-api-key', default=os.environ.get('LML_API_KEY'),
                   help='LML bearer token (default: $LML_API_KEY).')
    p.add_argument('--sleep-ms', type=int, default=0,
                   help='Sleep between LML calls in milliseconds (rate-throttling).')
    p.add_argument('--log-level', default='INFO',
                   choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'])
    args = p.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format='%(asctime)s [%(levelname)s] %(message)s',
        stream=sys.stderr,
    )
    log = logging.getLogger('bs_replacement_char_lml_proposals')

    if not args.lml_url:
        log.error('LIBRARY_METADATA_URL is not set (pass --lml-url or set env)')
        return 2

    try:
        audit_rows = read_audit_csv(args.input)
    except FileNotFoundError:
        log.error('audit CSV not found: %s (run bs_replacement_char_audit.py first)',
                  args.input)
        return 2
    except Exception:
        log.exception('failed to parse audit CSV %s', args.input)
        return 1

    log.info('loaded %d audit rows from %s', len(audit_rows), args.input)
    proposals = generate_proposals(
        audit_rows,
        args.lml_url,
        args.lml_api_key,
        args.min_confidence,
        sleep_ms=args.sleep_ms,
        logger=log,
    )
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    write_proposals_csv(proposals, args.output)
    log.info(
        'wrote %s (%d proposals at conf >= %.2f)',
        args.output, len(proposals), args.min_confidence,
    )
    log.info('STOP: review proposals before authoring migration SQL.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
