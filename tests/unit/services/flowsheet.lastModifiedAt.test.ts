import { describe, it, expect } from '@jest/globals';
import { db, nyStartOfDay } from '@wxyc/database';
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
//
// BS#1607 fold: the returned value is `max(flowsheet_watermark, nyStartOfDay(now))`
// so the concerts-dependent V2 feed goes stale at ET midnight even without a
// flowsheet write. `now` is injected per test to pin which side of the max
// dominates deterministically.

const mockDb = db as unknown as {
  _chain: Record<string, jest.Mock>;
};

describe('flowsheet.service: getLastModifiedAt', () => {
  it('returns flowsheet_watermark.last_modified_at when it is more recent than ET midnight', async () => {
    // A watermark five seconds after this ET day's midnight dominates the fold.
    const now = new Date('2026-05-25T14:30:00.000Z');
    const watermark = new Date(nyStartOfDay(now).getTime() + 5000);
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([{ at: watermark }]));

    const result = await getLastModifiedAt(now);

    expect(result).toEqual(watermark);
  });

  it('folds up to ET midnight when the watermark is older than the start of today (stale-drop guard)', async () => {
    // Stale-drop case: no overnight flowsheet write, so the watermark predates
    // today's ET midnight. The effective Last-Modified must be today's ET
    // midnight, not the stale watermark — a client's pre-midnight
    // If-Modified-Since then gets a fresh 200 and the past-show CTA is dropped.
    const now = new Date('2026-05-25T14:30:00.000Z');
    const staleWatermark = new Date('2026-05-24T22:00:00.000Z'); // before 2026-05-25 ET midnight
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([{ at: staleWatermark }]));

    const result = await getLastModifiedAt(now);

    expect(result).toEqual(nyStartOfDay(now));
  });

  it('returns ET midnight (not the epoch) when the singleton row is somehow missing (defensive)', async () => {
    // The migration seeds the row at apply time, so this branch only fires if
    // the row was manually deleted post-deploy. The epoch fallback is older
    // than any ET midnight, so the fold surfaces today's ET midnight — still a
    // comparable Date for the conditional-GET middleware.
    const now = new Date('2026-05-25T14:30:00.000Z');
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    const result = await getLastModifiedAt(now);

    expect(result).toEqual(nyStartOfDay(now));
  });
});
