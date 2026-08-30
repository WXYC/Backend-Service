/**
 * Digital-archive playback manifest read (BS#2320, epic
 * WXYC/wxyc-dj-ios#135). Backs `GET /digital-archive/albums/:id/playback`.
 *
 * MERGE, DON'T ELECT (issue #2320 wave-1 retrospective correction). The
 * unique key on `digital_asset` is `(library_id, provenance, disc_number)`,
 * so one album can have several `bound` assets — a multi-disc set today
 * (same provenance, several `disc_number`s), and eventually a `cd_rip`
 * alongside an existing `rotation_upload`. This manifest merges EVERY
 * `bound` asset for the album with no precedence rule, because
 * `DigitalArchivePlaybackTrack.provenance` moved off the manifest and onto
 * the track (wxyc-shared#422) precisely so a merged manifest never has to
 * elect a winner and misreport every track sourced from the others.
 *
 * ORDERING SPANS THE JOIN. `disc_number` lives on `digital_asset`, NOT on
 * `digital_asset_file` — the `(disc_number, track_number NULLS LAST, title)`
 * order therefore reads `disc_number` off the parent asset row for each file.
 *
 * ALL CODECS, NOT JUST MP3. wxyc-shared#422 widened the codec enum to
 * `[mp3, aac, flac, m4a, wav]`; this service emits every rendition the
 * archive holds rather than filtering to `mp3`.
 *
 * A "SERVABLE FILE" TODAY IS ANY `digital_asset_file` ROW. The schema has no
 * per-file readiness/status column yet (only `digital_asset.status`, checked
 * below as `= 'bound'`) — when one lands, filter renditions on it here and
 * drop a track down to zero renditions rather than shipping an unservable
 * one; the "no tracks -> null -> 404" rule below already covers that case.
 *
 * EMPTY RESULT IS `null`, NEVER AN EMPTY MANIFEST (issue #2320 decision
 * comment). A bound asset whose files are absent, not yet ingested, or (once
 * a readiness column exists) all unready is NOT a bound asset for playback
 * purposes: the controller 404s. This keeps "200 means you can play this"
 * true and preserves the endpoint's 403 (feature off / below `dj`) vs 404
 * (permitted, nothing to play) split. `has_digital_audio`
 * (`catalog-export.service.ts`) is format-blind (`EXISTS ... status =
 * 'bound'`) so it stays consistent with what this endpoint actually serves.
 */

import { sql } from 'drizzle-orm';
import { db, digital_asset, digital_asset_file, digital_asset_store } from '@wxyc/database';
import type { DigitalArchivePlaybackManifest, DigitalArchivePlaybackTrack } from '@wxyc/shared/dtos';
import { getConfig } from '../config/digitalArchive.js';
import { presignGet } from './digital-archive-store.service.js';

type PlaybackFileRow = {
  file_id: number;
  asset_id: number;
  provenance: string;
  disc_number: number;
  track_number: number | null;
  title: string;
  duration_secs: number | null;
  md5: string | null;
  codec: string;
  bitrate_kbps: number | null;
  object_key: string;
  store_name: string;
};

/**
 * Every file backing a `bound` asset for `libraryId`, across every such
 * asset. `ORDER BY` carries both the manifest's required sort
 * (`disc_number`, `track_number NULLS LAST`, `title`) and a trailing
 * `file.id` tiebreak that makes the per-track rendition grouping below
 * deterministic — the first row of a (asset, track_number, title) group is
 * always its lowest-id file.
 */
