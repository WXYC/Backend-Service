/**
 * Unit tests for the playlist proxy service.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) replaced the SSE-fed
 * in-memory store with a direct Postgres query. These tests mock the `db`
 * query builder and exercise: entry_type -> tubafrenzy wire-vocabulary
 * mapping, hour/chronOrderID/timeCreated synthesis, rotation/request string
 * coercion, playcut slicing vs. unsliced talksets/breakpoints, and artwork
 * enrichment (including the BS#1105 split-format tie-break, preserved from
 * the pre-Phase-3 implementation).
 */
import { jest } from '@jest/globals';

// --- Mocks ---

// Mock the database module. A single shared chain object is reused for both
// query shapes getRecentEntries issues:
//   1. main entries query:   select().from(flowsheet).leftJoin(rotation, ...).orderBy(...).limit(...)
//   2. artwork batch query:  select().from(flowsheet).innerJoin(album_metadata, ...).where(...).groupBy(...)
// The two are distinguished by their terminal method: `.limit()` resolves
// the main entries rows, `.groupBy()` resolves the artwork rows.
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockLeftJoin = jest.fn();
const mockInnerJoin = jest.fn();
const mockWhere = jest.fn();
const mockGroupBy = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();

const mockDbChain = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  groupBy: mockGroupBy,
  orderBy: mockOrderBy,
  limit: mockLimit,
};
mockSelect.mockReturnValue(mockDbChain);
mockFrom.mockReturnValue(mockDbChain);
mockLeftJoin.mockReturnValue(mockDbChain);
mockInnerJoin.mockReturnValue(mockDbChain);
mockWhere.mockReturnValue(mockDbChain);
mockGroupBy.mockResolvedValue([]);
mockOrderBy.mockReturnValue(mockDbChain);
mockLimit.mockResolvedValue([]);

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    leftJoin: (...args: unknown[]) => mockLeftJoin(...args),
    innerJoin: (...args: unknown[]) => mockInnerJoin(...args),
    where: (...args: unknown[]) => mockWhere(...args),
    groupBy: (...args: unknown[]) => mockGroupBy(...args),
    orderBy: (...args: unknown[]) => mockOrderBy(...args),
    limit: (...args: unknown[]) => mockLimit(...args),
  },
  flowsheet: {
    id: 'id',
    entry_type: 'entry_type',
    add_time: 'add_time',
    radio_hour: 'radio_hour',
    track_title: 'track_title',
    artist_name: 'artist_name',
    album_title: 'album_title',
    record_label: 'record_label',
    request_flag: 'request_flag',
    rotation_id: 'rotation_id',
    album_id: 'album_id',
  },
  album_metadata: {
    album_id: 'album_metadata.album_id',
    artwork_url: 'album_metadata.artwork_url',
  },
  rotation: {
    id: 'rotation.id',
    rotation_bin: 'rotation.rotation_bin',
    album_id: 'rotation.album_id',
    artist_name: 'rotation.artist_name',
    album_title: 'rotation.album_title',
    add_date: 'rotation.add_date',
    kill_date: 'rotation.kill_date',
  },
  library: {
    id: 'library.id',
    artist_id: 'library.artist_id',
    album_title: 'library.album_title',
  },
  artists: {
    id: 'artists.id',
    artist_name: 'artists.artist_name',
  },
}));

jest.mock('drizzle-orm', () => ({
  sql: Object.assign(jest.fn(), { raw: jest.fn() }),
  inArray: jest.fn(),
  isNotNull: jest.fn(),
  and: jest.fn(),
  eq: jest.fn(),
  desc: jest.fn(),
}));

// Suppress console output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { getRecentEntries } from '../../../apps/backend/services/playlist-proxy.service';

// --- Fixtures: representative WXYC data ---
// (see the org CLAUDE.md "Example Music Data" section for the canonical pool)

const jessicaPrattRow = {
  id: 2602250,
  entry_type: 'track',
  add_time: new Date('2026-07-28T20:47:33.000Z'),
  radio_hour: null,
  track_title: 'Back, Baby',
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
  record_label: 'Drag City',
  request_flag: false,
  rotation_bin: null,
};

const juanaMolinaRow = {
  id: 2602249,
  entry_type: 'track',
  add_time: new Date('2026-07-28T20:41:08.000Z'),
  radio_hour: null,
  track_title: 'la paradoja',
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  record_label: 'Sonamos',
  request_flag: true,
  rotation_bin: 'M',
};

const talksetRow = {
  id: 2602247,
  entry_type: 'talkset',
  add_time: new Date('2026-07-28T20:33:40.000Z'),
  radio_hour: null,
  track_title: null,
  artist_name: null,
  album_title: null,
  record_label: null,
  request_flag: null,
  rotation_bin: null,
};

