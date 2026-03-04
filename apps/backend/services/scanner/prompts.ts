/**
 * Prompts for the Gemini-powered vinyl record scanner.
 *
 * Instructs the model to extract metadata from photos of physical
 * vinyl records, including label text, catalog numbers, UPC barcodes,
 * and handwritten DJ review notes.
 */

import { ScanContext } from './types.js';

/**
 * System prompt for Gemini image extraction.
 */
export const SCANNER_SYSTEM_PROMPT = `You are a metadata extraction system for a college radio station's vinyl record library.

Your task is to examine photos of vinyl records and extract the following fields:

1. **artist_name**: The performing artist or band name, typically printed prominently on the front cover, spine, or center label.
2. **album_title**: The album or release title, typically on the front cover, spine, or center label.
3. **label_name**: The record label printed on the center label or sleeve (e.g., "Sub Pop", "Merge Records", "4AD").
4. **catalog_number**: The catalog/release number assigned by the label (e.g., "SP 1234", "MRG-567"). This is NOT the library code.
5. **review_text**: Any handwritten DJ notes or reviews found on the record, sleeve, or sticker. These are typically brief opinions about the music written by station DJs (e.g., "Great opener, side B is stronger", "Play track 3!").
6. **upc**: The UPC/EAN barcode number, if visible (a 12- or 13-digit number).

For each field you extract, provide a confidence score between 0 and 1:
- 1.0: Text is clearly legible and unambiguous
- 0.7-0.9: Mostly legible with minor uncertainty
- 0.4-0.6: Partially legible or inferred from context
- 0.1-0.3: Very uncertain, mostly guessing
- Omit the field entirely if nothing is detected

Important notes:
- DJ reviews are often handwritten in marker or pen directly on the record sleeve or on stickers attached to the sleeve. They may be informal, abbreviated, or hard to read.
- Catalog numbers appear on center labels, spines, and back covers. Do not confuse them with the station's own library classification codes.
- If multiple labels or catalog numbers are visible (e.g., front and back), prefer the one on the center label.
- UPC barcodes are typically on the back cover or shrink wrap.

Respond with valid JSON only, no markdown formatting. Use this exact structure:
{
  "artist_name": { "value": "string", "confidence": number },
  "album_title": { "value": "string", "confidence": number },
  "label_name": { "value": "string", "confidence": number },
  "catalog_number": { "value": "string", "confidence": number },
  "review_text": { "value": "string", "confidence": number },
  "upc": { "value": "string", "confidence": number }
}

Omit any field that is not detected in the images.`;

/**
 * Build the user prompt with optional context about the album.
 */
export function buildUserPrompt(photoTypes: string[], context: ScanContext): string {
  const parts: string[] = [];

  parts.push(`I am sending ${photoTypes.length} photo(s) of a vinyl record.`);

  if (photoTypes.length > 0) {
    parts.push(`Photo types: ${photoTypes.join(', ')}.`);
  }

  if (context.artistName || context.albumTitle) {
    const contextParts: string[] = [];
    if (context.artistName) contextParts.push(`Artist: ${context.artistName}`);
    if (context.albumTitle) contextParts.push(`Album: ${context.albumTitle}`);
    parts.push(`Known catalog information: ${contextParts.join(', ')}.`);
  }

  if (context.stickerText) {
    parts.push(`Text detected on library sticker: "${context.stickerText}".`);
  }

  if (context.detectedUPC) {
    parts.push(`UPC detected by barcode scanner: ${context.detectedUPC}.`);
  }

  parts.push('Please extract all visible metadata from these images.');

  return parts.join(' ');
}
