/**
 * Scanner image processor.
 *
 * Orchestrates Gemini extraction and catalog matching for scanned
 * vinyl record images.
 */

import { ScanContext, ScanExtraction, ScanResult } from './types.js';
import { extractFromImages } from './gemini.service.js';
import * as libraryService from '../library.service.js';

/**
 * Process scanned images through the extraction and matching pipeline.
 *
 * 1. Sends images to Gemini for metadata extraction
 * 2. If a catalogItemId is provided in context, uses it directly as the match
 * 3. Otherwise, attempts to match extraction results against the library catalog
 *    using artist name and album title from the extraction or context
 *
 * @param images - JPEG image buffers to analyze
 * @param photoTypes - Descriptive labels for each image
 * @param context - Optional context about the known album
 * @returns Extraction results and optional matched album ID
 */
export async function processImages(images: Buffer[], photoTypes: string[], context: ScanContext): Promise<ScanResult> {
  const extraction: ScanExtraction = await extractFromImages(images, photoTypes, context);

  // If context already includes a known catalog item, use it directly
  if (context.catalogItemId) {
    return {
      extraction,
      matchedAlbumId: context.catalogItemId,
    };
  }

  // Attempt catalog matching using available metadata
  const matchedAlbumId = await tryMatchCatalog(extraction, context);

  return {
    extraction,
    matchedAlbumId,
  };
}

/**
 * Attempt to match extraction results against the library catalog.
 *
 * Uses artist name and album title from context or extraction to perform
 * a fuzzy search of the library database.
 */
async function tryMatchCatalog(extraction: ScanExtraction, context: ScanContext): Promise<number | undefined> {
  const artistName = context.artistName || extraction.artistName?.value;
  const albumTitle = context.albumTitle || extraction.albumTitle?.value;

  if (!artistName && !albumTitle) {
    return undefined;
  }

  try {
    const results = await libraryService.fuzzySearchLibrary(artistName, albumTitle, 1);

    if (Array.isArray(results) && results.length > 0) {
      const topResult = results[0] as { id?: number };
      return topResult.id;
    }

    return undefined;
  } catch (error) {
    console.error('[Scanner] Catalog matching failed:', error);
    return undefined;
  }
}
