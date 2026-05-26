import { describe, it, expect } from '@jest/globals';
import { db } from '@wxyc/database';
import { getLastModifiedAt } from '../../../apps/backend/services/flowsheet.service';

// `getLastModifiedAt` is the post-BS#902 replacement for the process-local
// `lastModifiedAt: Date`. It reads the single-row `flowsheet_watermark`
// sibling table whose `last_modified_at` is bumped by an AFTER STATEMENT
// trigger on `flowsheet` (migration 0084). The trigger fires on
// INSERT/UPDATE/DELETE so the watermark advances monotonically — a MAX
// over `flowsheet.updated_at` would retreat on DELETE of the peak row,
// which would cause polling clients to 304 against a stale baseline.
//
// The service is shaped `await db.select({...}).from(flowsheet_watermark).limit(1)`
// — `.limit()` is the terminal step that the await resolves. The shared
// mock chain wires `.limit()` to return the chain itself by default; per-
// test we use `mockReturnValueOnce` to swap a thenable into that position,
// which is what `await` actually consumes.

const mockDb = db as unknown as {
  _chain: Record<string, jest.Mock>;
};

describe('flowsheet.service: getLastModifiedAt', () => {
  it('returns flowsheet_watermark.last_modified_at when the singleton row exists', async () => {
    const watermark = new Date('2026-05-25T14:30:00.000Z');
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([{ at: watermark }]));

    const result = await getLastModifiedAt();

    expect(result).toEqual(watermark);
  });

  it('returns the epoch (new Date(0)) when the singleton row is somehow missing (defensive)', async () => {
    // The migration seeds the row at apply time, so this branch only
    // fires if the row was manually deleted post-deploy. Belt-and-braces
    // fallback so the conditional-GET middleware always has a comparable
    // Date in hand.
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    const result = await getLastModifiedAt();

    expect(result).toEqual(new Date(0));
  });
});