const djJoinRow = {
  id: 2602246,
  entry_type: 'dj_join',
  add_time: new Date('2026-07-28T20:30:00.000Z'),
  radio_hour: null,
  track_title: null,
  artist_name: null,
  album_title: null,
  record_label: null,
  request_flag: null,
  rotation_bin: null,
};

const djLeaveRow = { ...djJoinRow, id: 2602245, entry_type: 'dj_leave' };
const messageRow = { ...djJoinRow, id: 2602244, entry_type: 'message' };

const breakpointRow = {
  id: 2602238,
  entry_type: 'breakpoint',
  // Logged ~1 min before the top of the hour, per schema.ts's radio_hour comment.
  add_time: new Date('2026-07-28T19:59:12.000Z'),
  radio_hour: new Date('2026-07-28T20:00:00.000Z'),
  track_title: null,
  artist_name: null,
  album_title: null,
  record_label: null,
  request_flag: null,
  rotation_bin: null,
};

const legacyBreakpointRowNoRadioHour = {
  ...breakpointRow,
  id: 2602237,
  radio_hour: null, // pre-backfill row
};

const showStartRow = {
  id: 2602200,
  entry_type: 'show_start',
  add_time: new Date('2026-07-28T18:00:00.000Z'),
  radio_hour: null,
  track_title: null,
  artist_name: null,
  album_title: null,
  record_label: null,
  request_flag: null,
  rotation_bin: null,
};

const showEndRow = { ...showStartRow, id: 2602199, entry_type: 'show_end' };

// --- Tests ---

