/**
 * Whole-run orchestration for the inventory/match/write pipeline
 * (`--apply` / `--rebind-keys`). `--export`/`--import` are separate
 * commands in `job.ts` that skip this module entirely -- they read/write
 * `digital_asset` directly via `review.ts`, independent of any inventory
 * scan.
 *
 * Everything the write phase needs is gathered into memory BEFORE
 * `write.ts` is called (comment 3's other half of the watermark
 * constraint): the S3 walk + tag reads + matching happen first, with no
 * open transaction, and the DB write is the last, short step.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { loadLibraryCandidates, loadRotationCandidates } from './candidates.js';
import { classifyObjectKey, isRotationDerived } from './classify.js';
import { groupIntoAlbums } from './group.js';
import { matchLibrary, matchRotation } from './match.js';
import type { RunSummary } from './report.js';
import { createStoreClient, listAllObjects, loadStoreConfigFromEnv, md5FromETag } from './store.js';
import { fetchAzuraCastTags, resolveTagsForFile } from './tags.js';
import type { CandidateAlbum, InventoryFile, MatchedAlbum } from './types.js';
import { ensureStore, executeWrites, loadBoundFileKeys, loadExistingSlots, planWrites } from './write.js';

export interface RunOptions {
  apply: boolean;
  rebindKeys: ReadonlySet<string>;
}

const AZURACAST_BASE_URL = process.env.AZURACAST_BASE_URL || 'https://remote.wxyc.org';

const buildInventory = async (): Promise<{ files: InventoryFile[]; skippedByReason: Record<string, number> }> => {
  const storeConfig = loadStoreConfigFromEnv();
  const client = createStoreClient(storeConfig);

  const azuraCastTags = process.env.AZURACAST_API_KEY
    ? await fetchAzuraCastTags(AZURACAST_BASE_URL, process.env.AZURACAST_API_KEY)
    : null;

  const skippedByReason: Record<string, number> = {};
  const files: InventoryFile[] = [];

  for await (const object of listAllObjects(client, storeConfig.bucket)) {
    const classified = classifyObjectKey(object.key);
    if (classified.kind === 'skip') {
      skippedByReason[classified.reason] = (skippedByReason[classified.reason] ?? 0) + 1;
      continue;
    }

    const tags = await resolveTagsForFile(client, storeConfig.bucket, object.key, azuraCastTags);
    files.push({
      objectKey: object.key,
      contentKind: classified.contentKind,
      codec: classified.codec,
      bytes: object.bytes,
      md5: md5FromETag(object.etag),
      tags,
    });
  }

  return { files, skippedByReason };
};

const matchAlbums = async (
  albums: readonly CandidateAlbum[]
): Promise<{
  matched: MatchedAlbum[];
  matchedExact: number;
  matchedFuzzy: number;
  ambiguous: number;
  unmatched: number;
}> => {
  const [rotationCandidates, libraryCandidates] = await Promise.all([
    loadRotationCandidates(),
    loadLibraryCandidates(),
  ]);

  const matched: MatchedAlbum[] = [];
  let matchedExact = 0;
  let matchedFuzzy = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const album of albums) {
    const result = isRotationDerived(album.contentKind)
      ? matchRotation(album, rotationCandidates)
      : matchLibrary(album, libraryCandidates);
    if (result.kind === 'matched') {
      matched.push({ candidate: album, libraryId: result.libraryId, tier: result.tier, bindNote: result.note });
      if (result.tier === 'exact') matchedExact++;
      else matchedFuzzy++;
    } else if (result.kind === 'ambiguous') {
      ambiguous++;
    } else {
      unmatched++;
    }
  }

  return { matched, matchedExact, matchedFuzzy, ambiguous, unmatched };
};

export const runInventoryAndBind = async (options: RunOptions): Promise<RunSummary> => {
  const { files, skippedByReason } = await buildInventory();
  const { albums, ungroupable } = groupIntoAlbums(files);
  const { matched, matchedExact, matchedFuzzy, ambiguous, unmatched } = await matchAlbums(albums);

  let inserted = 0;
  let reopened = 0;
  let rejectedBlocked: import('./write.js').RejectedBlocked[] = [];
  let boundDrift: import('./write.js').BoundDrift[] = [];
  let sameRunCollision: import('./write.js').SameRunCollision[] = [];

  if (matched.length > 0) {
    const libraryIds = [...new Set(matched.map((m) => m.libraryId))];
    const existingSlots = await loadExistingSlots(libraryIds);
    const boundAssetIds = existingSlots.filter((s) => s.status === 'bound').map((s) => s.id);
    const boundFileKeys = await loadBoundFileKeys(boundAssetIds);

    const plan = planWrites(matched, existingSlots, boundFileKeys, options.rebindKeys);
    rejectedBlocked = plan.rejectedBlocked;
    boundDrift = plan.boundDrift;
    sameRunCollision = plan.sameRunCollision;

    if (options.apply) {
      const storeId = await ensureStore();
      const counts = await executeWrites(plan, storeId);
      inserted = counts.inserted;
      reopened = counts.reopened;
    } else {
      inserted = plan.toInsert.length;
      reopened = plan.rejectedReopened.length;
    }
  }

  const totalSkipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    filesSeen: files.length + totalSkipped,
    skippedByReason,
    albumsGrouped: albums.length,
    ungroupableFiles: ungroupable.length,
    matchedExact,
    matchedFuzzy,
    ambiguous,
    unmatched,
    inserted,
    reopened,
    rejectedBlocked,
    boundDrift,
    sameRunCollision,
  };
};

/** Re-exported so `job.ts` doesn't need its own `@wxyc/database` import just for teardown. */
export const closeDatabase = closeDatabaseConnection;
