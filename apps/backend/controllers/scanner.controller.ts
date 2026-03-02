/**
 * Scanner controller for vinyl record image scanning, UPC lookup,
 * and batch processing.
 */

import { RequestHandler } from 'express';
import { processImages } from '../services/scanner/processor.js';
import { ScanContext } from '../services/scanner/types.js';
import { DiscogsService } from '../services/discogs/discogs.service.js';
import * as batchService from '../services/scanner/batch.js';

/**
 * POST /library/scan
 *
 * Accepts multipart form data with vinyl record images and optional context.
 * Uses Gemini to extract metadata and attempts catalog matching.
 *
 * Form fields:
 * - images: up to 5 JPEG files (via multer)
 * - photo_types: JSON string array or comma-separated list of photo type labels
 * - catalog_item_id: optional known catalog item ID
 * - sticker_text: optional text from library sticker
 * - detected_upc: optional UPC from barcode scanner
 * - artist_name: optional known artist name
 * - album_title: optional known album title
 */
export const scanImages: RequestHandler = async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ status: 400, message: 'No images provided' });
      return;
    }

    // Parse photo_types from form field
    let photoTypes: string[] = [];
    const rawPhotoTypes = req.body.photo_types;
    if (rawPhotoTypes) {
      if (typeof rawPhotoTypes === 'string') {
        try {
          photoTypes = JSON.parse(rawPhotoTypes);
        } catch {
          // Fall back to comma-separated parsing
          photoTypes = rawPhotoTypes.split(',').map((s: string) => s.trim());
        }
      } else if (Array.isArray(rawPhotoTypes)) {
        photoTypes = rawPhotoTypes;
      }
    }

    // Build scan context from optional form fields
    const context: ScanContext = {};
    if (req.body.catalog_item_id) {
      context.catalogItemId = parseInt(req.body.catalog_item_id, 10);
    }
    if (req.body.sticker_text) {
      context.stickerText = req.body.sticker_text;
    }
    if (req.body.detected_upc) {
      context.detectedUPC = req.body.detected_upc;
    }
    if (req.body.artist_name) {
      context.artistName = req.body.artist_name;
    }
    if (req.body.album_title) {
      context.albumTitle = req.body.album_title;
    }

    const images = files.map((file) => file.buffer);
    const result = await processImages(images, photoTypes, context);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error scanning images:', error);
    next(error);
  }
};

/**
 * POST /library/scan/upc-lookup
 *
 * Looks up a UPC barcode on Discogs to find release information.
 *
 * Body: { upc: string }
 */
export const upcLookup: RequestHandler = async (req, res, next) => {
  const { upc } = req.body;
  if (!upc || typeof upc !== 'string') {
    res.status(400).json({ status: 400, message: 'Missing or invalid parameter: upc' });
    return;
  }

  try {
    const results = await DiscogsService.searchByBarcode(upc);
    res.status(200).json(results);
  } catch (error) {
    console.error('Error looking up UPC:', error);
    next(error);
  }
};

/**
 * GET /library/scan/batch
 *
 * Lists batch scan jobs for the authenticated user with pagination.
 *
 * Query params:
 * - limit: max jobs to return (default 20, max 100)
 * - offset: number of jobs to skip (default 0)
 */
export const listBatchJobs: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.auth!.id!;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const result = await batchService.listJobs(userId, limit, offset);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error listing batch jobs:', error);
    next(error);
  }
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_BATCH_ITEMS = 10;
const MAX_IMAGES_PER_ITEM = 5;
const MAX_TOTAL_IMAGES = 50;

/**
 * POST /library/scan/batch
 *
 * Accepts multipart form data with vinyl record images and a JSON manifest
 * describing how images map to items. Returns 202 with a job ID for polling.
 *
 * Form fields:
 * - images: up to 50 JPEG files (via multer)
 * - manifest: JSON string with item groupings:
 *   {
 *     "items": [
 *       { "imageCount": 2, "photoTypes": ["front_cover", "center_label"], "context": { "artistName": "..." } }
 *     ]
 *   }
 */
export const createBatchScan: RequestHandler = async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ status: 400, message: 'No images provided' });
      return;
    }

    // Parse manifest
    const rawManifest = req.body.manifest;
    if (!rawManifest || typeof rawManifest !== 'string') {
      res.status(400).json({ status: 400, message: 'Missing or invalid manifest field' });
      return;
    }

    let manifest: { items: batchService.BatchItem[] };
    try {
      manifest = JSON.parse(rawManifest);
    } catch {
      res.status(400).json({ status: 400, message: 'Invalid JSON in manifest field' });
      return;
    }

    if (!manifest.items || !Array.isArray(manifest.items) || manifest.items.length === 0) {
      res.status(400).json({ status: 400, message: 'Manifest must contain a non-empty items array' });
      return;
    }

    // Validate limits
    if (manifest.items.length > MAX_BATCH_ITEMS) {
      res.status(400).json({ status: 400, message: `Batch cannot exceed ${MAX_BATCH_ITEMS} items` });
      return;
    }

    const totalExpectedImages = manifest.items.reduce((sum, item) => sum + (item.imageCount || 0), 0);

    if (totalExpectedImages > MAX_TOTAL_IMAGES) {
      res.status(400).json({ status: 400, message: `Total images cannot exceed ${MAX_TOTAL_IMAGES}` });
      return;
    }

    for (const item of manifest.items) {
      if (item.imageCount > MAX_IMAGES_PER_ITEM) {
        res.status(400).json({ status: 400, message: `Each item cannot exceed ${MAX_IMAGES_PER_ITEM} images` });
        return;
      }
    }

    if (files.length !== totalExpectedImages) {
      res.status(400).json({
        status: 400,
        message: `Image count mismatch: ${files.length} files uploaded but manifest expects ${totalExpectedImages}`,
      });
      return;
    }

    const imageBuffers = files.map((file) => file.buffer);
    const userId = req.auth!.id!;

    const result = await batchService.createBatchJob(userId, manifest.items, imageBuffers);

    res.status(202).json(result);
  } catch (error) {
    console.error('Error creating batch scan:', error);
    next(error);
  }
};

/**
 * GET /library/scan/batch/:jobId
 *
 * Returns the current status of a batch scan job, including individual
 * result statuses and extraction data.
 */
export const getBatchStatus: RequestHandler = async (req, res, next) => {
  try {
    const { jobId } = req.params;

    if (!UUID_REGEX.test(jobId)) {
      res.status(400).json({ status: 400, message: 'Invalid job ID format' });
      return;
    }

    const userId = req.auth!.id!;
    const status = await batchService.getJobStatus(jobId, userId);

    if (!status) {
      res.status(404).json({ status: 404, message: 'Job not found' });
      return;
    }

    res.status(200).json(status);
  } catch (error) {
    console.error('Error getting batch status:', error);
    next(error);
  }
};
