/**
 * Unit tests for getOnAirDJs — the on-air DJ list backing GET /flowsheet/djs-on-air.
 *
 * The pre-existing endpoint derived its list from the `show_djs` join table only
 * (`getDJsInCurrentShow` → `getDJsInShow`), so tubafrenzy-mirrored shows — which
 * have no `show_djs` rows because their DJ has no Backend-Service account —
 * reported an empty list while a human DJ was live (dj-site's NowPlaying banner
 * then read "Off Air"). getOnAirDJs keeps the account-DJ behavior (active
 * co-hosts, each with their `auth_user.id` string) and adds a legacy fallback:
 * when the open show has no account rows, it surfaces the DJ from
 * `resolveDjNameForShow` with a null id (BS#1547).
 *
 * Mock mechanics: getLatestShow → getNShows(1) terminates in `.limit()`.
 * getDJsInShow issues two queries that terminate in `.where()` (the show_djs
 * join, then the user lookup), so those are queued on the separate `.where`
 * once-queue. resolveDjNameForShow only queries (via `.limit(1)`) when a primary
 * DJ is present; the legacy branch here has `primary_dj_id: null`, so it
 * short-circuits to `legacy_dj_name` with no extra query.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { getOnAirDJs } from '../../../apps/backend/services/flowsheet.service';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;

// getLatestShow's terminal `.limit()`. Left unqueued, getLatestShow → undefined.
const queueLimit = (rows: unknown[]) => chain.limit.mockResolvedValueOnce(rows);
// getDJsInShow's two terminal `.where()` reads (show_djs join, then user lookup).
const queueWhere = (rows: unknown[]) => chain.where.mockResolvedValueOnce(rows);

describe('getOnAirDJs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns legacy_dj_name with a null id for an open tubafrenzy-mirrored show (show_djs empty) — the DJ MONSTER production bug', async () => {
    queueLimit([
      { id: 1950003, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: 'DJ MONSTER' },
    ]);
    queueWhere([]); // show_djs join: no account rows
    queueWhere([]); // user lookup over the (empty) dj_ids

    expect(await getOnAirDJs()).toEqual([{ id: null, dj_name: 'DJ MONSTER' }]);
  });

  it('returns active account DJs with their user id and resolved name when show_djs has rows (co-hosts preserved)', async () => {
    queueLimit([{ id: 2, end_time: null, primary_dj_id: 'user-1', dj_name_override: null, legacy_dj_name: null }]);
    queueWhere([
      { dj_id: 'user-1', active: true },
      { dj_id: 'user-2', active: true },
    ]);
    queueWhere([
      { id: 'user-1', djName: 'DJ HOUNDSTOOTH' },
      { id: 'user-2', djName: 'DJ MONSTER' },
    ]);

    expect(await getOnAirDJs()).toEqual([
      { id: 'user-1', dj_name: 'DJ HOUNDSTOOTH' },
      { id: 'user-2', dj_name: 'DJ MONSTER' },
    ]);
  });

  it('preserves the existing Anonymous-filtering behavior on the account path (dj_name null, id retained)', async () => {
    queueLimit([{ id: 6, end_time: null, primary_dj_id: 'user-9', dj_name_override: null, legacy_dj_name: null }]);
    queueWhere([{ dj_id: 'user-9', active: true }]);
    queueWhere([{ id: 'user-9', djName: 'Anonymous' }]);

    expect(await getOnAirDJs()).toEqual([{ id: 'user-9', dj_name: null }]);
  });

  it('returns [] when the latest show has already ended (automation)', async () => {
    queueLimit([
      {
        id: 4,
        end_time: new Date('2026-07-07T18:00:00Z'),
        primary_dj_id: null,
        dj_name_override: null,
        legacy_dj_name: 'DJ MONSTER',
      },
    ]);

    expect(await getOnAirDJs()).toEqual([]);
  });

  it('returns [] when there is no latest show at all', async () => {
    expect(await getOnAirDJs()).toEqual([]);
  });

  it('returns [] for an open legacy show with no resolvable DJ name (no show_djs, null legacy_dj_name)', async () => {
    queueLimit([{ id: 5, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: null }]);
    queueWhere([]); // show_djs join
    queueWhere([]); // user lookup

    expect(await getOnAirDJs()).toEqual([]);
  });
});
