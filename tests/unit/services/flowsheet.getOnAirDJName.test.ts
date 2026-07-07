/**
 * Unit tests for getOnAirDJName — the helper backing the `on_air` field on the
 * default paginated GET /flowsheet response (BS on-air-banner fix).
 *
 * It resolves the display name of the DJ currently on air by reading the latest
 * show and running it through resolveDjNameForShow. Crucially it does NOT read
 * the `show_djs` join table (the pre-existing `/djs-on-air` + `/on-air` bug):
 * tubafrenzy-mirrored shows have no `show_djs` rows, so their DJ identity lives
 * only in `shows.legacy_dj_name`. The regression this fixes is the banner
 * showing "AUTO DJ" while DJ MONSTER — a legacy-mirrored show — was live.
 *
 * Mock mechanics: getLatestShow → getNShows(1) terminates in `.limit()`, and
 * resolveDjNameForShow's user lookup also terminates in `.limit()`. Both consume
 * from the same `_chain.limit` once-queue, so queued values are order-sensitive:
 * the show row first, then (only when a primary DJ is present) the user row.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { getOnAirDJName } from '../../../apps/backend/services/flowsheet.service';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;

// Queue the next value the terminal `.limit()` resolves to. Left unqueued, the
// default mock returns the chain itself, so getLatestShow() yields undefined.
const queueLimit = (rows: unknown[]) => chain.limit.mockResolvedValueOnce(rows);

describe('getOnAirDJName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns shows.legacy_dj_name for an open tubafrenzy-mirrored show — the DJ MONSTER production bug', async () => {
    queueLimit([
      { id: 1950003, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: 'DJ MONSTER' },
    ]);

    expect(await getOnAirDJName()).toBe('DJ MONSTER');
  });

  it('resolves the primary DJ user.djName for an open show with a Backend-Service account', async () => {
    queueLimit([{ id: 2, end_time: null, primary_dj_id: 'user-1', dj_name_override: null, legacy_dj_name: null }]);
    queueLimit([{ djName: 'DJ HOUNDSTOOTH' }]); // resolveDjNameForShow user lookup

    expect(await getOnAirDJName()).toBe('DJ HOUNDSTOOTH');
  });

  it('returns null for an open show with no resolvable DJ name', async () => {
    queueLimit([{ id: 3, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: null }]);

    expect(await getOnAirDJName()).toBeNull();
  });

  it('returns null when the latest show has already ended (end_time set) — automation', async () => {
    queueLimit([
      {
        id: 4,
        end_time: new Date('2026-07-07T18:00:00Z'),
        primary_dj_id: null,
        dj_name_override: null,
        legacy_dj_name: 'DJ MONSTER',
      },
    ]);

    expect(await getOnAirDJName()).toBeNull();
  });

  it('returns null when there is no latest show at all', async () => {
    // No queued value → getLatestShow() resolves undefined.
    expect(await getOnAirDJName()).toBeNull();
  });
});
