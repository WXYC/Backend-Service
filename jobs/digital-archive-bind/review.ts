/**
 * CSV/DB glue for step 5's `--export`/`--import`. Deliberately separate
 * from `write.ts` (the match-write planner) -- this module reads back what
 * was already written, on its own schedule, independent of an inventory
 * run.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, digital_asset, digital_asset_file, library } from '@wxyc/database';
import { classifyObjectKey } from './classify.js';
import type { ReviewDecision, ReviewRow } from './csv.js';
import { PROVENANCE } from './write.js';

/**
 * Every `needs_review` asset this job owns, joined to its files and its
 * `library` row. `content_kind` (the CSV's "prefix" column) has no column
 * of its own on either table -- it is re-derived from an object key via
 * `classifyObjectKey`, the same function that decided it during inventory.
 */
export const loadNeedsReviewRows = async (): Promise<ReviewRow[]> => {
  const assets = await db
    .select({
      id: digital_asset.id,
      libraryId: digital_asset.library_id,
      discNumber: digital_asset.disc_number,
      bindNote: digital_asset.bind_note,
    })
    .from(digital_asset)
    .where(and(eq(digital_asset.provenance, PROVENANCE), eq(digital_asset.status, 'needs_review')));

  if (assets.length === 0) return [];

  const assetIds = assets.map((a) => a.id);
  const files = await db
    .select({
      assetId: digital_asset_file.asset_id,
      objectKey: digital_asset_file.object_key,
      tagArtist: digital_asset_file.tag_artist,
      tagAlbum: digital_asset_file.tag_album,
    })
    .from(digital_asset_file)
    .where(inArray(digital_asset_file.asset_id, assetIds));

  const filesByAsset = new Map<number, typeof files>();
  for (const f of files) {
    const list = filesByAsset.get(f.assetId) ?? [];
    list.push(f);
    filesByAsset.set(f.assetId, list);
  }

  const libraryIds = [...new Set(assets.map((a) => a.libraryId))];
  const libraryRows =
    libraryIds.length === 0
      ? []
      : await db
          .select({ id: library.id, artistName: library.artist_name, albumTitle: library.album_title })
          .from(library)
          .where(inArray(library.id, libraryIds));
  const libraryById = new Map(libraryRows.map((r) => [r.id, r]));

  return assets.map((a) => {
    const assetFiles = filesByAsset.get(a.id) ?? [];
    const lib = libraryById.get(a.libraryId);
    const classified = assetFiles[0] ? classifyObjectKey(assetFiles[0].objectKey) : null;

    return {
      assetId: a.id,
      libraryId: a.libraryId,
      discNumber: a.discNumber,
      provenance: PROVENANCE,
      contentKind: classified?.kind === 'content' ? classified.contentKind : 'unknown',
      bindNote: a.bindNote ?? '',
      proposedArtist: lib?.artistName ?? '',
      proposedAlbumTitle: lib?.albumTitle ?? '',
      tagArtist: assetFiles[0]?.tagArtist ?? '',
      tagAlbum: assetFiles[0]?.tagAlbum ?? '',
      objectKeys: assetFiles.map((f) => f.objectKey),
    };
  });
};

export type { ReviewDecision };
