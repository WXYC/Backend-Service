import { RequestHandler } from 'express';
import type { DigitalArchivePlaybackManifest } from '@wxyc/shared/dtos';
import * as digitalArchiveConfig from '../config/digitalArchive.js';
import * as digitalArchiveService from '../services/digital-archive.service.js';
import WxycError from '../utils/error.js';
import { parsePositiveInt } from '../utils/query-params.js';

/**
 * `GET /digital-archive/albums/:id/playback` (BS#2320, contract
 * wxyc-shared#417/#422) — presigned playback manifest for the auto-DJ
 * archive player. Gate: `routes/digital-archive.route.ts`
 * (`digital_archive: ['listen']`, `dj`+).
 *
 * STATUS CODE CONTRACT — 403 vs 404 is deliberate and load-bearing for the
 * client (issue #2320 comments): `403` means the feature is off or the
 * caller is below `dj`; `404` means the caller is permitted but there is
 * nothing bound to play. A client can trust the code without inspecting the
 * body. The flag check runs BEFORE any DB read, so a disabled feature never
 * touches the database.
 *
 * `200` MEANS PLAYABLE. `getPlaybackManifest` returns `null` — never an
 * empty-`tracks` manifest — when a bound asset exists but has no servable
 * file, so this handler's `null` branch is the only path that returns `404`
 * for "permitted, nothing to play"; every `200` this handler sends carries
 * at least one track with at least one rendition. See the service module's
 * doc comment for the full reasoning.
 *
 * `Cache-Control: private, no-store` — the contract's documented posture
 * (issue #2320 first comment). Every URL in the body is a presigned,
 * per-caller bearer credential until `expires_at`; it must never be cached
 * by a shared proxy or reused across callers, and must never be logged.
 */
export const getPlayback: RequestHandler<{ id: string }> = async (req, res) => {
  // Flag check first, before the id is even parsed — a disabled feature
  // never reaches a DB read.
  if (!digitalArchiveConfig.getConfig().enabled) {
    throw new WxycError('Digital archive streaming is not enabled', 403);
  }

  const libraryId = parsePositiveInt(req.params.id, 'id');
  const manifest = await digitalArchiveService.getPlaybackManifest(libraryId);

  if (manifest === null) {
    throw new WxycError(`No playable digital archive asset bound to album ${libraryId}`, 404);
  }

  const body: DigitalArchivePlaybackManifest = manifest;
  res.set('Cache-Control', 'private, no-store');
  res.status(200).json(body);
};
