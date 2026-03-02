/**
 * Unit tests for the batch scan processing service.
 */

import { jest } from '@jest/globals';

// Mock the database
const mockInsert = jest.fn().mockReturnThis();
const mockValues = jest.fn().mockReturnThis();
const mockReturning = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockSelect = jest.fn().mockReturnThis();
const mockFrom = jest.fn().mockReturnThis();
const mockWhere = jest.fn().mockReturnThis();
const mockOrderBy = jest.fn().mockReturnThis();
const mockLimit = jest.fn().mockReturnThis();
const mockOffset = jest.fn().mockReturnThis();
const mockUpdate = jest.fn().mockReturnThis();
const mockSet = jest.fn().mockReturnThis();
const mockExecute = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

jest.mock('@wxyc/database', () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
    update: mockUpdate,
  },
  scan_jobs: {
    id: 'id',
    user_id: 'user_id',
    status: 'status',
    completed_items: 'completed_items',
    failed_items: 'failed_items',
    created_at: 'created_at',
    updated_at: 'updated_at',
  },
  scan_results: {
    id: 'id',
    job_id: 'job_id',
    item_index: 'item_index',
    status: 'status',
    extraction: 'extraction',
    matched_album_id: 'matched_album_id',
    error_message: 'error_message',
    completed_at: 'completed_at',
  },
  library_artist_view: {
    id: 'id',
    artist_name: 'artist_name',
    album_title: 'album_title',
    code_letters: 'code_letters',
    code_artist_number: 'code_artist_number',
    code_number: 'code_number',
    genre_name: 'genre_name',
    format_name: 'format_name',
    label: 'label',
  },
}));

// Wire up the chain: insert().values().returning() and select().from().where().orderBy().limit().offset().execute()
mockInsert.mockReturnValue({ values: mockValues });
mockValues.mockReturnValue({ returning: mockReturning });
mockSelect.mockReturnValue({ from: mockFrom });
mockFrom.mockReturnValue({ where: mockWhere });
mockWhere.mockReturnValue({ orderBy: mockOrderBy, execute: mockExecute });
mockOrderBy.mockReturnValue({ limit: mockLimit, execute: mockExecute });
mockLimit.mockReturnValue({ offset: mockOffset });
mockOffset.mockReturnValue({ execute: mockExecute });
mockUpdate.mockReturnValue({ set: mockSet });
mockSet.mockReturnValue({ where: mockWhere });

// Mock the processor module
const mockProcessImages = jest.fn<
  (
    images: Buffer[],
    photoTypes: string[],
    context: Record<string, unknown>
  ) => Promise<{
    extraction: Record<string, unknown>;
    matchedAlbumId?: number;
  }>
>();
jest.mock('../../../../apps/backend/services/scanner/processor', () => ({
  processImages: mockProcessImages,
}));

// Mock drizzle-orm operators
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  asc: jest.fn((col) => ({ asc: col })),
  inArray: jest.fn((col, values) => ({ inArray: [col, values] })),
  desc: jest.fn((col) => ({ desc: col })),
  count: jest.fn(() => ({ count: 'count(*)' })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    {
      raw: jest.fn((s: string) => ({ raw: s })),
    }
  ),
}));

// Mock crypto.randomUUID
const mockUUID = '550e8400-e29b-41d4-a716-446655440000';
jest.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID as `${string}-${string}-${string}-${string}-${string}`);

import { createBatchJob, getJobStatus, listJobs, processJobItems } from '../../../../apps/backend/services/scanner/batch';