const getPlaybackFileRows = async (libraryId: number): Promise<PlaybackFileRow[]> => {
  const rows = await db.execute(sql`
    SELECT
      ${digital_asset_file.id}           AS file_id,
      ${digital_asset.id}                AS asset_id,
      ${digital_asset.provenance}        AS provenance,
      ${digital_asset.disc_number}       AS disc_number,
      ${digital_asset_file.track_number} AS track_number,
      ${digital_asset_file.title}        AS title,
      ${digital_asset_file.duration_secs} AS duration_secs,
      ${digital_asset_file.md5}          AS md5,
      ${digital_asset_file.codec}        AS codec,
      ${digital_asset_file.bitrate_kbps} AS bitrate_kbps,
      ${digital_asset_file.object_key}   AS object_key,
      ${digital_asset_store.name}        AS store_name
    FROM ${digital_asset}
      INNER JOIN ${digital_asset_file} ON ${digital_asset_file.asset_id} = ${digital_asset.id}
      INNER JOIN ${digital_asset_store} ON ${digital_asset_store.id} = ${digital_asset_file.store_id}
    WHERE ${digital_asset.library_id} = ${libraryId} AND ${digital_asset.status} = 'bound'
    ORDER BY ${digital_asset.disc_number} ASC,
             ${digital_asset_file.track_number} ASC NULLS LAST,
             ${digital_asset_file.title} ASC,
             ${digital_asset_file.id} ASC
  `);
  return rows as unknown as PlaybackFileRow[];
};

/** Groups file rows into one track per (asset, track_number, title), preserving
 * the SQL-established order (each group's first-seen row is its rendition list's
 * first entry, which the id ASC tiebreak makes the lowest-id file). */
const groupIntoTracks = (rows: PlaybackFileRow[]): { row: PlaybackFileRow; renditions: PlaybackFileRow[] }[] => {
  const order: string[] = [];
  const groups = new Map<string, { row: PlaybackFileRow; renditions: PlaybackFileRow[] }>();
  for (const row of rows) {
    const key = `${row.asset_id}|${row.track_number ?? 'null'}|${row.title}`;
    const existing = groups.get(key);
    if (existing) {
      existing.renditions.push(row);
    } else {
      groups.set(key, { row, renditions: [row] });
      order.push(key);
    }
  }
  return order.map((key) => groups.get(key)!);
};

const toTrack = (
  group: { row: PlaybackFileRow; renditions: PlaybackFileRow[] },
  urlByFileId: Map<number, string>
): DigitalArchivePlaybackTrack => ({
  file_id: group.row.file_id,
  provenance: group.row.provenance as DigitalArchivePlaybackTrack['provenance'],
  disc_number: group.row.disc_number,
  track_number: group.row.track_number,
  title: group.row.title,
  duration_secs: group.row.duration_secs,
  content_hash: group.row.md5,
  renditions: group.renditions.map((r) => ({
    codec: r.codec as DigitalArchivePlaybackTrack['renditions'][number]['codec'],
    bitrate_kbps: r.bitrate_kbps,
    url: urlByFileId.get(r.file_id)!,
  })),
});

/**
 * Builds the playback manifest for `libraryId`, or `null` when there is
 * nothing servable to play (no `bound` asset, or every `bound` asset has no
 * files) — see the module doc comment for why this is `null` rather than an
 * empty-`tracks` manifest.
 */
export const getPlaybackManifest = async (libraryId: number): Promise<DigitalArchivePlaybackManifest | null> => {
  const rows = await getPlaybackFileRows(libraryId);
  if (rows.length === 0) return null;

  const groups = groupIntoTracks(rows);
  const { signTTLSeconds } = getConfig();

  // Presign every file exactly once. Several files commonly share a store
  // name (they usually all live in `azuracast`); `presignGet`'s own
  // per-store S3Client cache makes that cheap.
  const urlByFileId = new Map<number, string>(
    await Promise.all(
      rows.map(async (r) => [r.file_id, await presignGet(r.store_name, r.object_key, signTTLSeconds)] as const)
    )
  );

  return {
    library_id: libraryId,
    expires_at: new Date(Date.now() + signTTLSeconds * 1000).toISOString(),
    tracks: groups.map((g) => toTrack(g, urlByFileId)),
  };
};
