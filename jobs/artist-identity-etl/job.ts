/**
 * Artist Identity ETL: copy reconciled external IDs from LML's
 * `entity.identity` table into Backend-Service's `artists` table.
 *
 * Modes:
 *   node dist/job.js          one-shot incremental (default)
 *   node dist/job.js --poll   continuous polling
 *
 * Matching: exact case-sensitive equality on
 * `entity.identity.library_name = artists.artist_name`. Both sides treat
 * `library_name` as the canonical artist key so exact match covers most
 * real entries; mismatches surface in the run log as unmatched and can
 * inform a follow-up normalization pass.
 *
 * Update strategy: only fills nulls. Each column on `artists` keeps its
 * existing value if non-null (so any value entered by the library staff
 * wins over an LML-derived one), and conflicts are logged but not
 * applied. This matches #506's "never overwrite human edits" requirement.
 */

import { eq, sql } from 'drizzle-orm';
import {
  db,
  artists,
  closeDatabaseConnection,
  getLastRunTimestamp,
  updateLastRun,
  runPollingLoop,
} from '@wxyc/database';
import { fetchLmlIdentities, closeLmlConnection, type LmlIdentity } from './fetch-lml.js';
import { columnsInConflict, columnsToFill, type ExistingArtistIdentity } from './transform.js';

const JOB_NAME = 'artist-identity-etl';

type SyncResult = {
  /** LML rows fetched */
  scanned: number;
  /** LML rows whose library_name matched an artist row */
  matched: number;
  /** Artist rows actually updated (had at least one null to fill) */
  updated: number;
  /** Total column writes across all updates */
  columnsWritten: number;
  /** Conflicts detected (existing non-null value differs from LML's value) */
  conflicts: number;
};

const runIncremental = async (): Promise<SyncResult> => {
  const runStartedAt = new Date();
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);

  const identities = await fetchLmlIdentities(lastRunMs);

  let matched = 0;
  let updated = 0;
  let columnsWritten = 0;
  let conflicts = 0;

  for (const lml of identities) {
    const existing = await loadExisting(lml.library_name);
    if (!existing) continue;
    matched++;

    const conflicting = columnsInConflict(existing, lml);
    if (conflicting.length > 0) {
      conflicts++;
      for (const key of conflicting) {
        console.warn(
          `[${JOB_NAME}] Conflict on ${lml.library_name}.${key}: ` +
            `existing=${JSON.stringify(existing[key])} lml=${JSON.stringify(lml[key])} (skipped)`
        );
      }
    }

    const toFill = columnsToFill(existing, lml);
    if (toFill.length === 0) continue;

    await applyFill(lml, toFill);
    updated++;
    columnsWritten += toFill.length;
  }

  await updateLastRun(JOB_NAME, runStartedAt);
  console.log(
    `[${JOB_NAME}] Scanned ${identities.length} LML rows; ` +
      `matched ${matched}; updated ${updated} artists ` +
      `(${columnsWritten} columns filled); conflicts=${conflicts}.`
  );

  return { scanned: identities.length, matched, updated, columnsWritten, conflicts };
};

const loadExisting = async (artistName: string): Promise<ExistingArtistIdentity | null> => {
  const [row] = await db
    .select({
      artist_name: artists.artist_name,
      discogs_artist_id: artists.discogs_artist_id,
      musicbrainz_artist_id: artists.musicbrainz_artist_id,
      wikidata_qid: artists.wikidata_qid,
      spotify_artist_id: artists.spotify_artist_id,
      apple_music_artist_id: artists.apple_music_artist_id,
      bandcamp_id: artists.bandcamp_id,
    })
    .from(artists)
    .where(eq(artists.artist_name, artistName))
    .limit(1);
  return row ?? null;
};

/**
 * Writes only the columns in `toFill`, and uses `COALESCE(<col>, $value)`
 * in the SET expression so the database itself enforces "fill nulls
 * only" -- existing non-null values are preserved at the row level. This
 * is correctness-critical because `artists.artist_name` has no unique
 * constraint: a name like "Stereolab" might match multiple rows with
 * different existing values. The caller's `loadExisting` only inspects
 * one row, but this UPDATE applies to all matching rows, and COALESCE
 * keeps each row's existing value where one already exists.
 */
const applyFill = async (lml: LmlIdentity, toFill: Array<keyof Omit<LmlIdentity, 'library_name'>>): Promise<void> => {
  const set: Record<string, ReturnType<typeof sql>> = {};
  for (const key of toFill) {
    const value = lml[key];
    if (key === 'discogs_artist_id') set.discogs_artist_id = sql`COALESCE(${artists.discogs_artist_id}, ${value})`;
    else if (key === 'musicbrainz_artist_id')
      set.musicbrainz_artist_id = sql`COALESCE(${artists.musicbrainz_artist_id}, ${value})`;
    else if (key === 'wikidata_qid') set.wikidata_qid = sql`COALESCE(${artists.wikidata_qid}, ${value})`;
    else if (key === 'spotify_artist_id') set.spotify_artist_id = sql`COALESCE(${artists.spotify_artist_id}, ${value})`;
    else if (key === 'apple_music_artist_id')
      set.apple_music_artist_id = sql`COALESCE(${artists.apple_music_artist_id}, ${value})`;
    else if (key === 'bandcamp_id') set.bandcamp_id = sql`COALESCE(${artists.bandcamp_id}, ${value})`;
  }
  await db.update(artists).set(set).where(eq(artists.artist_name, lml.library_name));
};

const run = async () => {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--poll')) {
      await runPollingLoop(
        async () => {
          const result = await runIncremental();
          return { hasChanges: result.updated > 0 };
        },
        { jobName: JOB_NAME, notifyPath: '/internal/artist-identity-sync-notify' }
      );
    } else {
      await runIncremental();
    }
  } finally {
    await closeDatabaseConnection();
    await closeLmlConnection();
  }
};

run().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});
