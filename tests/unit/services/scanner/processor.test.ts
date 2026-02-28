/**
 * Unit tests for the scanner image processor.
 */

// Mock the gemini service
jest.mock('../../../../apps/backend/services/scanner/gemini.service', () => ({
  extractFromImages: jest.fn(),
}));

// Mock the library service
jest.mock('../../../../apps/backend/services/library.service', () => ({
  fuzzySearchLibrary: jest.fn(),
}));

import { processImages } from '../../../../apps/backend/services/scanner/processor';
import { extractFromImages } from '../../../../apps/backend/services/scanner/gemini.service';
import { fuzzySearchLibrary } from '../../../../apps/backend/services/library.service';
import { ScanContext, ScanExtraction } from '../../../../apps/backend/services/scanner/types';

const mockExtractFromImages = extractFromImages as jest.MockedFunction<typeof extractFromImages>;
const mockFuzzySearchLibrary = fuzzySearchLibrary as jest.MockedFunction<typeof fuzzySearchLibrary>;

describe('processor', () => {
  const mockImages = [Buffer.from('fake-image')];
  const mockPhotoTypes = ['center_label'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('processImages', () => {
    it('returns extraction results from gemini service', async () => {
      const mockExtraction: ScanExtraction = {
        labelName: { value: 'Sub Pop', confidence: 0.9 },
        catalogNumber: { value: 'SP 1234', confidence: 0.85 },
      };

      mockExtractFromImages.mockResolvedValue(mockExtraction);
      mockFuzzySearchLibrary.mockResolvedValue([]);

      const result = await processImages(mockImages, mockPhotoTypes, {});

      expect(result.extraction).toEqual(mockExtraction);
      expect(mockExtractFromImages).toHaveBeenCalledWith(mockImages, mockPhotoTypes, {});
    });

    it('uses catalogItemId from context when provided', async () => {
      const mockExtraction: ScanExtraction = {
        labelName: { value: 'Merge', confidence: 0.9 },
      };

      mockExtractFromImages.mockResolvedValue(mockExtraction);

      const context: ScanContext = { catalogItemId: 42 };
      const result = await processImages(mockImages, mockPhotoTypes, context);

      expect(result.matchedAlbumId).toBe(42);
      // Should not attempt catalog matching when ID is already known
      expect(mockFuzzySearchLibrary).not.toHaveBeenCalled();
    });

    it('attempts catalog matching when no catalogItemId is provided', async () => {
      const mockExtraction: ScanExtraction = {
        labelName: { value: 'Sub Pop', confidence: 0.9 },
      };

      mockExtractFromImages.mockResolvedValue(mockExtraction);
      mockFuzzySearchLibrary.mockResolvedValue([{ id: 101, artist_name: 'Nirvana', album_title: 'Bleach' }]);

      const context: ScanContext = {
        artistName: 'Nirvana',
        albumTitle: 'Bleach',
      };
      const result = await processImages(mockImages, mockPhotoTypes, context);

      expect(mockFuzzySearchLibrary).toHaveBeenCalledWith('Nirvana', 'Bleach', 1);
      expect(result.matchedAlbumId).toBe(101);
    });

    it('uses label name from extraction when no artist in context', async () => {
      const mockExtraction: ScanExtraction = {
        labelName: { value: 'Merge Records', confidence: 0.9 },
      };

      mockExtractFromImages.mockResolvedValue(mockExtraction);
      mockFuzzySearchLibrary.mockResolvedValue([]);

      const context: ScanContext = { albumTitle: 'Foolish' };
      const result = await processImages(mockImages, mockPhotoTypes, context);

      expect(mockFuzzySearchLibrary).toHaveBeenCalledWith('Merge Records', 'Foolish', 1);
      expect(result.matchedAlbumId).toBeUndefined();
    });

    it('returns undefined matchedAlbumId when no context for matching', async () => {
      const mockExtraction: ScanExtraction = {};

      mockExtractFromImages.mockResolvedValue(mockExtraction);

      const result = await processImages(mockImages, mockPhotoTypes, {});

      expect(mockFuzzySearchLibrary).not.toHaveBeenCalled();
      expect(result.matchedAlbumId).toBeUndefined();
    });

    it('returns undefined matchedAlbumId when catalog search fails', async () => {
      const mockExtraction: ScanExtraction = {
        labelName: { value: 'Unknown Label', confidence: 0.5 },
      };

      mockExtractFromImages.mockResolvedValue(mockExtraction);
      mockFuzzySearchLibrary.mockRejectedValue(new Error('DB error'));

      const context: ScanContext = { artistName: 'Test Artist' };
      const result = await processImages(mockImages, mockPhotoTypes, context);

      expect(result.matchedAlbumId).toBeUndefined();
      expect(result.extraction).toEqual(mockExtraction);
    });

    it('returns undefined matchedAlbumId when catalog search returns empty', async () => {
      const mockExtraction: ScanExtraction = {
        labelName: { value: 'Rare Label', confidence: 0.8 },
      };

      mockExtractFromImages.mockResolvedValue(mockExtraction);
      mockFuzzySearchLibrary.mockResolvedValue([]);

      const context: ScanContext = { artistName: 'Unknown Band' };
      const result = await processImages(mockImages, mockPhotoTypes, context);

      expect(result.matchedAlbumId).toBeUndefined();
    });

    it('propagates errors from gemini service', async () => {
      mockExtractFromImages.mockRejectedValue(new Error('Gemini API failed'));

      await expect(processImages(mockImages, mockPhotoTypes, {})).rejects.toThrow('Gemini API failed');
    });
  });
});
