/**
 * Unit tests for the Gemini scanner service.
 */

// Mock @google/generative-ai before importing the service
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn().mockReturnValue({
  generateContent: mockGenerateContent,
});
const MockGoogleGenerativeAI = jest.fn().mockImplementation(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}));

import { extractFromImages, resetGeminiClient } from '../../../../apps/backend/services/scanner/gemini.service';
import { ScanContext } from '../../../../apps/backend/services/scanner/types';

describe('gemini.service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetGeminiClient();
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('extractFromImages', () => {
    const mockImages = [Buffer.from('fake-image-data')];
    const mockPhotoTypes = ['center_label'];
    const mockContext: ScanContext = {};

    it('initializes the Gemini client with the API key', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              label_name: { value: 'Sub Pop', confidence: 0.95 },
            }),
        },
      });

      await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      expect(MockGoogleGenerativeAI).toHaveBeenCalledWith('test-api-key');
    });

    it('calls Gemini with the correct model', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({}),
        },
      });

      await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      expect(mockGetGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-2.0-flash' });
    });

    it('sends images as base64 inline data', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({}),
        },
      });

      await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const parts = callArgs.contents[0].parts;

      // Should have: system prompt text, image(s), user prompt text
      const imagePart = parts.find((p: Record<string, unknown>) => p.inlineData);
      expect(imagePart).toBeDefined();
      expect(imagePart.inlineData.mimeType).toBe('image/jpeg');
      expect(imagePart.inlineData.data).toBe(Buffer.from('fake-image-data').toString('base64'));
    });

    it('requests JSON response format', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({}),
        },
      });

      await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.generationConfig.responseMimeType).toBe('application/json');
    });

    it('returns parsed ScanExtraction from the Gemini response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              label_name: { value: 'Merge Records', confidence: 0.92 },
              catalog_number: { value: 'MRG-567', confidence: 0.85 },
              review_text: { value: 'Great album, play track 3!', confidence: 0.7 },
              upc: { value: '036172091928', confidence: 0.99 },
            }),
        },
      });

      const result = await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      expect(result.labelName).toEqual({ value: 'Merge Records', confidence: 0.92 });
      expect(result.catalogNumber).toEqual({ value: 'MRG-567', confidence: 0.85 });
      expect(result.reviewText).toEqual({ value: 'Great album, play track 3!', confidence: 0.7 });
      expect(result.upc).toEqual({ value: '036172091928', confidence: 0.99 });
    });

    it('omits fields not present in the response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              label_name: { value: 'Sub Pop', confidence: 0.9 },
            }),
        },
      });

      const result = await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      expect(result.labelName).toEqual({ value: 'Sub Pop', confidence: 0.9 });
      expect(result.catalogNumber).toBeUndefined();
      expect(result.reviewText).toBeUndefined();
      expect(result.upc).toBeUndefined();
    });

    it('clamps confidence scores to [0, 1]', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              label_name: { value: 'Test', confidence: 1.5 },
              catalog_number: { value: 'X', confidence: -0.3 },
            }),
        },
      });

      const result = await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      expect(result.labelName?.confidence).toBe(1);
      expect(result.catalogNumber?.confidence).toBe(0);
    });

    it('includes context in the prompt when provided', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({}),
        },
      });

      const contextWithInfo: ScanContext = {
        artistName: 'Superchunk',
        albumTitle: 'Foolish',
        stickerText: 'RO 5/3',
        detectedUPC: '036172091928',
      };

      await extractFromImages(mockImages, mockPhotoTypes, contextWithInfo);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const textParts = callArgs.contents[0].parts
        .filter((p: Record<string, unknown>) => p.text)
        .map((p: { text: string }) => p.text);

      const userPrompt = textParts[textParts.length - 1];
      expect(userPrompt).toContain('Superchunk');
      expect(userPrompt).toContain('Foolish');
      expect(userPrompt).toContain('RO 5/3');
      expect(userPrompt).toContain('036172091928');
    });

    it('throws when the API key is missing', async () => {
      resetGeminiClient();
      delete process.env.GEMINI_API_KEY;

      await expect(extractFromImages(mockImages, mockPhotoTypes, mockContext)).rejects.toThrow(
        'GEMINI_API_KEY is not configured'
      );
    });

    it('throws on empty response from Gemini', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => '',
        },
      });

      await expect(extractFromImages(mockImages, mockPhotoTypes, mockContext)).rejects.toThrow(
        'Empty response from Gemini'
      );
    });

    it('throws on invalid JSON from Gemini', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => 'not valid json {{{',
        },
      });

      await expect(extractFromImages(mockImages, mockPhotoTypes, mockContext)).rejects.toThrow(
        'Invalid JSON response from Gemini'
      );
    });

    it('reuses the client on subsequent calls', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({}),
        },
      });

      await extractFromImages(mockImages, mockPhotoTypes, mockContext);
      await extractFromImages(mockImages, mockPhotoTypes, mockContext);

      // Client should only be constructed once
      expect(MockGoogleGenerativeAI).toHaveBeenCalledTimes(1);
    });
  });
});
