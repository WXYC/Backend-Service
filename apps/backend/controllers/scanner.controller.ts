/**
 * Scanner controller for vinyl record image scanning and UPC lookup.
 */

import { RequestHandler } from 'express';
import { processImages } from '../services/scanner/processor.js';
import { ScanContext } from '../services/scanner/types.js';
import { DiscogsService } from '../services/discogs/discogs.service.js';

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
