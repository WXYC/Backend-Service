/**
 * Pure filter half of scripts/export-unresolved-headliners.ts (BS#1614
 * PR 1). Kept separate from the CLI entry so the unit suite imports it
 * without side effects, and kept out of jobs/triangle-shows-etl/ because
 * the reasons taxonomy is an export-measurement concern, not an ETL one.
 *
 * Pipeline per dump line (one `headlining_artist_raw` per line):
 * trim/dedupe -> `extractHeadliner` (normalizes rows scraped before
 * BS#1604 deployed; idempotent on already-clean rows) ->
 * `isCleanHeadliner` gate -> clean list or per-reason gated bucket.
 * Everything dedupes on the EXTRACTED form, so a legacy `(SOLD OUT) X`
 * row and its re-scraped `X` sibling collapse to one entry.
 */

import {
  extractHeadliner,
  isCleanHeadliner,
  BILLING_DELIMITER_PATTERNS,
} from '../../jobs/triangle-shows-etl/headliner.js';

/**
 * Why a name was withheld from the LML-eligible set: one of the hard
 * billing delimiters, or `extraction_residue` — the post-extraction gate
 * failed with no delimiter present, which (extraction being idempotent)
 * is exactly the pure-tag fallback case (`(SOLD OUT)`, `(18+)`).
 */
export type GateReason = keyof typeof BILLING_DELIMITER_PATTERNS | 'extraction_residue';

export type HeadlinerDumpSummary = {
  /** Raw dump lines, blanks included. */
  totalLines: number;
  /** Distinct trimmed non-empty raw names. */
  distinctRaw: number;
  /** Distinct raws that `extractHeadliner` changed (pre-BS#1604 legacy shapes). */
  extractionChanged: number;
  /** Sorted distinct extracted names passing `isCleanHeadliner` — the LML#759 handoff. */
  clean: string[];
  /** Sorted distinct extracted names withheld, bucketed by first-matching reason. */
  gated: Record<GateReason, string[]>;
};

export const summarizeHeadlinerDump = (lines: string[]): HeadlinerDumpSummary => {
  const distinct = [...new Set(lines.map((line) => line.trim()).filter((line) => line !== ''))];

  let extractionChanged = 0;
  const clean = new Set<string>();
  const gatedSeen = new Set<string>();
  const gated: Record<GateReason, string[]> = {
    comma: [],
    plus: [],
    slash: [],
    with: [],
    extraction_residue: [],
  };

  for (const raw of distinct) {
    const extracted = extractHeadliner(raw);
    if (extracted !== raw) extractionChanged += 1;
    if (isCleanHeadliner(extracted)) {
      clean.add(extracted);
      continue;
    }
    if (gatedSeen.has(extracted)) continue;
    gatedSeen.add(extracted);
    const delimiter = (Object.entries(BILLING_DELIMITER_PATTERNS) as [GateReason, RegExp][]).find(([, pattern]) =>
      pattern.test(extracted)
    );
    gated[delimiter?.[0] ?? 'extraction_residue'].push(extracted);
  }

  for (const names of Object.values(gated)) names.sort();

  return {
    totalLines: lines.length,
    distinctRaw: distinct.length,
    extractionChanged,
    clean: [...clean].sort(),
    gated,
  };
};

/** The measurement block posted to WXYC/Backend-Service#1614 (stderr). */
export const formatSummary = (summary: HeadlinerDumpSummary): string => {
  const gatedTotal = Object.values(summary.gated).reduce((count, names) => count + names.length, 0);
  return [
    `input lines: ${summary.totalLines}`,
    `distinct raw names: ${summary.distinctRaw}`,
    `changed by extraction: ${summary.extractionChanged}`,
    `clean (LML-eligible): ${summary.clean.length}`,
    `gated out: ${gatedTotal}`,
    ...Object.entries(summary.gated).map(([reason, names]) => `  ${reason}: ${names.length}`),
  ].join('\n');
};
