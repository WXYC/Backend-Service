/**
 * Pure formatter for the run summary (step 6: "a summary report (files seen
 * / skipped by rule / grouped albums / exact / fuzzy / unmatched, by
 * prefix)"). Kept separate from `orchestrate.ts` so the output shape is
 * unit-testable without a database or an S3 client.
 */

import type { BoundDrift, RejectedBlocked, SameRunCollision } from './write.js';

export interface RunSummary {
  mode: 'dry-run' | 'apply';
  filesSeen: number;
  skippedByReason: Record<string, number>;
  albumsGrouped: number;
  ungroupableFiles: number;
  matchedExact: number;
  matchedFuzzy: number;
  ambiguous: number;
  unmatched: number;
  inserted: number;
  reopened: number;
  rejectedBlocked: RejectedBlocked[];
  boundDrift: BoundDrift[];
  sameRunCollision: SameRunCollision[];
}

export const formatSummary = (summary: RunSummary): string => {
  const lines: string[] = [];
  lines.push(`=== digital-archive-bind (${summary.mode.toUpperCase()}) ===`);
  lines.push(`files seen:        ${summary.filesSeen}`);
  for (const [reason, count] of Object.entries(summary.skippedByReason).sort()) {
    lines.push(`  skipped (${reason}): ${count}`);
  }
  lines.push(`albums grouped:    ${summary.albumsGrouped}`);
  lines.push(`ungroupable files: ${summary.ungroupableFiles}`);
  lines.push(`matched exact:     ${summary.matchedExact}`);
  lines.push(`matched fuzzy:     ${summary.matchedFuzzy}`);
  lines.push(`ambiguous:         ${summary.ambiguous}`);
  lines.push(`unmatched:         ${summary.unmatched}`);
  lines.push(
    summary.mode === 'apply'
      ? `inserted (needs_review): ${summary.inserted}`
      : `would insert (needs_review): ${summary.inserted}`
  );
  if (summary.reopened > 0 || summary.rejectedBlocked.length > 0) {
    lines.push(
      summary.mode === 'apply'
        ? `reopened (--rebind-keys): ${summary.reopened}`
        : `would reopen (--rebind-keys): ${summary.reopened}`
    );
  }

  if (summary.rejectedBlocked.length > 0) {
    lines.push('');
    lines.push(
      `blocked by a prior rejection (${summary.rejectedBlocked.length}) -- rerun with --rebind-keys to override:`
    );
    for (const r of summary.rejectedBlocked) {
      lines.push(`  library_id=${r.libraryId} disc=${r.discNumber}: ${r.objectKeys.join(', ')}`);
    }
  }

  if (summary.boundDrift.length > 0) {
    lines.push('');
    lines.push(
      `bound slots whose files drifted from what's playable (${summary.boundDrift.length}) -- human call, nothing written:`
    );
    for (const d of summary.boundDrift) {
      lines.push(`  asset_id=${d.assetId} library_id=${d.libraryId} disc=${d.discNumber}`);
      lines.push(`    bound:     ${d.boundKeys.join(', ')}`);
      lines.push(`    candidate: ${d.candidateKeys.join(', ')}`);
    }
  }

  if (summary.sameRunCollision.length > 0) {
    lines.push('');
    lines.push(
      `two candidates in this run wanted the same slot (${summary.sameRunCollision.length}) -- only the first was queued, the rest are unwritten:`
    );
    for (const c of summary.sameRunCollision) {
      lines.push(`  library_id=${c.libraryId} disc=${c.discNumber}: ${c.objectKeys.join(', ')}`);
    }
  }

  return lines.join('\n');
};