describe('batch service', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Re-wire the chain after clearAllMocks
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy, execute: mockExecute });
    mockOrderBy.mockReturnValue({ limit: mockLimit, execute: mockExecute });
    mockLimit.mockReturnValue({ offset: mockOffset });
    mockOffset.mockReturnValue({ execute: mockExecute });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });

    mockReturning.mockResolvedValue([]);
    mockExecute.mockResolvedValue([]);
  });

  describe('createBatchJob', () => {
    const userId = 'user-123';
    const items = [
      { imageCount: 2, photoTypes: ['front_cover', 'center_label'], context: { artistName: 'Superchunk' } },
      { imageCount: 1, photoTypes: ['front_cover'], context: {} },
    ];
    const imageBuffers = [Buffer.from('img1'), Buffer.from('img2'), Buffer.from('img3')];
    let setImmediateSpy: jest.SpiedFunction<typeof setImmediate>;

    beforeEach(() => {
      // Prevent setImmediate callbacks from firing after tests complete
      setImmediateSpy = jest
        .spyOn(global, 'setImmediate')
        .mockImplementation((() => {}) as unknown as typeof setImmediate);
    });

    afterEach(() => {
      setImmediateSpy.mockRestore();
    });

    it('returns job info with pending status', async () => {
      mockReturning.mockResolvedValueOnce([{ id: mockUUID }]);

      const result = await createBatchJob(userId, items, imageBuffers);

      expect(result).toEqual({
        jobId: mockUUID,
        status: 'pending',
        totalItems: 2,
      });
    });

    it('inserts a job row and result rows', async () => {
      mockReturning.mockResolvedValueOnce([{ id: mockUUID }]);

      await createBatchJob(userId, items, imageBuffers);

      // Should call insert twice: once for job, once for results
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it('fires background processing via setImmediate', async () => {
      mockReturning.mockResolvedValueOnce([{ id: mockUUID }]);

      await createBatchJob(userId, items, imageBuffers);

      expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getJobStatus', () => {
    const jobId = mockUUID;
    const userId = 'user-123';

    it('returns null when job not found', async () => {
      mockExecute.mockResolvedValueOnce([]);

      const result = await getJobStatus(jobId, userId);

      expect(result).toBeNull();
    });

    it('returns null when job belongs to a different user', async () => {
      mockExecute.mockResolvedValueOnce([
        {
          id: jobId,
          user_id: 'other-user',
          status: 'pending',
          total_items: 1,
          completed_items: 0,
          failed_items: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const result = await getJobStatus(jobId, userId);

      expect(result).toBeNull();
    });

    it('returns job status with results when owned by the user', async () => {
      const jobRow = {
        id: jobId,
        user_id: userId,
        status: 'processing',
        total_items: 2,
        completed_items: 1,
        failed_items: 0,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
      };
      const resultRows = [
        {
          id: 1,
          job_id: jobId,
          item_index: 0,
          status: 'completed',
          context: {},
          extraction: { labelName: { value: 'Sub Pop', confidence: 0.9 } },
          matched_album_id: 42,
          error_message: null,
          created_at: new Date(),
          completed_at: new Date(),
        },
        {
          id: 2,
          job_id: jobId,
          item_index: 1,
          status: 'processing',
          context: {},
          extraction: null,
          matched_album_id: null,
          error_message: null,
          created_at: new Date(),
          completed_at: null,
        },
      ];
      const albumRows = [
        {
          id: 42,
          artist_name: 'Nirvana',
          album_title: 'Bleach',
          code_letters: 'NI',
          code_artist_number: 1,
          code_number: 3,
          genre_name: 'ROCK',
          format_name: 'LP',
          label: 'Sub Pop',
        },
      ];
      mockExecute
        .mockResolvedValueOnce([jobRow])
        .mockResolvedValueOnce(resultRows)
        .mockResolvedValueOnce(albumRows);

      const result = await getJobStatus(jobId, userId);

      if (result === null) {
        throw new Error('Expected non-null result');
      }
      expect(result.jobId).toBe(jobId);
      expect(result.status).toBe('processing');
      expect(result.totalItems).toBe(2);
      expect(result.completedItems).toBe(1);
      expect(result.failedItems).toBe(0);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe('completed');
      expect(result.results[0].matchedAlbum).toEqual({
        id: 42,
        artistName: 'Nirvana',
        albumTitle: 'Bleach',
        codeLetters: 'NI',
        codeArtistNumber: 1,
        codeNumber: 3,
        genreName: 'ROCK',
        formatName: 'LP',
        label: 'Sub Pop',
      });
      expect(result.results[1].status).toBe('processing');
      expect(result.results[1].matchedAlbum).toBeNull();
    });

    it('returns null matchedAlbum when no results have matched albums', async () => {
      const jobRow = {
        id: jobId,
        user_id: userId,
        status: 'completed',
        total_items: 1,
        completed_items: 1,
        failed_items: 0,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
      };
      const resultRows = [
        {
          id: 1,
          job_id: jobId,
          item_index: 0,
          status: 'completed',
          context: {},
          extraction: { labelName: { value: 'Merge', confidence: 0.9 } },
          matched_album_id: null,
          error_message: null,
          created_at: new Date(),
          completed_at: new Date(),
        },
      ];
      // Only two DB calls: job + results (no album lookup needed)
      mockExecute.mockResolvedValueOnce([jobRow]).mockResolvedValueOnce(resultRows);

      const result = await getJobStatus(jobId, userId);

      if (result === null) {
        throw new Error('Expected non-null result');
      }
      expect(result.results[0].matchedAlbum).toBeNull();
    });
  });

  describe('listJobs', () => {
    const userId = 'user-123';

    it('returns empty list when no jobs exist', async () => {
      mockExecute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);

      const result = await listJobs(userId, 20, 0);

      expect(result.jobs).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    it('returns job summaries sorted by created_at descending', async () => {
      const jobRows = [
        {
          id: 'job-2',
          user_id: userId,
          status: 'completed',
          total_items: 3,
          completed_items: 3,
          failed_items: 0,
          created_at: new Date('2026-03-02'),
          updated_at: new Date('2026-03-02'),
        },
        {
          id: 'job-1',
          user_id: userId,
          status: 'pending',
          total_items: 1,
          completed_items: 0,
          failed_items: 0,
          created_at: new Date('2026-03-01'),
          updated_at: new Date('2026-03-01'),
        },
      ];
      mockExecute.mockResolvedValueOnce(jobRows).mockResolvedValueOnce([{ count: 2 }]);

      const result = await listJobs(userId, 20, 0);

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0].jobId).toBe('job-2');
      expect(result.jobs[1].jobId).toBe('job-1');
      expect(result.total).toBe(2);
    });

    it('passes limit and offset to the query', async () => {
      mockExecute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);

      await listJobs(userId, 5, 10);

      expect(mockLimit).toHaveBeenCalledWith(5);
      expect(mockOffset).toHaveBeenCalledWith(10);
    });

    it('maps job rows to BatchJobSummary correctly', async () => {
      const jobRow = {
        id: 'job-abc',
        user_id: userId,
        status: 'completed',
        total_items: 2,
        completed_items: 1,
        failed_items: 1,
        created_at: new Date('2026-02-15'),
        updated_at: new Date('2026-02-16'),
      };
      mockExecute.mockResolvedValueOnce([jobRow]).mockResolvedValueOnce([{ count: 1 }]);

      const result = await listJobs(userId, 20, 0);

      expect(result.jobs[0]).toEqual({
        jobId: 'job-abc',
        status: 'completed',
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        createdAt: new Date('2026-02-15'),
        updatedAt: new Date('2026-02-16'),
      });
    });
  });

  describe('processJobItems', () => {
    const jobId = mockUUID;
    const items = [
      { imageCount: 2, photoTypes: ['front_cover', 'center_label'], context: { artistName: 'Superchunk' } },
      { imageCount: 1, photoTypes: ['front_cover'], context: {} },
    ];
    const imageBuffers = [Buffer.from('img1'), Buffer.from('img2'), Buffer.from('img3')];

    it('processes each item sequentially with correct image slices', async () => {
      mockProcessImages.mockResolvedValue({
        extraction: { labelName: { value: 'Merge', confidence: 0.9 } },
        matchedAlbumId: 101,
      });

      await processJobItems(jobId, items, imageBuffers);

      expect(mockProcessImages).toHaveBeenCalledTimes(2);
      // First item gets images 0-1
      expect(mockProcessImages).toHaveBeenNthCalledWith(
        1,
        [imageBuffers[0], imageBuffers[1]],
        ['front_cover', 'center_label'],
        {
          artistName: 'Superchunk',
        }
      );
      // Second item gets image 2
      expect(mockProcessImages).toHaveBeenNthCalledWith(2, [imageBuffers[2]], ['front_cover'], {});
    });

    it('updates job status to processing at start', async () => {
      mockProcessImages.mockResolvedValue({
        extraction: {},
      });

      await processJobItems(jobId, items, imageBuffers);

      // First update should set job status to processing
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('continues processing remaining items when one fails', async () => {
      mockProcessImages.mockRejectedValueOnce(new Error('Gemini API failed')).mockResolvedValueOnce({
        extraction: { labelName: { value: 'Sub Pop', confidence: 0.9 } },
        matchedAlbumId: 42,
      });

      await processJobItems(jobId, items, imageBuffers);

      expect(mockProcessImages).toHaveBeenCalledTimes(2);
    });

    it('does not throw when all items fail', async () => {
      mockProcessImages.mockRejectedValue(new Error('API down'));

      await expect(processJobItems(jobId, items, imageBuffers)).resolves.not.toThrow();

      expect(mockProcessImages).toHaveBeenCalledTimes(2);
    });
  });
});
