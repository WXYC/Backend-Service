/**
 * E2E fixture driver for the album-reviews ETL pipeline (ADR 0011).
 *
 * Runs the REAL orchestrator (`runEtl`) with the REAL header mapping
 * (`resolveHeaderIndexes`/`mapRow`, invoked inside `runEtl`), the REAL DB
 * writer (`upsertSubmission`) and the REAL link pass (`linkSubmissions`) —
 * only the network fetch is swapped for an in-memory sheet fixture. That
 * exercises the map → upsert → link chain against a real Postgres exactly
 * as production does, minus the live Google Sheets HTTP (the same seam the
 * unit fetch suite covers; see venue-events-fixture-run.ts for the
 * pattern).
 *
 * Invoked as a child process by `tests/e2e/album-reviews-pipeline.test.ts`,
 * so `@wxyc/database` binds to whatever DB_* the parent passes in the env.
 * Prints the run totals as JSON on stdout (the last line) and exits
 * non-zero if the orchestrator's run guards throw.
 *
 * The fixture mirrors the live sheet's shape: the dead long-form
 * "Buzzwords about the album" column sits BEFORE the live `Buzzwords`
 * column (the exact-match trap map.ts exists to sidestep), one row is
 * formula residue with no artist/album (validity-filter target), and the
 * timestamps cover the sheet's M/D/YYYY ET wall-clock format.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runEtl } from '../../../jobs/album-reviews-etl/orchestrate.js';
import { upsertSubmission } from '../../../jobs/album-reviews-etl/writer.js';
import { linkSubmissions } from '../../../jobs/album-reviews-etl/link.js';
import { initLogger, closeLogger } from '../../../jobs/album-reviews-etl/logger.js';

const HEADERS = [
  'Timestamp',
  'Artist Name',
  'Album Name',
  'Record Label',
  'Please write a short 1-2 sentences about the artist',
  'Please write your review here',
  'Please identify at least 2 recommended tracks',
  'Name of reviewer, and date',
  'List any FCC violations by track number',
  // Dead long-form column — 0 responses on the live sheet; must NOT be
  // confused with the live short `Buzzwords` column below.
  'Buzzwords about the album (examples include: jazzy, ambient, harsh)',
  'Buzzwords',
  'Are you comfortable with us sharing this review on social media?',
  'Was this album released within the last 6 months?',
  'What is this review for?',
  'rotated? (y/n)',
];

// Row 1: EDT wall clock (2021-03-15 13:45:12 ET = 17:45:12 UTC); the
// library row the e2e test seeds makes this the singleton link target.
// Row 2: EST wall clock (2015-01-20 22:10:05 ET = 2015-01-21 03:10:05 UTC);
// no matching library row → link_unmatched.
// Row 3: formula residue (no artist/album) → skipped_invalid.
const DATA_ROWS: string[][] = [
  [
    '3/15/2021 13:45:12',
    'Juana Molina',
    'DOGA',
    'Sonamos',
    'Argentine electronic-folk auteur.',
    'Hypnotic layered loops; a late-night staple.',
    '1, 3 (!!!!), 5',
    'A Real Name, 3/15/21',
    'None',
    '',
    'hypnotic, electronic, folk',
    'Yes, but remove my name',
    'Yes',
    'Rotation',
    'y',
  ],
  [
    '1/20/2015 22:10:05',
    'Jessica Pratt',
    'On Your Own Love Again',
    'Drag City',
    'Whispered folk miniatures out of Los Angeles.',
    'Timeless. Back, Baby is the anchor.',
    '2 (!!!), 4',
    'Another Real Name, 1/20/15',
    '',
    '',
    'folk, intimate',
    'No',
    'No',
    'New DJ Assignment',
    'n',
  ],
  ['B1163='],
];

const SHEET_FIXTURE: string[][] = [HEADERS, ...DATA_ROWS];

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: 'album-reviews-fixture-run' });
  try {
    const totals = await runEtl({
      fetchRows: () => Promise.resolve(SHEET_FIXTURE),
      upsertSubmission,
      linkPass: () => linkSubmissions(),
      dryRun: false,
    });
    process.stdout.write(`${JSON.stringify(totals)}\n`);
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack || String(error)}\n`);
  process.exitCode = 1;
});
