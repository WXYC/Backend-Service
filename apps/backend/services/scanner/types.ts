/**
 * Type definitions for the vinyl record scanner service.
 *
 * Used by the Gemini-powered image extraction pipeline to process
 * photos of vinyl records and extract catalog metadata.
 */

/**
 * Context provided by the client to assist with extraction.
 * May include known catalog information or text detected on-device.
 */
export interface ScanContext {
  catalogItemId?: number;
  stickerText?: string;
  detectedUPC?: string;
  artistName?: string;
  albumTitle?: string;
}

/**
 * A single extracted field with its confidence score.
 */
export interface ExtractionField {
  value: string;
  confidence: number;
}

/**
 * Structured extraction results from Gemini image analysis.
 */
export interface ScanExtraction {
  artistName?: ExtractionField;
  albumTitle?: ExtractionField;
  labelName?: ExtractionField;
  catalogNumber?: ExtractionField;
  reviewText?: ExtractionField;
  upc?: ExtractionField;
}

/**
 * Final result from the scan pipeline, including extraction
 * and optional catalog match.
 */
export interface ScanResult {
  extraction: ScanExtraction;
  matchedAlbumId?: number;
}
