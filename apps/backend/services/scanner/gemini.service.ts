/**
 * Gemini AI Service for vinyl record image extraction.
 *
 * Uses Google's Gemini Flash model to analyze photos of vinyl records
 * and extract metadata (label, catalog number, UPC, DJ reviews).
 *
 * Follows the singleton pattern from parser.service.ts.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { ScanContext, ScanExtraction, ExtractionField } from './types.js';
import { SCANNER_SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

/**
 * Gemini client singleton.
 */
let _geminiClient: GoogleGenerativeAI | null = null;

/**
 * Get or create the Gemini client.
 */
function getGeminiClient(): GoogleGenerativeAI {
  if (!_geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    _geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return _geminiClient;
}

/**
 * Reset the Gemini client (useful for testing).
 */
export function resetGeminiClient(): void {
  _geminiClient = null;
}

/**
 * Raw response shape from Gemini extraction.
 */
interface RawExtractionResponse {
  label_name?: { value: string; confidence: number };
  catalog_number?: { value: string; confidence: number };
  review_text?: { value: string; confidence: number };
  upc?: { value: string; confidence: number };
}

/**
 * Parse a raw field into an ExtractionField, validating structure.
 */
function parseField(raw: { value: string; confidence: number } | undefined): ExtractionField | undefined {
  if (!raw || typeof raw.value !== 'string' || typeof raw.confidence !== 'number') {
    return undefined;
  }
  return {
    value: raw.value,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
  };
}

/**
 * Extract metadata from vinyl record images using Gemini Flash.
 *
 * @param images - JPEG image buffers to analyze
 * @param photoTypes - Descriptive labels for each image (e.g., "front_cover", "center_label")
 * @param context - Optional context about the known album
 * @returns Extracted metadata fields with confidence scores
 * @throws Error if Gemini API fails or returns invalid response
 */
export async function extractFromImages(
  images: Buffer[],
  photoTypes: string[],
  context: ScanContext
): Promise<ScanExtraction> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });

  console.log(`[Scanner] Extracting metadata from ${images.length} image(s)`);

  const userPrompt = buildUserPrompt(photoTypes, context);

  // Build multimodal content parts: images as inline base64 + text prompt
  const imageParts = images.map((buffer) => ({
    inlineData: {
      mimeType: 'image/jpeg',
      data: buffer.toString('base64'),
    },
  }));

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: SCANNER_SYSTEM_PROMPT },
            ...imageParts,
            { text: userPrompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const response = result.response;
    const content = response.text();
    if (!content) {
      throw new Error('Empty response from Gemini');
    }

    const parsed: RawExtractionResponse = JSON.parse(content);
    console.log(`[Scanner] Raw extraction response:`, JSON.stringify(parsed));

    const extraction: ScanExtraction = {};

    const labelName = parseField(parsed.label_name);
    if (labelName) extraction.labelName = labelName;

    const catalogNumber = parseField(parsed.catalog_number);
    if (catalogNumber) extraction.catalogNumber = catalogNumber;

    const reviewText = parseField(parsed.review_text);
    if (reviewText) extraction.reviewText = reviewText;

    const upc = parseField(parsed.upc);
    if (upc) extraction.upc = upc;

    return extraction;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`[Scanner] Failed to parse JSON response:`, error);
      throw new Error(`Invalid JSON response from Gemini: ${error.message}`);
    }
    console.error(`[Scanner] Error extracting from images:`, error);
    throw error;
  }
}
