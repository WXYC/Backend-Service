import { describe, it, expect } from '@jest/globals';
import { db } from '@wxyc/database';
import { getCatalogLastModifiedAt } from '../../../apps/backend/services/library.service';

// `getCatalogLastModifiedAt` is the catalog analogue of
// `flowsheet.service.getLastModifiedAt` (BS#1467 / Epic F). It reads the
// single-row `library_watermark` table whose `last_modified_at` is bumped by
// an AFTER STATEMENT trigger on `library` (migration 0104). The trigger fires
// on INSERT/UPDATE/DELETE — including the daily `library-etl` write that
// bypasses the BS app layer — so the watermark advances monotonically. A MAX
// over a per-row column would retreat on DELETE of the peak row and miss the
// ETL writes that never touch the service layer.
//
// The service is shaped `await db.select({...}).from(library_watermark).limit(1)`
// — `.limit()` is the terminal step the await resolves. The shared mock chain
// wires `.limit()` to return the chain by default; per-test we use
// `mockReturnValueOnce` to swap a thenable into that position.

const mockDb = db as unknown as {
  _chain: Record<string, jest.Mock>;
};

describe('library.service: getCatalogLastModifiedAt', () => {
  it('returns library_watermark.last_modified_at when the singleton row exists', async () => {
    const watermark = new Date('2026-06-20T09:15:00.000Z');
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([{ at: watermark }]));

    const result = await getCatalogLastModifiedAt();

    expect(result).toEqual(watermark);
  });

  it('returns the epoch (new Date(0)) when the singleton row is somehow missing (defensive)', async () => {
    // The migration seeds the row at apply time, so this branch only fires
    // if the row was manually deleted post-deploy. Belt-and-braces fallback
    // so the conditional-GET middleware always has a comparable Date in hand.
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    const result = await getCatalogLastModifiedAt();

    expect(result).toEqual(new Date(0));
  });
});