describe('playlist-proxy.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockReturnValue(mockDbChain);
    mockFrom.mockReturnValue(mockDbChain);
    mockLeftJoin.mockReturnValue(mockDbChain);
    mockInnerJoin.mockReturnValue(mockDbChain);
    mockWhere.mockReturnValue(mockDbChain);
    mockOrderBy.mockReturnValue(mockDbChain);
    mockGroupBy.mockResolvedValue([]); // artwork query default: no matches
    mockLimit.mockResolvedValue([]); // main entries query default: empty
  });

  describe('getRecentEntries — grouping and entry_type mapping', () => {
    it('maps track rows to playcuts', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts).toHaveLength(1);
      expect(result.playcuts[0].songTitle).toBe('Back, Baby');
      expect(result.playcuts[0].artistName).toBe('Jessica Pratt');
      expect(result.playcuts[0].releaseTitle).toBe('On Your Own Love Again');
      expect(result.playcuts[0].labelName).toBe('Drag City');
    });

    it('maps talkset rows to talksets', async () => {
      mockLimit.mockResolvedValue([talksetRow]);

      const result = await getRecentEntries(50);

      expect(result.talksets).toHaveLength(1);
      expect(result.talksets[0]).toEqual({
        id: 2602247,
        chronOrderID: 2602247,
        hour: new Date('2026-07-28T20:00:00.000Z').getTime(),
        timeCreated: talksetRow.add_time.getTime(),
      });
    });

    it('maps dj_join, dj_leave, and message rows to talksets (mirrors mapEntryToTubafrenzy flowsheetEntryType=7)', async () => {
      mockLimit.mockResolvedValue([djJoinRow, djLeaveRow, messageRow]);

      const result = await getRecentEntries(50);

      expect(result.talksets).toHaveLength(3);
      expect(result.talksets.map((t) => t.id)).toEqual(
        expect.arrayContaining([djJoinRow.id, djLeaveRow.id, messageRow.id])
      );
    });

    it('maps breakpoint rows to breakpoints', async () => {
      mockLimit.mockResolvedValue([breakpointRow]);

      const result = await getRecentEntries(50);

      expect(result.breakpoints).toHaveLength(1);
      expect(result.breakpoints[0].id).toBe(2602238);
    });

    it('omits show_start and show_end rows entirely (showDelimiter, matching tubafrenzy v=2 wire contract)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, showStartRow, talksetRow, breakpointRow, showEndRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts).toHaveLength(1);
      expect(result.talksets).toHaveLength(1);
      expect(result.breakpoints).toHaveLength(1);
    });

    it('queries the most recent MAX_ENTRIES (200) rows ordered by flowsheet.id DESC', async () => {
      await getRecentEntries(50);

      expect(mockOrderBy).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(200);
    });
  });

  describe('getRecentEntries — playcut slicing vs. unsliced talksets/breakpoints', () => {
    it('slices playcuts to n but returns all talksets/breakpoints found in the window', async () => {
      const manyPlaycuts = Array.from({ length: 10 }, (_, i) => ({
        ...jessicaPrattRow,
        id: 3000 + i,
      }));
      mockLimit.mockResolvedValue([...manyPlaycuts, talksetRow, breakpointRow]);

      const result = await getRecentEntries(3);

      expect(result.playcuts).toHaveLength(3);
      expect(result.talksets).toHaveLength(1);
      expect(result.breakpoints).toHaveLength(1);
    });

    it('keeps the most recent playcuts first (rows already arrive DESC by id)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, juanaMolinaRow]);

      const result = await getRecentEntries(1);

      expect(result.playcuts).toHaveLength(1);
      expect(result.playcuts[0].id).toBe(jessicaPrattRow.id);
    });

    it('returns empty groups when the table has no recent rows', async () => {
      mockLimit.mockResolvedValue([]);

      const result = await getRecentEntries(50);

      expect(result.playcuts).toEqual([]);
      expect(result.talksets).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });
  });

  describe('getRecentEntries — id-derived chronOrderID/timeCreated', () => {
    it('uses flowsheet.id for both id and chronOrderID (globally monotonic, matches flowsheet.service.ts convention)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].id).toBe(jessicaPrattRow.id);
      expect(result.playcuts[0].chronOrderID).toBe(jessicaPrattRow.id);
    });

    it('uses add_time epoch ms for timeCreated', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].timeCreated).toBe(jessicaPrattRow.add_time.getTime());
    });
  });

  describe('getRecentEntries — hour computation', () => {
    it('floors add_time to the top of the hour for track rows (mirrors mapEntryToTubafrenzy radioHour formula)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].hour).toBe(new Date('2026-07-28T20:00:00.000Z').getTime());
    });

    it('uses flowsheet.radio_hour verbatim for breakpoints when present (BS#1448/#1449 — flooring add_time would round to the prior hour)', async () => {
      mockLimit.mockResolvedValue([breakpointRow]);

      const result = await getRecentEntries(50);

      expect(result.breakpoints[0].hour).toBe(breakpointRow.radio_hour.getTime());
      // add_time (19:59:12) floors to 19:00, which would be WRONG for this row.
      expect(result.breakpoints[0].hour).not.toBe(new Date('2026-07-28T19:00:00.000Z').getTime());
    });

    it('falls back to floor(add_time) for breakpoints with no radio_hour (pre-backfill rows)', async () => {
      mockLimit.mockResolvedValue([legacyBreakpointRowNoRadioHour]);

      const result = await getRecentEntries(50);

      expect(result.breakpoints[0].hour).toBe(new Date('2026-07-28T19:00:00.000Z').getTime());
    });
  });

  describe('getRecentEntries — rotation/request string coercion', () => {
    // Preserving the legacy tubafrenzy wire-format quirk: rotation/request
    // are "true"/"false" STRINGS, not booleans (see PR description).
    it('emits rotation as the string "true" when rotation_bin is non-null', async () => {
      mockLimit.mockResolvedValue([juanaMolinaRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].rotation).toBe('true');
      expect(typeof result.playcuts[0].rotation).toBe('string');
    });

    it('emits rotation as the string "false" when rotation_bin is null', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].rotation).toBe('false');
    });

    it('emits request as the string "true"/"false" from request_flag', async () => {
      mockLimit.mockResolvedValue([juanaMolinaRow, jessicaPrattRow]);

      const result = await getRecentEntries(50);

      const juana = result.playcuts.find((p) => p.artistName === 'Juana Molina');
      const jessica = result.playcuts.find((p) => p.artistName === 'Jessica Pratt');
      expect(juana?.request).toBe('true');
      expect(typeof juana?.request).toBe('string');
      expect(jessica?.request).toBe('false');
    });
  });

  describe('getRecentEntries — artwork enrichment', () => {
    it('enriches playcuts with artwork from DB', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGroupBy.mockResolvedValue([
        { key: 'jessica pratt-on your own love again', artwork_url: 'https://i.discogs.com/jessica.jpg' },
      ]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/jessica.jpg');
    });

    it('omits artworkURL when there is no metadata match', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGroupBy.mockResolvedValue([]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBeUndefined();
    });

    it('degrades to no artwork (rather than throwing) when the artwork query fails', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGroupBy.mockRejectedValue(new Error('DB connection lost'));

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBeUndefined();
    });

    it('does not query artwork at all when there are no playcuts', async () => {
      mockLimit.mockResolvedValue([talksetRow, breakpointRow]);

      await getRecentEntries(50);

      expect(mockGroupBy).not.toHaveBeenCalled();
    });

    it('only enriches the sliced playcuts, not the full 200-row window', async () => {
      const manyPlaycuts = Array.from({ length: 10 }, (_, i) => ({
        ...jessicaPrattRow,
        id: 4000 + i,
      }));
      mockLimit.mockResolvedValue(manyPlaycuts);
      mockGroupBy.mockResolvedValue([]);

      await getRecentEntries(3);

      // inArray(flowsheetLookupKey, keys) is the first arg passed through
      // `and(...)` to `.where(...)` — drizzle-orm is mocked, so we can only
      // assert the query executed once (batched), not literally introspect
      // the key list through the mocked `and`/`inArray`.
      expect(mockGroupBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('artwork query: partial-index alignment (regression for #511, BS#1012)', () => {
    // The post-D5 partial functional index `flowsheet_album_link_lookup_idx`
    // (migration 0081) only covers rows where `album_id IS NOT NULL`. The
    // artwork query INNER JOINs flowsheet ⨝ album_metadata, which drops
    // `flowsheet.album_id IS NULL` rows naturally and therefore matches the
    // partial-index predicate so the lookup_key probe is an index scan
    // instead of a 2.6M-row seq scan (incident #511).
    //
    // Source-grep over the deployed file is the right shape because the bug
    // class is a *missing* clause in the SQL builder. A behavioural test
    // wouldn't catch a future regression where someone adds a new query path
    // without the join + filter; the source-grep does.
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');

    const proxySource = fs.readFileSync(
      path.resolve(__dirname, '../../../apps/backend/services/playlist-proxy.service.ts'),
      'utf-8'
    );

    it('imports `and`, `isNotNull`, `eq`, and `desc` from drizzle-orm', () => {
      expect(proxySource).toMatch(/from\s+'drizzle-orm'/);
      expect(proxySource).toMatch(/\band\b/);
      expect(proxySource).toMatch(/\bisNotNull\b/);
      expect(proxySource).toMatch(/\beq\b/);
      expect(proxySource).toMatch(/\bdesc\b/);
    });

    it('imports album_metadata, rotation, library, and artists alongside flowsheet from @wxyc/database', () => {
      expect(proxySource).toMatch(/from\s+'@wxyc\/database'/);
      expect(proxySource).toMatch(/\balbum_metadata\b/);
      expect(proxySource).toMatch(/\brotation\b/);
      expect(proxySource).toMatch(/\blibrary\b/);
      expect(proxySource).toMatch(/\bartists\b/);
    });

    it('the flowsheet artwork SELECT inner-joins album_metadata on album_id and filters isNotNull(album_metadata.artwork_url)', () => {
      const chains = proxySource.match(/db\s*\.\s*select[\s\S]*?\.\s*groupBy\([\s\S]*?\)\s*;/g) ?? [];
      const artworkChains = chains.filter((c) => /flowsheetLookupKey/.test(c));
      expect(artworkChains.length).toBe(1);
      for (const chain of artworkChains) {
        expect(chain).toMatch(
          /\.innerJoin\(\s*album_metadata\s*,\s*eq\(\s*album_metadata\.album_id\s*,\s*flowsheet\.album_id\s*\)\s*\)/
        );
        expect(chain).toMatch(/isNotNull\s*\(\s*album_metadata\.artwork_url\s*\)/);
      }
    });

    it('does not read flowsheet.artwork_url (D4 column-drop safety)', () => {
      // BS#1012 / D5 cut the proxy off `flowsheet.artwork_url` so D4 (#900)
      // can drop the column. If someone re-adds a read of it, this test
      // catches the regression at PR time before the next D4 attempt wedges
      // on a missing column.
      expect(proxySource).not.toMatch(/flowsheet\.artwork_url/);
    });
  });

  describe('artwork tie-break: split-format albums (BS#1105)', () => {
    // Preserved verbatim from the pre-Phase-3 implementation (commit
    // d0b8317d, closes #1105). See enrichPlaycuts' docstring in the service
    // file for the full rationale.
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');

    const proxySource = fs.readFileSync(
      path.resolve(__dirname, '../../../apps/backend/services/playlist-proxy.service.ts'),
      'utf-8'
    );

    it('groups by lookup key alone and aggregates artwork_url deterministically by lowest album_id', () => {
      const chains = proxySource.match(/db\s*\.\s*select[\s\S]*?\.\s*groupBy\([\s\S]*?\)\s*;/g) ?? [];
      const batchChain = chains.find((c) => /flowsheetLookupKey/.test(c));
      expect(batchChain).toBeDefined();
      expect(batchChain).toMatch(/\.groupBy\(\s*flowsheetLookupKey\s*\)/);
      expect(batchChain).not.toMatch(/\.groupBy\(\s*flowsheetLookupKey\s*,\s*album_metadata\.artwork_url\s*\)/);
      expect(batchChain).toMatch(
        /array_agg\(\s*\$\{album_metadata\.artwork_url\}\s*order by\s*\$\{album_metadata\.album_id\}\s*asc\s*\)\)\[1\]/
      );
    });

    it('behaviorally resolves the artwork the mocked tie-break query returns onto the matching playcut', async () => {
      mockLimit.mockResolvedValue([juanaMolinaRow]);
      mockGroupBy.mockResolvedValue([
        { key: 'juana molina-doga', artwork_url: 'https://i.discogs.com/lowest-album-id.jpg' },
      ]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/lowest-album-id.jpg');
    });
  });
});
