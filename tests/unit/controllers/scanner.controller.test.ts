/**
 * Unit tests for the scanner controller batch endpoints.
 */

import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock the batch service
const mockCreateBatchJob = jest.fn<
  (
    userId: string,
    items: unknown[],
    imageBuffers: Buffer[]
  ) => Promise<{
    jobId: string;
    status: string;
    totalItems: number;
  }>
>();
const mockGetJobStatus = jest.fn<(jobId: string, userId: string) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/scanner/batch', () => ({
  createBatchJob: mockCreateBatchJob,
  getJobStatus: mockGetJobStatus,
}));

// Mock the processor (for scanImages handler which we're not testing here but need for the import)
jest.mock('../../../apps/backend/services/scanner/processor', () => ({
  processImages: jest.fn(),
}));

// Mock discogs service
jest.mock('../../../apps/backend/services/discogs/discogs.service', () => ({
  DiscogsService: {
    searchByBarcode: jest.fn(),
  },
}));

import { createBatchScan, getBatchStatus } from '../../../apps/backend/controllers/scanner.controller';

// Helper to create mock Express req/res/next
const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
};

describe('scanner.controller', () => {
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn() as unknown as NextFunction;
  });

  describe('createBatchScan', () => {
    it('returns 400 when no images are uploaded', async () => {
      const req = {
        files: [],
        body: { manifest: JSON.stringify({ items: [] }) },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      await createBatchScan(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('image') }));
    });

    it('returns 400 when manifest is missing', async () => {
      const req = {
        files: [{ buffer: Buffer.from('img'), mimetype: 'image/jpeg' }],
        body: {},
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      await createBatchScan(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('manifest') }));
    });

    it('returns 400 when manifest has invalid JSON', async () => {
      const req = {
        files: [{ buffer: Buffer.from('img'), mimetype: 'image/jpeg' }],
        body: { manifest: 'not valid json' },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      await createBatchScan(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when image count does not match manifest sum', async () => {
      const manifest = {
        items: [{ imageCount: 3, photoTypes: ['front_cover', 'back_cover', 'center_label'], context: {} }],
      };
      const req = {
        files: [{ buffer: Buffer.from('img1') }], // only 1 image, manifest says 3
        body: { manifest: JSON.stringify(manifest) },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      await createBatchScan(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when batch exceeds 10 items', async () => {
      const items = Array.from({ length: 11 }, () => ({
        imageCount: 1,
        photoTypes: ['front_cover'],
        context: {},
      }));
      const files = Array.from({ length: 11 }, () => ({ buffer: Buffer.from('img') }));
      const req = {
        files,
        body: { manifest: JSON.stringify({ items }) },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      await createBatchScan(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 202 with job info on success', async () => {
      const manifest = {
        items: [
          { imageCount: 2, photoTypes: ['front_cover', 'center_label'], context: { artistName: 'Superchunk' } },
          { imageCount: 1, photoTypes: ['front_cover'], context: {} },
        ],
      };
      const files = [{ buffer: Buffer.from('img1') }, { buffer: Buffer.from('img2') }, { buffer: Buffer.from('img3') }];
      const req = {
        files,
        body: { manifest: JSON.stringify(manifest) },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      mockCreateBatchJob.mockResolvedValue({
        jobId: 'job-uuid',
        status: 'pending',
        totalItems: 2,
      });

      await createBatchScan(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(mockCreateBatchJob).toHaveBeenCalledWith('user-123', manifest.items, [
        files[0].buffer,
        files[1].buffer,
        files[2].buffer,
      ]);
    });
  });

  describe('getBatchStatus', () => {
    it('returns 400 for invalid UUID', async () => {
      const req = {
        params: { jobId: 'not-a-uuid' },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      await getBatchStatus(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when job not found', async () => {
      const req = {
        params: { jobId: '550e8400-e29b-41d4-a716-446655440000' },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      mockGetJobStatus.mockResolvedValue(null);

      await getBatchStatus(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 200 with job status', async () => {
      const jobStatus = {
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        totalItems: 2,
        completedItems: 2,
        failedItems: 0,
        results: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const req = {
        params: { jobId: '550e8400-e29b-41d4-a716-446655440000' },
        auth: { id: 'user-123' },
      } as unknown as Request;
      const res = createMockRes();

      mockGetJobStatus.mockResolvedValue(jobStatus);

      await getBatchStatus(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(jobStatus);
      expect(mockGetJobStatus).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000', 'user-123');
    });
  });
});
