/**
 * Pull a batch of reconciled identities from LML and merge them into the
 * `artists` table. See `job.ts` for the surrounding entry point and the
 * one-shot vs --poll wiring; everything below is the per-run loop body
 * factored out so it can be exercised directly from unit tests.
 *
 * Round-trip count: O(1) per run, regardless of LML row count. One bulk
 * SELECT loads the existing `artists` rows whose name appears in the
 * batch, one bulk UPDATE … FROM (VALUES …) RETURNING applies the
 * COALESCE-in-SET fill across the matching artist rows in a single
 * statement.
 */

import { sql, inArray } from 'drizzle-orm';
import { db, artists, getLastRunTimestamp, updateLastRun } from '@wxyc/database';
import { fetchLmlIdentities, type LmlIdentity } from './fetch-lml.js';
import { columnsInConflict, columnsToFill, type ExistingArtistIdentity } from './transform.js';

export const JOB_NAME = 'artist-identity-etl';

export type SyncResult = {
  /** LML rows fetched */
  scanned: number;
  /** LML rows whose library_name matched at least one artist row */
  matched: number;
  /** Artist rows actually updated (DB-reported via RETURNING) */
  updated: number;
  /** Total column writes across all updates (estimated from pre-update snapshot) */
  columnsWritten: number;
  /** LML rows where at least one matching artist row had a populated, differing value */
  conflicts: number;
};

export const runIncremental = async (): Promise<SyncResult> => {
  const runStartedAt = new Date();
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);

  const identities = await fetchLmlIdentities(lastRunMs);

  if (identities.length === 0) {
    await updateLastRun(JOB_NAME, runStartedAt);
    console.log(`[${JOB_NAME}] Scanned 0 LML rows; nothing to do.`);
    return { scanned: 0, matched: 0, updated: 0, columnsWritten: 0, conflicts: 0 };
  }

  // One round-trip: load every artist row whose name is in this LML batch.
  // artist_name has no unique constraint, so a single name can map to
  // multiple rows. We keep the first match per name for conflict
  // detection (preserving the previous loadExisting semantic), but the
  // bulk UPDATE below applies COALESCE across every matching row.
  const names = identities.map((i) => i.library_name);
  const existingRows = await db
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
    .where(inArray(artists.artist_name, names));

  const firstByName = new Map<string, ExistingArtistIdentity>();
  for (const row of existingRows) {
    if (!firstByName.has(row.artist_name)) {
      firstByName.set(row.artist_name, row);
    }
  }

  let matched = 0;
  let conflicts = 0;
  let columnsWritten = 0;
  const fillCandidates: LmlIdentity[] = [];

  for (const lml of identities) {
    const existing = firstByName.get(lml.library_name);
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
    fillCandidates.push(lml);
    columnsWritten += toFill.length;
  }

  if (fillCandidates.length === 0) {
    await updateLastRun(JOB_NAME, runStartedAt);
    console.log(
      `[${JOB_NAME}] Scanned ${identities.length} LML rows; ` +
        `matched ${matched}; updated 0 artists; conflicts=${conflicts}.`
    );
    return { scanned: identities.length, matched, updated: 0, columnsWritten: 0, conflicts };
  }

  // Single bulk UPDATE … FROM (VALUES …). COALESCE-in-SET preserves any
  // existing non-null value across every matching row, so duplicate
  // artist_names share the same correctness guarantee as the per-row
  // path: staff edits always win.
  //
  // Per-cell type casts are required because postgres-js infers VALUES
  // column types from the first row and several columns can legitimately
  // be NULL there.
  const valuesRows = fillCandidates.map(
    (v) =>
      sql`(${v.library_name}::text, ${v.discogs_artist_id}::integer, ${v.musicbrainz_artist_id}::varchar(64), ${v.wikidata_qid}::varchar(32), ${v.spotify_artist_id}::varchar(64), ${v.apple_music_artist_id}::varchar(64), ${v.bandcamp_id}::varchar(255))`
  );

  const updated = await db.execute(sql`
    UPDATE ${artists} a
    SET
      discogs_artist_id     = COALESCE(a.discogs_artist_id,     v.discogs_artist_id),
      musicbrainz_artist_id = COALESCE(a.musicbrainz_artist_id, v.musicbrainz_artist_id),
      wikidata_qid          = COALESCE(a.wikidata_qid,          v.wikidata_qid),
      spotify_artist_id     = COALESCE(a.spotify_artist_id,     v.spotify_artist_id),
      apple_music_artist_id = COALESCE(a.apple_music_artist_id, v.apple_music_artist_id),
      bandcamp_id           = COALESCE(a.bandcamp_id,           v.bandcamp_id)
    FROM (VALUES ${sql.join(valuesRows, sql`, `)}) AS v(
      library_name,
      discogs_artist_id,
      musicbrainz_artist_id,
      wikidata_qid,
      spotify_artist_id,
      apple_music_artist_id,
      bandcamp_id
    )
    WHERE a.artist_name = v.library_name
      AND (
        (a.discogs_artist_id     IS NULL AND v.discogs_artist_id     IS NOT NULL) OR
        (a.musicbrainz_artist_id IS NULL AND v.musicbrainz_artist_id IS NOT NULL) OR
        (a.wikidata_qid          IS NULL AND v.wikidata_qid          IS NOT NULL) OR
        (a.spotify_artist_id     IS NULL AND v.spotify_artist_id     IS NOT NULL) OR
        (a.apple_music_artist_id IS NULL AND v.apple_music_artist_id IS NOT NULL) OR
        (a.bandcamp_id           IS NULL AND v.bandcamp_id           IS NOT NULL)
      )
    RETURNING a.id
  `);
  const updatedRowCount = Array.isArray(updated) ? updated.length : 0;

  await updateLastRun(JOB_NAME, runStartedAt);
  console.log(
    `[${JOB_NAME}] Scanned ${identities.length} LML rows; ` +
      `matched ${matched}; updated ${updatedRowCount} artist rows ` +
      `(${columnsWritten} columns filled across ${fillCandidates.length} LML rows); ` +
      `conflicts=${conflicts}.`
  );

  return {
    scanned: identities.length,
    matched,
    updated: updatedRowCount,
    columnsWritten,
    conflicts,
  };
};
