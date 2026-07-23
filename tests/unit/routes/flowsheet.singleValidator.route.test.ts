/**
 * BS#1689: `GET /flowsheet/` and `GET /flowsheet/latest` are watermarked via
 * `conditionalGet`. Route-wiring check (mirrors tests/unit/routes/concerts.route.test.ts)
 * that both carry the fix end to end through the real route module: no
 * Express `ETag` header, and `Cache-Control: no-cache`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetLastModifiedAt = jest.fn<() => Promise<Date>>().mockResolvedValue(new Date('2026-01-01T00:00:00Z'));
const mockGetEntriesByPage = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetEntryCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);
const mockGetOnAirDJName = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);
const mockAttachUpcomingShows = jest.fn((entries: unknown[]) => Promise.resolve(entries));
const mockTransformToV2 = jest.fn((entry: unknown) => entry);

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLastModifiedAt: mockGetLastModifiedAt,
  getEntriesByPage: mockGetEntriesByPage,
  getEntryCount: mockGetEntryCount,
  getOnAirDJName: mockGetOnAirDJName,
  attachUpcomingShows: mockAttachUpcomingShows,
  transformToV2: mockTransformToV2,
}));

const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

jest.mock('../../../apps/backend/middleware/legacy/flowsheet.mirror', () => ({
  flowsheetMirror: {
    getEntries: passThrough,
    addEntry: passThrough,
    updateEntry: passThrough,
    deleteEntry: passThrough,
    startShow: passThrough,
    endShow: passThrough,
  },
}));

import { flowsheet_route } from '../../../apps/backend/routes/flowsheet.route';

const app = express();
app.use(express.json());
app.use('/flowsheet', flowsheet_route);

describe('flowsheet route single-validator headers (BS#1689)', () => {
  beforeEach(() => {
    mockGetLastModifiedAt.mockClear().mockResolvedValue(new Date('2026-01-01T00:00:00Z'));
    mockGetEntriesByPage.mockClear().mockResolvedValue([]);
    mockGetEntryCount.mockClear().mockResolvedValue(0);
    mockGetOnAirDJName.mockClear().mockResolvedValue(null);
  });

  it('GET /flowsheet/latest carries no ETag and Cache-Control: no-cache', async () => {
    const res = await request(app).get('/flowsheet/latest');

    expect(res.status).toBe(204);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('GET /flowsheet/ carries no ETag and Cache-Control: no-cache', async () => {
    const res = await request(app).get('/flowsheet/');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});
