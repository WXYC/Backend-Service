/**
 * BS#1614 PR 1: export the clean unresolved concert-headliner name set —
 * the handoff file for LML#759's drain script, plus the fresh
 * measurement replacing the stale 2026-07-11 142/252 split.
 *
 * Deliberately DB-free (imports only jobs/triangle-shows-etl/headliner.ts,
 * never `@wxyc/database`): the dump comes from a one-line psql on the
 * prod host, and this script filters it anywhere, no credentials needed.
 *
 * Usage:
 *   1. Dump distinct unresolved upcoming headliner names on the prod host
 *      (read-only; upcoming-only so no Discogs budget is ever spent on
 *      past shows):
 *
 *        psql "$DATABASE_URL" -At -c "SELECT DISTINCT headlining_artist_raw FROM wxyc_schema.concerts WHERE headlining_artist_id IS NULL AND headlining_artist_raw IS NOT NULL AND removed_at IS NULL AND starts_on >= CURRENT_DATE ORDER BY 1" > unresolved-headliners.txt
 *
 *   2. Filter locally:
 *
 *        npx tsx scripts/export-unresolved-headliners.ts unresolved-headliners.txt > clean-names.txt
 *
 *      (or pipe the dump on stdin and omit the file argument.)
 *
 * stdout: the sorted clean-name list, one per line — LML#759's input.
 * stderr: the measurement summary + the gated-out names per reason, for
 *         the BS#1614 comment.
 */

import { readFileSync } from 'node:fs';

import { formatSummary, summarizeHeadlinerDump } from './lib/headliner-export.js';

const source = process.argv[2];
// fd 0 = stdin; readFileSync on it blocks until EOF, which is exactly the
// pipe semantics we want for `psql ... | tsx <this script>`.
const raw = readFileSync(source ?? 0, 'utf8');
const summary = summarizeHeadlinerDump(raw.split(/\r?\n/));

if (summary.distinctRaw === 0) {
  console.error('export-unresolved-headliners: no names in input — is the dump empty?');
  process.exit(1);
}

process.stdout.write(summary.clean.join('\n') + '\n');

console.error(formatSummary(summary));
for (const [reason, names] of Object.entries(summary.gated)) {
  if (names.length === 0) continue;
  console.error(`\ngated (${reason}):`);
  for (const name of names) console.error(`  ${name}`);
}
