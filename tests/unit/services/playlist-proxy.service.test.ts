/**
 * Unit tests for the playlist proxy service.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) replaced the SSE-fed
 * in-memory store with a direct Postgres query. These tests mock the `db`
 * query builder and exercise: entry_type -> tubafrenzy wire-vocabulary
 * mapping, hour/chronOrderID/timeCreated synthesis, rotation/request string
 * coercion, playcut slicing vs. unsliced talksets/breakpoints, and artwork
 * enrichment (including the BS#1105 split-format tie-break, rewritten from
 * an `array_agg(...)[1]` to a `DISTINCT ON` by BS#1800).
 *
 * BS#2103 added the v=2 metadata enrichment — streaming links, bio,
 * genres/styles, release year, artist id, critic reviews, upcoming show —
 * under the camelCase key names shipped iOS 3.2 decodes. Its coverage lives in
 * the "v=2 metadata enrichment (BS#2103)" block below and is deliberately
 * key-name-exact: a wrong name fails SILENTLY on the client (JSONDecoder drops
 * the key), so the wire names are asserted literally and as a closed set.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

// Mock the database module. A single shared chain object is reused for the
// main entries query shape getRecentEntries issues:
//   select().from(flowsheet).leftJoin(rotation, ...).orderBy(...).limit(...)
// resolved by its terminal `.limit()`. The artwork batch query is a separate
// entry point/chain (BS#1800 rewrote it from `.select()...groupBy()` to
// `.selectDistinctOn()...orderBy()`, and `.orderBy()` is also a *non-terminal*
// link in the main chain above, so it needs its own mock chain to avoid the
// two meanings colliding):
//   selectDistinctOn().from(flowsheet).innerJoin(album_metadata, ...).where(...).orderBy(...)
// resolved by its terminal `.orderBy()`.
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockLeftJoin = jest.fn();
const mockInnerJoin = jest.fn();
const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
// db.execute(sql`...`) resolves the batched rotation-fallback query (BS#1862).
const mockExecute = jest.fn();

const mockDbChain = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
};
mockSelect.mockReturnValue(mockDbChain);
mockFrom.mockReturnValue(mockDbChain);
mockLeftJoin.mockReturnValue(mockDbChain);
mockInnerJoin.mockReturnValue(mockDbChain);
mockWhere.mockReturnValue(mockDbChain);
mockOrderBy.mockReturnValue(mockDbChain);
mockLimit.mockResolvedValue([]);
mockExecute.mockResolvedValue([]); // rotation fallback: no matches by default

// Separate chain for the artwork `db.selectDistinctOn(...)` query (BS#1105 /
// BS#1800) — kept apart from mockDbChain because its terminal call is
// `.orderBy()`, which mockDbChain's main-entries chain also uses, but
// non-terminally (before `.limit()`).
const mockSelectDistinctOn = jest.fn();
const mockArtworkFrom = jest.fn();
const mockArtworkInnerJoin = jest.fn();
const mockArtworkWhere = jest.fn();
const mockArtworkOrderBy = jest.fn();

const artworkChain = {
  from: mockArtworkFrom,
  innerJoin: mockArtworkInnerJoin,
  where: mockArtworkWhere,
  orderBy: mockArtworkOrderBy,
};
mockSelectDistinctOn.mockReturnValue(artworkChain);
mockArtworkFrom.mockReturnValue(artworkChain);
mockArtworkInnerJoin.mockReturnValue(artworkChain);
mockArtworkWhere.mockReturnValue(artworkChain);
mockArtworkOrderBy.mockResolvedValue([]); // artwork query default: no matches

// Third chain: the BS#2103 batched metadata lookup, which shares `db.select`
// with the main entries query but terminates on `.where()`:
//   select().from(flowsheet).leftJoin(library, ...).leftJoin(album_metadata, ...).where(...)
// `mockSelect` therefore dispatches on the projection's shape — only the main
// entries query selects `entry_type`.
const mockMetadataFrom = jest.fn();
const mockMetadataLeftJoin = jest.fn();
const mockMetadataWhere = jest.fn();

const metadataChain = {
  from: mockMetadataFrom,
  leftJoin: mockMetadataLeftJoin,
  where: mockMetadataWhere,
};
mockMetadataFrom.mockReturnValue(metadataChain);
mockMetadataLeftJoin.mockReturnValue(metadataChain);
mockMetadataWhere.mockResolvedValue([]); // metadata query default: no rows

function selectDispatch(fields: unknown) {
  return fields && typeof fields === 'object' && 'entry_type' in fields ? mockDbChain : metadataChain;
}
mockSelect.mockImplementation(selectDispatch);

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    selectDistinctOn: (...args: unknown[]) => mockSelectDistinctOn(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    leftJoin: (...args: unknown[]) => mockLeftJoin(...args),
    innerJoin: (...args: unknown[]) => mockInnerJoin(...args),
    where: (...args: unknown[]) => mockWhere(...args),
    orderBy: (...args: unknown[]) => mockOrderBy(...args),
    limit: (...args: unknown[]) => mockLimit(...args),
    execute: (...args: unknown[]) => mockExecute(...args),
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
    segue: 'segue',
    message: 'message',
    rotation_id: 'rotation_id',
    album_id: 'album_id',
    metadata_status: 'metadata_status',
    // Inline metadata columns — only ever referenced inside the shared
    // COALESCE projection (`utils/album-metadata-projection.ts`), whose `sql`
    // tag is mocked below, so their values are inert here.
    discogs_url: 'flowsheet.discogs_url',
    release_year: 'flowsheet.release_year',
    spotify_url: 'flowsheet.spotify_url',
    apple_music_url: 'flowsheet.apple_music_url',
    youtube_music_url: 'flowsheet.youtube_music_url',
    bandcamp_url: 'flowsheet.bandcamp_url',
    soundcloud_url: 'flowsheet.soundcloud_url',
    artist_bio: 'flowsheet.artist_bio',
    artist_wikipedia_url: 'flowsheet.artist_wikipedia_url',
  },
  album_metadata: {
    album_id: 'album_metadata.album_id',
    artwork_url: 'album_metadata.artwork_url',
    discogs_url: 'album_metadata.discogs_url',
    release_year: 'album_metadata.release_year',
    spotify_url: 'album_metadata.spotify_url',
    apple_music_url: 'album_metadata.apple_music_url',
    youtube_music_url: 'album_metadata.youtube_music_url',
    bandcamp_url: 'album_metadata.bandcamp_url',
    soundcloud_url: 'album_metadata.soundcloud_url',
    artist_bio: 'album_metadata.artist_bio',
    artist_wikipedia_url: 'album_metadata.artist_wikipedia_url',
    genres: 'album_metadata.genres',
    styles: 'album_metadata.styles',
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
    discogs_unavailable: 'library.discogs_unavailable',
    discogs_unavailable_note: 'library.discogs_unavailable_note',
  },
  artists: {
    id: 'artists.id',
    artist_name: 'artists.artist_name',
  },
}));

jest.mock('drizzle-orm', () => ({
  sql: Object.assign(jest.fn(), { raw: jest.fn(), join: jest.fn() }),
  inArray: jest.fn(),
  isNotNull: jest.fn(),
  and: jest.fn(),
  eq: jest.fn(),
  desc: jest.fn(),
  asc: jest.fn(),
}));

// BS#2103: the v=2 grouped path reuses `/flowsheet`'s feed-assembly attaches
// for `upcoming_show` / `critic_reviews` rather than re-deriving the match
// rules. Their own behavior is covered by
// tests/unit/services/flowsheet.attachUpcomingShows.test.ts and
// flowsheet.attachCriticReviews.test.ts; here they are no-op passthroughs
// (individual tests override them to plant an enrichment), which also keeps
// the heavyweight flowsheet.service import graph out of this unit test.
type AttachTarget = {
  upcoming_show?: unknown;
  critic_reviews?: unknown;
};
const mockAttachUpcomingShows = jest.fn((entries: AttachTarget[]) => Promise.resolve(entries));
const mockAttachCriticReviews = jest.fn((entries: AttachTarget[]) => Promise.resolve(entries));
// BS#2105: must be mocked explicitly, same reason as the two attaches above —
// an unmocked `jest.fn()` returns `undefined`, not a Promise, and
// `getOnAirDJName().catch(...)` would throw synchronously on the missing
// `.catch`. Default resolves `null` (confirmed automation) in beforeEach so
// every pre-existing test in this file gets a defined, non-crashing value
// without having to know this field exists.
const mockGetOnAirDJName = jest.fn<() => Promise<string | null>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  attachUpcomingShows: (entries: AttachTarget[]) => mockAttachUpcomingShows(entries),
  attachCriticReviews: (entries: AttachTarget[]) => mockAttachCriticReviews(entries),
  getOnAirDJName: () => mockGetOnAirDJName(),
}));

// Suppress console output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import {
  getRecentEntries,
  getRecentEntriesFlat,
  lastModifiedFromTimestamps,
} from '../../../apps/backend/services/playlist-proxy.service';

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
  segue: false,
  message: null,
  // No FK rotation link and no fallback match -> not in rotation. As a
  // hand-typed track (rotation_id null, artist+album present) it IS a
  // fallback candidate, so getRecentEntries runs the batched fallback query
  // for it — which the mock resolves to no match by default.
  rotation_id: null,
  album_id: 7001,
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
  segue: true,
  message: null,
  // FK rotation hit: rotation_id set, so rotation.rotation_bin comes back from
  // the window join and this row is NOT a fallback candidate.
  rotation_id: 940,
  album_id: 8001,
  rotation_bin: 'M',
};

// Hand-typed play that matches an active rotation only through the fallback
// lane (rotation_id null, so no FK badge; the batched fallback query resolves
// it). BS#1862.
const handTypedRotationRow = {
  id: 2602251,
  entry_type: 'track',
  add_time: new Date('2026-07-28T20:50:00.000Z'),
  radio_hour: null,
  track_title: 'Call Your Name',
  artist_name: 'Chuquimamani-Condori',
  album_title: 'Edits',
  record_label: 'self-released',
  request_flag: false,
  segue: false,
  message: null,
  rotation_id: null,
  album_id: null,
  rotation_bin: null,
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
  segue: null,
  message: 'BREAKPOINT',
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
  segue: null,
  message: 'Start of Show: DJ Probe joined the set',
  rotation_bin: null,
};

const showEndRow = {
  ...showStartRow,
  id: 2602199,
  entry_type: 'show_end',
  message: 'End of Show: DJ Probe left the set',
};

// --- Tests ---

describe('playlist-proxy.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockImplementation(selectDispatch);
    mockFrom.mockReturnValue(mockDbChain);
    mockLeftJoin.mockReturnValue(mockDbChain);
    mockInnerJoin.mockReturnValue(mockDbChain);
    mockWhere.mockReturnValue(mockDbChain);
    mockOrderBy.mockReturnValue(mockDbChain);
    mockLimit.mockResolvedValue([]); // main entries query default: empty
    mockExecute.mockResolvedValue([]); // rotation fallback default: no matches
    mockSelectDistinctOn.mockReturnValue(artworkChain);
    mockArtworkFrom.mockReturnValue(artworkChain);
    mockArtworkInnerJoin.mockReturnValue(artworkChain);
    mockArtworkWhere.mockReturnValue(artworkChain);
    mockArtworkOrderBy.mockResolvedValue([]); // artwork query default: no matches
    mockMetadataFrom.mockReturnValue(metadataChain);
    mockMetadataLeftJoin.mockReturnValue(metadataChain);
    mockMetadataWhere.mockResolvedValue([]); // metadata query default: no rows
    mockAttachUpcomingShows.mockImplementation((entries) => Promise.resolve(entries));
    mockAttachCriticReviews.mockImplementation((entries) => Promise.resolve(entries));
    // BS#2105 default: confirmed automation. Tests that care about the on-air
    // state override this explicitly; everything else gets a defined,
    // non-crashing value.
    mockGetOnAirDJName.mockResolvedValue(null);
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

  describe('getRecentEntries — rotation fallback lane (BS#1862)', () => {
    // The FK join supplies rotation_bin for picker-added rotation plays in the
    // window query; the batched db.execute fallback resolves only the
    // hand-typed cohort (rotation_id NULL) post-slice. These tests exercise
    // that split and the batched-not-per-row invariant that motivated BS#1862.
    it('resolves rotation "true" for a hand-typed entry via the batched fallback query', async () => {
      mockLimit.mockResolvedValue([handTypedRotationRow]);
      mockExecute.mockResolvedValue([{ fid: handTypedRotationRow.id, rotation_bin: 'H' }]);

      const result = await getRecentEntries(50);

      const entry = result.playcuts.find((p) => p.id === handTypedRotationRow.id);
      expect(entry?.rotation).toBe('true');
    });

    it('resolves rotation "false" for a hand-typed entry the fallback query does not match', async () => {
      mockLimit.mockResolvedValue([handTypedRotationRow]);
      mockExecute.mockResolvedValue([]); // no active rotation matched

      const result = await getRecentEntries(50);

      const entry = result.playcuts.find((p) => p.id === handTypedRotationRow.id);
      expect(entry?.rotation).toBe('false');
    });

    it('prefers the FK rotation_bin without consulting the fallback for a picker-added rotation play', async () => {
      // juanaMolinaRow has rotation_id set: the window join supplies its
      // rotation_bin, so it is not an eligible fallback candidate.
      mockLimit.mockResolvedValue([juanaMolinaRow]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].rotation).toBe('true');
      // No eligible candidates -> the batched fallback query never runs.
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('runs the batched fallback query exactly once for a mix of eligible hand-typed playcuts', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, handTypedRotationRow, juanaMolinaRow]);

      await getRecentEntries(50);

      // One batched query covers every eligible candidate (jessica + hand-typed),
      // never one-query-per-row (the BS#1862 regression guard).
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('does not run the fallback query when there are no playcuts', async () => {
      mockLimit.mockResolvedValue([talksetRow, breakpointRow]);

      await getRecentEntries(50);

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('resolves only the sliced playcuts and runs the fallback once regardless of window size', async () => {
      const manyPlaycuts = Array.from({ length: 10 }, (_, i) => ({
        ...handTypedRotationRow,
        id: 5000 + i,
      }));
      mockLimit.mockResolvedValue(manyPlaycuts);
      mockExecute.mockResolvedValue([{ fid: 5000, rotation_bin: 'H' }]);

      const result = await getRecentEntries(3);

      expect(result.playcuts).toHaveLength(3);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.playcuts.find((p) => p.id === 5000)?.rotation).toBe('true');
      expect(result.playcuts.find((p) => p.id === 5001)?.rotation).toBe('false');
    });

    it('degrades to rotation "false" (rather than throwing) when the fallback query fails', async () => {
      mockLimit.mockResolvedValue([handTypedRotationRow]);
      mockExecute.mockRejectedValue(new Error('DB connection lost'));

      const result = await getRecentEntries(50);

      const entry = result.playcuts.find((p) => p.id === handTypedRotationRow.id);
      expect(entry?.rotation).toBe('false');
    });
  });

  describe('getRecentEntries — artwork enrichment', () => {
    it('enriches playcuts with artwork from DB', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockArtworkOrderBy.mockResolvedValue([
        { key: 'jessica pratt-on your own love again', artwork_url: 'https://i.discogs.com/jessica.jpg' },
      ]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/jessica.jpg');
    });

    it('omits artworkURL when there is no metadata match', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockArtworkOrderBy.mockResolvedValue([]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBeUndefined();
    });

    it('degrades to no artwork (rather than throwing) when the artwork query fails', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockArtworkOrderBy.mockRejectedValue(new Error('DB connection lost'));

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBeUndefined();
    });

    it('does not query artwork at all when there are no playcuts', async () => {
      mockLimit.mockResolvedValue([talksetRow, breakpointRow]);

      await getRecentEntries(50);

      expect(mockArtworkOrderBy).not.toHaveBeenCalled();
    });

    it('only enriches the sliced playcuts, not the full 200-row window', async () => {
      const manyPlaycuts = Array.from({ length: 10 }, (_, i) => ({
        ...jessicaPrattRow,
        id: 4000 + i,
      }));
      mockLimit.mockResolvedValue(manyPlaycuts);
      mockArtworkOrderBy.mockResolvedValue([]);

      await getRecentEntries(3);

      // inArray(flowsheetLookupKey, keys) is the first arg passed through
      // `and(...)` to `.where(...)` — drizzle-orm is mocked, so we can only
      // assert the query executed once (batched), not literally introspect
      // the key list through the mocked `and`/`inArray`.
      expect(mockArtworkOrderBy).toHaveBeenCalledTimes(1);
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

    it('imports `and`, `isNotNull`, `eq`, `desc`, and `asc` from drizzle-orm', () => {
      expect(proxySource).toMatch(/from\s+'drizzle-orm'/);
      expect(proxySource).toMatch(/\band\b/);
      expect(proxySource).toMatch(/\bisNotNull\b/);
      expect(proxySource).toMatch(/\beq\b/);
      expect(proxySource).toMatch(/\bdesc\b/);
      expect(proxySource).toMatch(/\basc\b/);
    });

    it('imports album_metadata, rotation, library, and artists alongside flowsheet from @wxyc/database', () => {
      expect(proxySource).toMatch(/from\s+'@wxyc\/database'/);
      expect(proxySource).toMatch(/\balbum_metadata\b/);
      expect(proxySource).toMatch(/\brotation\b/);
      expect(proxySource).toMatch(/\blibrary\b/);
      expect(proxySource).toMatch(/\bartists\b/);
    });

    it('the flowsheet artwork SELECT inner-joins album_metadata on album_id and filters isNotNull(album_metadata.artwork_url)', () => {
      const chains = proxySource.match(/db\s*\.\s*selectDistinctOn[\s\S]*?\.\s*orderBy\([\s\S]*?\)\s*;/g) ?? [];
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
    // Originally an `array_agg(... ORDER BY album_id ASC)[1]` preserved
    // verbatim from the pre-Phase-3 implementation (commit d0b8317d, closes
    // #1105). BS#1800 replaced the array-materializing aggregate with a
    // `DISTINCT ON` selecting the same (lowest-album_id) row directly — see
    // enrichPlaycuts' docstring in the service file for the full rationale.
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');

    const proxySource = fs.readFileSync(
      path.resolve(__dirname, '../../../apps/backend/services/playlist-proxy.service.ts'),
      'utf-8'
    );

    it('selects DISTINCT ON the lookup key, ordered by lookup key then album_id ascending, without array_agg', () => {
      const chains = proxySource.match(/db\s*\.\s*selectDistinctOn[\s\S]*?\.\s*orderBy\([\s\S]*?\)\s*;/g) ?? [];
      const batchChain = chains.find((c) => /flowsheetLookupKey/.test(c));
      expect(batchChain).toBeDefined();
      expect(batchChain).toMatch(/\.selectDistinctOn\(\s*\[\s*flowsheetLookupKey\s*\]\s*,/);
      expect(batchChain).toMatch(/\.orderBy\(\s*flowsheetLookupKey\s*,\s*asc\(\s*album_metadata\.album_id\s*\)\s*\)/);
      expect(batchChain).not.toMatch(/array_agg/);
      expect(batchChain).not.toMatch(/\.groupBy\(/);
    });

    it('behaviorally resolves the artwork the mocked tie-break query returns onto the matching playcut', async () => {
      mockLimit.mockResolvedValue([juanaMolinaRow]);
      mockArtworkOrderBy.mockResolvedValue([
        { key: 'juana molina-doga', artwork_url: 'https://i.discogs.com/lowest-album-id.jpg' },
      ]);

      const result = await getRecentEntries(50);

      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/lowest-album-id.jpg');
    });
  });

  describe('getRecentEntries — v=2 metadata enrichment (BS#2103)', () => {
    // Ground truth for every key below: the `CodingKeys` block of `Playcut` in
    // wxyc-ios-64 @ v3.2-AppStoreSubmission4
    // (Shared/Playlist/Sources/Playlist/PlaylistEntry.swift, commit 068a51e7).
    // The legacy v=1 wire is camelCase, unlike /flowsheet's snake_case, EXCEPT
    // `upcoming_show` / `critic_reviews`, which round-trip through nested Swift
    // types that carry their own snake_case Codable. A wrong name fails
    // SILENTLY — JSONDecoder drops the key and the feature just doesn't appear.
    const IOS_32_METADATA_KEYS = [
      'artworkURL',
      'discogsURL',
      'releaseYear',
      'spotifyURL',
      'appleMusicURL',
      'youtubeMusicURL',
      'bandcampURL',
      'soundcloudURL',
      'artistBio',
      'artistWikipediaURL',
      'genres',
      'styles',
      'artistId',
      'metadataStatus',
      'discogsUnavailable',
      'discogsUnavailableNote',
      'upcoming_show',
      'critic_reviews',
    ] as const;

    /** A fully-enriched metadata row, as the batched lookup returns it. */
    const fullMetadata = {
      id: jessicaPrattRow.id,
      discogs_url: 'https://www.discogs.com/release/6621186',
      release_year: 2015,
      spotify_url: 'https://open.spotify.com/album/1PDb0PDzWnLnKfSCEOWvvS',
      apple_music_url: 'https://music.apple.com/us/album/912345678',
      youtube_music_url: 'https://music.youtube.com/playlist?list=OLAK5uy_abc',
      bandcamp_url: 'https://jessicapratt.bandcamp.com/album/on-your-own-love-again',
      soundcloud_url: 'https://soundcloud.com/jessicapratt/back-baby',
      artist_bio: 'Jessica Pratt is a singer-songwriter from Los Angeles.',
      artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Jessica_Pratt_(musician)',
      genres: ['Rock'],
      styles: ['Folk', 'Psychedelic Rock'],
      artist_id: 44321,
      discogs_unavailable: false,
      discogs_unavailable_note: null,
      metadata_status: 'enriched_match',
    };

    /** An unenriched row: every metadata column NULL (no album_metadata, no inline value). */
    const emptyMetadata = {
      id: jessicaPrattRow.id,
      discogs_url: null,
      release_year: null,
      spotify_url: null,
      apple_music_url: null,
      youtube_music_url: null,
      bandcamp_url: null,
      soundcloud_url: null,
      artist_bio: null,
      artist_wikipedia_url: null,
      genres: null,
      styles: null,
      artist_id: null,
      discogs_unavailable: null,
      discogs_unavailable_note: null,
      metadata_status: 'pending',
    };

    it('emits every enrichment field under the exact iOS 3.2 camelCase key', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockArtworkOrderBy.mockResolvedValue([
        { key: 'jessica pratt-on your own love again', artwork_url: 'https://i.discogs.com/jessica.jpg' },
      ]);
      mockMetadataWhere.mockResolvedValue([fullMetadata]);
      mockAttachUpcomingShows.mockImplementation((entries) => {
        for (const entry of entries) entry.upcoming_show = { id: 991, headlining_artist: 'Jessica Pratt' };
        return Promise.resolve(entries);
      });
      mockAttachCriticReviews.mockImplementation((entries) => {
        for (const entry of entries)
          entry.critic_reviews = [{ publication: 'Pitchfork', url: 'https://p4k.example/1' }];
        return Promise.resolve(entries);
      });

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.artworkURL).toBe('https://i.discogs.com/jessica.jpg');
      expect(pc.discogsURL).toBe(fullMetadata.discogs_url);
      expect(pc.releaseYear).toBe(2015);
      expect(pc.spotifyURL).toBe(fullMetadata.spotify_url);
      expect(pc.appleMusicURL).toBe(fullMetadata.apple_music_url);
      expect(pc.youtubeMusicURL).toBe(fullMetadata.youtube_music_url);
      expect(pc.bandcampURL).toBe(fullMetadata.bandcamp_url);
      expect(pc.soundcloudURL).toBe(fullMetadata.soundcloud_url);
      expect(pc.artistBio).toBe(fullMetadata.artist_bio);
      expect(pc.artistWikipediaURL).toBe(fullMetadata.artist_wikipedia_url);
      expect(pc.genres).toEqual(['Rock']);
      expect(pc.styles).toEqual(['Folk', 'Psychedelic Rock']);
      expect(pc.artistId).toBe(44321);
      // Key camelCase, VALUE snake_case (the MetadataStatus raw value).
      expect(pc.metadataStatus).toBe('enriched_match');
      expect(pc.discogsUnavailable).toBe(false);
      // The two deliberate snake_case exceptions.
      expect(pc.upcoming_show).toEqual({ id: 991, headlining_artist: 'Jessica Pratt' });
      expect(pc.critic_reviews).toEqual([{ publication: 'Pitchfork', url: 'https://p4k.example/1' }]);
    });

    it('emits no key outside the iOS 3.2 Playcut CodingKeys set', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockArtworkOrderBy.mockResolvedValue([
        { key: 'jessica pratt-on your own love again', artwork_url: 'https://i.discogs.com/jessica.jpg' },
      ]);
      mockMetadataWhere.mockResolvedValue([{ ...fullMetadata, discogs_unavailable_note: 'promo only' }]);
      mockAttachUpcomingShows.mockImplementation((entries) => {
        for (const entry of entries) entry.upcoming_show = { id: 991 };
        return Promise.resolve(entries);
      });
      mockAttachCriticReviews.mockImplementation((entries) => {
        for (const entry of entries) entry.critic_reviews = [{ publication: 'Pitchfork' }];
        return Promise.resolve(entries);
      });

      const [pc] = (await getRecentEntries(50)).playcuts;

      // The pre-existing legacy playcut fields, plus exactly the enrichment set.
      const legacyKeys = [
        'id',
        'chronOrderID',
        'hour',
        'timeCreated',
        'songTitle',
        'artistName',
        'releaseTitle',
        'labelName',
        'rotation',
        'request',
      ];
      expect(Object.keys(pc).sort()).toEqual([...legacyKeys, ...IOS_32_METADATA_KEYS].sort());
    });

    it('omits every URL field — never emits "" — for a row with no enrichment', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([emptyMetadata]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      for (const key of [
        'artworkURL',
        'discogsURL',
        'spotifyURL',
        'appleMusicURL',
        'youtubeMusicURL',
        'bandcampURL',
        'soundcloudURL',
        'artistWikipediaURL',
      ] as const) {
        expect(pc[key]).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(pc, key)).toBe(false);
      }
      expect(pc.releaseYear).toBeUndefined();
      expect(pc.artistBio).toBeUndefined();
      expect(pc.genres).toBeUndefined();
      expect(pc.styles).toBeUndefined();
      expect(pc.artistId).toBeUndefined();
      expect(pc.discogsUnavailable).toBeUndefined();
      expect(pc.discogsUnavailableNote).toBeUndefined();
      expect(pc.upcoming_show).toBeUndefined();
      expect(pc.critic_reviews).toBeUndefined();
      // `metadata_status` is NOT NULL on the table, but the wire key is
      // conditional: with zero renderable inline fields it is withheld, so the
      // shipped 3.2 client keeps its live `/proxy/metadata/album` fallback
      // instead of short-circuiting to an empty card.
      expect(Object.prototype.hasOwnProperty.call(pc, 'metadataStatus')).toBe(false);
    });

    // On shipped iOS 3.2, `metadataStatus` is a CONTROL field, not data: a
    // terminal value makes `PlaycutDetailView.loadMetadata()` render straight
    // from the inline fields and never call `/proxy/metadata/album`
    // (v3.2-AppStoreSubmission4, PlaycutDetailView.swift:289). For a
    // terminal-but-empty row that means an empty card where today's client
    // fetches live metadata — measured at 579 of 37,054 production playcuts
    // (1.56%), reaching roughly 40% of n=50 responses. So the key is emitted
    // exactly when the payload carries >=1 of the 12 renderable inline fields
    // (the ones `Playcut.hasV2Metadata` ORs together), and withheld otherwise
    // so those rows keep today's fallback. `/flowsheet` v2 is NOT narrowed —
    // this is a legacy-endpoint-only serve rule.
    describe('conditional metadataStatus (terminal-but-empty guard)', () => {
      it('withholds a terminal status when every inline field is empty', async () => {
        mockLimit.mockResolvedValue([jessicaPrattRow]);
        // Terminal in the DB, but nothing usable: LML finished and persisted
        // nothing. Without the guard this renders an empty detail card on 3.2.
        // `artist_id` present on purpose — it is excluded from the predicate
        // (mirroring its exclusion from iOS `hasV2Metadata`), so it must
        // neither satisfy it nor get suppressed by it.
        mockMetadataWhere.mockResolvedValue([
          { ...emptyMetadata, metadata_status: 'enriched_match', artist_id: 44321 },
        ]);

        const [pc] = (await getRecentEntries(50)).playcuts;

        expect(Object.prototype.hasOwnProperty.call(pc, 'metadataStatus')).toBe(false);
        expect(pc.artistId).toBe(44321);
      });

      it('withholds a terminal status when the only persisted values were guarded off the wire', async () => {
        mockLimit.mockResolvedValue([jessicaPrattRow]);
        // Every field is present in the DB but hazardous: the URL guard drops
        // them all, so the WIRE carries nothing renderable. The predicate must
        // read the post-guard payload, not the DB row — status rides only when
        // something actually shipped.
        mockMetadataWhere.mockResolvedValue([
          {
            ...emptyMetadata,
            metadata_status: 'enriched_match',
            discogs_url: 'Wiki - https://en.wikipedia.org/wiki/Weezer',
            artist_wikipedia_url: '   ',
            artist_bio: '   ',
            genres: [null],
          },
        ]);

        const [pc] = (await getRecentEntries(50)).playcuts;

        expect(Object.prototype.hasOwnProperty.call(pc, 'metadataStatus')).toBe(false);
        expect(pc.discogsURL).toBeUndefined();
        expect(pc.genres).toBeUndefined();
      });

      it('emits a terminal status when artwork alone survives (set before applyPlaycutMetadata)', async () => {
        mockLimit.mockResolvedValue([jessicaPrattRow]);
        mockArtworkOrderBy.mockResolvedValue([
          { key: 'jessica pratt-on your own love again', artwork_url: 'https://i.discogs.com/jessica.jpg' },
        ]);
        mockMetadataWhere.mockResolvedValue([{ ...emptyMetadata, metadata_status: 'enriched_match' }]);

        const [pc] = (await getRecentEntries(50)).playcuts;

        // artworkURL is assigned by the caller BEFORE applyPlaycutMetadata
        // runs; the predicate reads `grouped`, so artwork-only rows count as
        // renderable and keep the inline short-circuit.
        expect(pc.artworkURL).toBe('https://i.discogs.com/jessica.jpg');
        expect(pc.metadataStatus).toBe('enriched_match');
      });

      it('emits a non-terminal status whenever any inline field rides', async () => {
        mockLimit.mockResolvedValue([jessicaPrattRow]);
        // `pending` + a field is harmless on 3.2 (non-terminal statuses take
        // the same fetch arm as nil) — the rule stays uniform anyway: the key
        // accompanies renderable metadata, full stop.
        mockMetadataWhere.mockResolvedValue([{ ...emptyMetadata, metadata_status: 'pending', release_year: 2015 }]);

        const [pc] = (await getRecentEntries(50)).playcuts;

        expect(pc.releaseYear).toBe(2015);
        expect(pc.metadataStatus).toBe('pending');
      });
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['relative path', '/release/12345'],
      ['bare hostname', 'www.discogs.com/release/12345'],
      ['scheme-relative', '//www.discogs.com/release/12345'],
      ['non-web scheme', 'javascript:alert(1)'],
      // Parser differentials: `new URL()` validates a DIFFERENT string than the
      // one the serializer emits, because it folds `\` to `/` for the http(s)
      // special schemes and strips raw tab/LF/CR before parsing. The emitted
      // bytes keep those characters, and Foundation neither folds nor strips —
      // so the host `new URL()` blessed is not the host iOS would resolve.
      ['backslash host confusion', 'https://www.discogs.com\\@evil.example/release/1'],
      ['embedded tab', 'https://www.discogs.com/rele\tase/12345'],
      ['embedded newline', 'https://www.discogs.com/rele\nase/12345'],
      ['embedded carriage return', 'https://www.discogs.com/rele\rase/12345'],
      ['embedded space', 'https://www.discogs.com/rele ase/12345'],
      ['embedded NUL', 'https://www.discogs.com/rele\u0000ase/12345'],
    ])(
      'drops a %s discogs URL rather than emitting it (iOS decodeIfPresent(URL.self) THROWS and blanks the whole playlist)',
      async (_label, value) => {
        mockLimit.mockResolvedValue([jessicaPrattRow]);
        mockMetadataWhere.mockResolvedValue([{ ...emptyMetadata, discogs_url: value }]);

        const [pc] = (await getRecentEntries(50)).playcuts;

        expect(pc.discogsURL).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(pc, 'discogsURL')).toBe(false);
      }
    );

    it('suppresses a persisted spotify_url/apple_music_url whose host is wrong (BS#1714 regression guard)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([
        {
          ...fullMetadata,
          // Mislabeled at the LML boundary before #1712 — a Bandcamp URL filed
          // under spotify_url, a YouTube URL filed under apple_music_url.
          spotify_url: 'https://jessicapratt.bandcamp.com/album/on-your-own-love-again',
          apple_music_url: 'https://music.youtube.com/watch?v=abc',
        },
      ]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.spotifyURL).toBeUndefined();
      expect(pc.appleMusicURL).toBeUndefined();
      // The un-mislabeled siblings are untouched.
      expect(pc.bandcampURL).toBe(fullMetadata.bandcamp_url);
      expect(pc.youtubeMusicURL).toBe(fullMetadata.youtube_music_url);
    });

    it('keeps a correctly-hosted spotify_url/apple_music_url', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([fullMetadata]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.spotifyURL).toBe(fullMetadata.spotify_url);
      expect(pc.appleMusicURL).toBe(fullMetadata.apple_music_url);
    });

    it('collapses empty genres/styles arrays to an omitted key (mirrors transformToV2, BS#1441)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([{ ...emptyMetadata, genres: [], styles: [] }]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.genres).toBeUndefined();
      expect(pc.styles).toBeUndefined();
    });

    // `album_metadata.genres` / `.styles` are nullable `text[]` — the ELEMENTS
    // can be NULL, so a row written with one comes back as `[null]`, whose
    // `.length` is truthy. iOS 3.2 decodes both with a THROWING
    // `decodeIfPresent([String].self)`, so shipping `[null]` fails the whole
    // Playcut decode and blanks the playlist — the same catastrophe wireUrl
    // exists to prevent, on the last throwing decode that had no guard.
    it.each([
      ['a null member', [null], undefined],
      ['only null members', [null, null], undefined],
      ['an empty-string member', [''], undefined],
      ['a whitespace-only member', ['   '], undefined],
      ['a mix of good and null members', ['Rock', null, '', 'Jazz'], ['Rock', 'Jazz']],
      ['padded members', ['  Rock  '], ['Rock']],
    ])('handles genres/styles with %s', async (_label, value, expected) => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([{ ...emptyMetadata, genres: value, styles: value }]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.genres).toEqual(expected);
      expect(pc.styles).toEqual(expected);
      if (expected === undefined) {
        expect(Object.prototype.hasOwnProperty.call(pc, 'genres')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(pc, 'styles')).toBe(false);
      }
    });

    // The string fields are normalized on the same rule as the URL fields: a
    // '   ' bio is not a bio, and '' is not a note. Emitting either renders an
    // empty, unexplained section on the shipped 3.2 UI.
    it.each([
      ['whitespace-only', '   '],
      ['empty', ''],
    ])('drops a %s artist_bio and discogs_unavailable_note rather than emitting it', async (_label, value) => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([{ ...emptyMetadata, artist_bio: value, discogs_unavailable_note: value }]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(Object.prototype.hasOwnProperty.call(pc, 'artistBio')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(pc, 'discogsUnavailableNote')).toBe(false);
    });

    it('trims a padded artist_bio / discogs_unavailable_note, matching the URL fields', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([
        {
          ...emptyMetadata,
          artist_bio: '  Jessica Pratt is a singer-songwriter from Los Angeles.  ',
          discogs_unavailable_note: '  embargoed promo\n',
        },
      ]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.artistBio).toBe('Jessica Pratt is a singer-songwriter from Los Angeles.');
      expect(pc.discogsUnavailableNote).toBe('embargoed promo');
    });

    it('omits discogsUnavailable entirely for a row with no library link (BS#1908 present-or-absent)', async () => {
      mockLimit.mockResolvedValue([handTypedRotationRow]);
      mockMetadataWhere.mockResolvedValue([
        { ...emptyMetadata, id: handTypedRotationRow.id, discogs_unavailable: null, discogs_unavailable_note: null },
      ]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(Object.prototype.hasOwnProperty.call(pc, 'discogsUnavailable')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(pc, 'discogsUnavailableNote')).toBe(false);
    });

    it('emits discogsUnavailable/Note when the library row carries the flag', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([
        { ...emptyMetadata, discogs_unavailable: true, discogs_unavailable_note: 'embargoed promo' },
      ]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.discogsUnavailable).toBe(true);
      expect(pc.discogsUnavailableNote).toBe('embargoed promo');
    });

    it('survives a diacritic-bearing artist byte-for-byte, enrichment included', async () => {
      // Nilüfer Yanya, from wxyc-shared/src/test-utils/wxyc-example-data.json.
      const niluferRow = {
        ...jessicaPrattRow,
        id: 2602261,
        track_title: 'Midnight Sun',
        artist_name: 'Nilüfer Yanya',
        album_title: 'PAINLESS',
        record_label: 'ATO Records',
      };
      mockLimit.mockResolvedValue([niluferRow]);
      mockMetadataWhere.mockResolvedValue([
        {
          ...emptyMetadata,
          id: niluferRow.id,
          artist_bio: 'Nilüfer Yanya is a London-born singer-songwriter.',
          genres: ['Rock'],
          discogs_url: 'https://www.discogs.com/release/22012345',
        },
      ]);

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.artistName).toBe('Nilüfer Yanya');
      expect(pc.artistBio).toBe('Nilüfer Yanya is a London-born singer-songwriter.');
      expect(pc.discogsURL).toBe('https://www.discogs.com/release/22012345');
      // JSON.stringify is the actual serialization path; assert it round-trips.
      expect(JSON.parse(JSON.stringify(pc)).artistBio).toBe('Nilüfer Yanya is a London-born singer-songwriter.');
    });

    it('runs exactly ONE batched metadata query for the whole page (no N+1)', async () => {
      const manyPlaycuts = Array.from({ length: 10 }, (_, i) => ({ ...jessicaPrattRow, id: 4100 + i }));
      mockLimit.mockResolvedValue(manyPlaycuts);

      await getRecentEntries(10);

      expect(mockMetadataWhere).toHaveBeenCalledTimes(1);
      expect(mockAttachUpcomingShows).toHaveBeenCalledTimes(1);
      expect(mockAttachCriticReviews).toHaveBeenCalledTimes(1);
    });

    // `attachCriticReviews` reads only `entry_type` and `album_id`, and
    // `album_id` is already on the window row — unlike `attachUpcomingShows`,
    // whose id arm needs the `artist_id` the metadata batch resolves. So it
    // belongs in the first wave. This endpoint is polled on a fixed interval
    // behind a 2s fail-soft proxy that 503s the whole legacy mobile fleet on
    // timeout, so an unnecessary serial hop is not free.
    it('dispatches the critic-review attach in the first wave, not behind the metadata batch', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      let releaseMetadata: (rows: unknown) => void = () => {};
      mockMetadataWhere.mockReturnValue(
        new Promise((resolve) => {
          releaseMetadata = resolve;
        })
      );

      const pending = getRecentEntries(50);
      await new Promise((resolve) => setImmediate(resolve));

      // Metadata is still in flight...
      expect(mockAttachCriticReviews).toHaveBeenCalledTimes(1);
      expect(mockAttachUpcomingShows).not.toHaveBeenCalled();

      releaseMetadata([fullMetadata]);
      await pending;

      expect(mockAttachUpcomingShows).toHaveBeenCalledTimes(1);
    });

    it('enriches only the sliced playcuts, not the full 200-row window', async () => {
      const manyPlaycuts = Array.from({ length: 10 }, (_, i) => ({ ...jessicaPrattRow, id: 4200 + i }));
      mockLimit.mockResolvedValue(manyPlaycuts);

      await getRecentEntries(3);

      const [targets] = mockAttachUpcomingShows.mock.calls[0];
      expect(targets).toHaveLength(3);
    });

    it('does not query metadata at all when there are no playcuts', async () => {
      mockLimit.mockResolvedValue([talksetRow, breakpointRow]);

      await getRecentEntries(50);

      expect(mockMetadataWhere).not.toHaveBeenCalled();
      expect(mockAttachUpcomingShows).not.toHaveBeenCalled();
      expect(mockAttachCriticReviews).not.toHaveBeenCalled();
    });

    it('degrades to the bare legacy playcut (rather than throwing) when the metadata query fails', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockRejectedValue(new Error('DB connection lost'));

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.songTitle).toBe('Back, Baby');
      expect(pc.discogsURL).toBeUndefined();
      expect(pc.metadataStatus).toBeUndefined();
    });

    it('degrades (rather than throwing) when the upcoming-show attach fails, and keeps critic_reviews', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([fullMetadata]);
      mockAttachUpcomingShows.mockRejectedValue(new Error('concerts unavailable'));
      mockAttachCriticReviews.mockImplementation((entries) => {
        for (const entry of entries) entry.critic_reviews = [{ publication: 'Pitchfork' }];
        return Promise.resolve(entries);
      });

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.upcoming_show).toBeUndefined();
      // ONLY the feature that failed degrades: the critic reviews the other
      // attach already produced must not be discarded with it, and the rest of
      // the enrichment still rides.
      expect(pc.critic_reviews).toEqual([{ publication: 'Pitchfork' }]);
      expect(pc.discogsURL).toBe(fullMetadata.discogs_url);
    });

    it('degrades (rather than throwing) when the critic-review attach fails, and keeps upcoming_show', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([fullMetadata]);
      mockAttachCriticReviews.mockRejectedValue(new Error('album_critic_reviews unavailable'));
      mockAttachUpcomingShows.mockImplementation((entries) => {
        for (const entry of entries) entry.upcoming_show = { id: 991 };
        return Promise.resolve(entries);
      });

      const [pc] = (await getRecentEntries(50)).playcuts;

      expect(pc.critic_reviews).toBeUndefined();
      expect(pc.upcoming_show).toEqual({ id: 991 });
      expect(pc.discogsURL).toBe(fullMetadata.discogs_url);
    });

    it('leaves the v=1 flat payload untouched — no metadata query, no enrichment keys (Android contract)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockMetadataWhere.mockResolvedValue([fullMetadata]);

      const [entry] = await getRecentEntriesFlat(50);

      expect(mockMetadataWhere).not.toHaveBeenCalled();
      expect(mockAttachUpcomingShows).not.toHaveBeenCalled();
      expect(mockAttachCriticReviews).not.toHaveBeenCalled();
      expect(Object.keys(entry).sort()).toEqual(['chronOrderID', 'entryType', 'hour', 'id', 'playcut', 'timeCreated']);
      expect(Object.keys(entry.playcut ?? {}).sort()).toEqual([
        'artistName',
        'labelName',
        'releaseTitle',
        'request',
        'rotation',
        'segue',
        'songTitle',
      ]);
    });
  });

  // BS#2105: on-air status as a top-level `onAir` sibling of `playcuts`, so a
  // 3.2 client on the legacy v=1 path renders the on-air banner. `onAir`'s
  // wire shape is not `/flowsheet`'s `{dj_name}` — it is whatever Swift's
  // SYNTHESIZED Codable produces for the shipped `enum OnAir { case
  // dj(String); case automation; case unknown }`, which is why the encoder is
  // a dedicated `WireOnAir` union + `encodeOnAir` helper rather than a literal
  // object built inline.
  describe('getRecentEntries — on-air status (BS#2105)', () => {
    it('emits {dj:{_0:name}} when a human DJ is on air', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGetOnAirDJName.mockResolvedValue('bill b');

      const result = await getRecentEntries(50);

      expect(result.onAir).toEqual({ dj: { _0: 'bill b' } });
    });

    it('emits {automation:{}} when getOnAirDJName resolves null (confirmed automation)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGetOnAirDJName.mockResolvedValue(null);

      const result = await getRecentEntries(50);

      expect(result.onAir).toEqual({ automation: {} });
    });

    it('omits the onAir key entirely — never {"unknown":{}} — when getOnAirDJName rejects', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, talksetRow, breakpointRow]);
      mockGetOnAirDJName.mockRejectedValue(new Error('DB connection reset'));

      const result = await getRecentEntries(50);

      expect(Object.prototype.hasOwnProperty.call(result, 'onAir')).toBe(false);
    });

    // The highest-risk slip the issue calls out: getRecentEntries has no
    // internal try/catch, and any rejection propagates to
    // playlist.controller.ts, which 503s the ENTIRE legacy mobile fleet. A
    // rejecting getOnAirDJName must cost only the banner (previous test),
    // never turn into a 503 for everyone else's playlist.
    it('still resolves (never rejects) with a full playlist when getOnAirDJName rejects', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, talksetRow, breakpointRow]);
      mockGetOnAirDJName.mockRejectedValue(new Error('DB connection reset'));

      await expect(getRecentEntries(50)).resolves.toEqual(
        expect.objectContaining({
          playcuts: expect.arrayContaining([expect.objectContaining({ artistName: 'Jessica Pratt' })]),
          talksets: expect.arrayContaining([expect.objectContaining({ id: talksetRow.id })]),
          breakpoints: expect.arrayContaining([expect.objectContaining({ id: breakpointRow.id })]),
        })
      );
    });

    it('places onAir as the LAST key in the envelope (wire-visible insertion order)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGetOnAirDJName.mockResolvedValue('bill b');

      const result = await getRecentEntries(50);

      expect(Object.keys(result)).toEqual(['playcuts', 'talksets', 'breakpoints', 'onAir']);
    });

    it('resolves getOnAirDJName concurrently with the window query, before the metadata batch', async () => {
      const callOrder: string[] = [];
      mockLimit.mockImplementation(() => {
        callOrder.push('rows');
        return Promise.resolve([jessicaPrattRow]);
      });
      mockMetadataWhere.mockImplementation(() => {
        callOrder.push('metadata');
        return Promise.resolve([]);
      });
      mockGetOnAirDJName.mockImplementation(() => {
        callOrder.push('onair');
        return Promise.resolve('bill b');
      });

      await getRecentEntries(50);

      // getOnAirDJName is invoked in the SAME wave as fetchRecentRows — not
      // parked behind it in the existing enrichment Promise.all, which would
      // make its two sequential queries that wave's critical path.
      expect(callOrder[0]).toBe('rows');
      expect(callOrder[1]).toBe('onair');
      expect(callOrder.indexOf('onair')).toBeLessThan(callOrder.indexOf('metadata'));
    });

    it('does not call getOnAirDJName or emit onAir on the v=1 flat path (Android contract)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);
      mockGetOnAirDJName.mockResolvedValue('bill b');

      const [entry] = await getRecentEntriesFlat(50);

      expect(mockGetOnAirDJName).not.toHaveBeenCalled();
      expect(Object.prototype.hasOwnProperty.call(entry, 'onAir')).toBe(false);
    });
  });

  describe('getRecentEntriesFlat — v=1 flat wire format (BS#1866)', () => {
    it('returns a flat array, not the grouped object', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, talksetRow]);

      const result = await getRecentEntriesFlat(50);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('serializes a track as a playcut entry with a nested playcut object', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const [entry] = await getRecentEntriesFlat(50);

      expect(entry).toMatchObject({
        id: jessicaPrattRow.id,
        chronOrderID: jessicaPrattRow.id,
        entryType: 'playcut',
        timeCreated: jessicaPrattRow.add_time.getTime(),
      });
      expect(entry.playcut).toEqual({
        artistName: 'Jessica Pratt',
        songTitle: 'Back, Baby',
        releaseTitle: 'On Your Own Love Again',
        labelName: 'Drag City',
        rotation: 'false',
        request: 'false',
        segue: 'false',
      });
    });

    it('INCLUDES show_start/show_end as showDelimiter entries (unlike v=2 grouped)', async () => {
      mockLimit.mockResolvedValue([showStartRow, jessicaPrattRow, showEndRow]);

      const result = await getRecentEntriesFlat(50);

      const delimiters = result.filter((e) => e.entryType === 'showDelimiter');
      expect(delimiters.map((d) => d.id)).toEqual([showStartRow.id, showEndRow.id]);
      // showDelimiter carries the marker message as artistName (consumer-invisible).
      expect(delimiters[0].artistName).toBe('Start of Show: DJ Probe joined the set');
      expect(delimiters[1].artistName).toBe('End of Show: DJ Probe left the set');
      expect(delimiters[0].playcut).toBeUndefined();
    });

    it('maps breakpoint to entryType "breakpoint" with the uppercased message as artistName', async () => {
      mockLimit.mockResolvedValue([breakpointRow]);

      const [entry] = await getRecentEntriesFlat(50);

      expect(entry.entryType).toBe('breakpoint');
      expect(entry.artistName).toBe('BREAKPOINT');
      // breakpoint hour uses radio_hour verbatim (shared with v=2).
      expect(entry.hour).toBe(breakpointRow.radio_hour.getTime());
    });

    it('maps talkset/dj_join/dj_leave/message to entryType "talkset"', async () => {
      mockLimit.mockResolvedValue([talksetRow, djJoinRow, djLeaveRow, messageRow]);

      const result = await getRecentEntriesFlat(50);

      expect(result.every((e) => e.entryType === 'talkset')).toBe(true);
      expect(result.every((e) => e.playcut === undefined && e.artistName === undefined)).toBe(true);
    });

    it('emits segue as a "true"/"false" string in the nested playcut', async () => {
      mockLimit.mockResolvedValue([juanaMolinaRow, jessicaPrattRow]);

      const result = await getRecentEntriesFlat(50);

      const juana = result.find((e) => e.playcut?.artistName === 'Juana Molina');
      const jessica = result.find((e) => e.playcut?.artistName === 'Jessica Pratt');
      expect(juana?.playcut?.segue).toBe('true');
      expect(jessica?.playcut?.segue).toBe('false');
    });

    it('resolves the rotation fallback for a hand-typed playcut', async () => {
      mockLimit.mockResolvedValue([handTypedRotationRow]);
      mockExecute.mockResolvedValue([{ fid: handTypedRotationRow.id, rotation_bin: 'H' }]);

      const [entry] = await getRecentEntriesFlat(50);

      expect(entry.playcut?.rotation).toBe('true');
    });

    it('does not enrich artwork (v=1 carries none)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow]);

      const [entry] = await getRecentEntriesFlat(50);

      expect('artworkURL' in entry).toBe(false);
      expect(entry.playcut).not.toHaveProperty('imageURL');
      expect(mockArtworkOrderBy).not.toHaveBeenCalled();
    });

    it('bounds the window to n TOTAL entries (min(n, 200)), not n playcuts', async () => {
      await getRecentEntriesFlat(35);
      expect(mockLimit).toHaveBeenCalledWith(35);

      await getRecentEntriesFlat(500);
      expect(mockLimit).toHaveBeenCalledWith(200);
    });

    it('carries the base fields on every entry type', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, talksetRow, breakpointRow, showStartRow]);

      const result = await getRecentEntriesFlat(50);

      for (const e of result) {
        expect(typeof e.id).toBe('number');
        expect(typeof e.chronOrderID).toBe('number');
        expect(typeof e.hour).toBe('number');
        expect(typeof e.timeCreated).toBe('number');
        expect(typeof e.entryType).toBe('string');
      }
    });
  });

  describe('X-Last-Modified (lastModifiedFromTimestamps)', () => {
    it('returns the max timestamp of the window', () => {
      expect(lastModifiedFromTimestamps([100, 500, 300])).toBe(500);
    });

    it('returns 0 for an empty window', () => {
      expect(lastModifiedFromTimestamps([])).toBe(0);
    });
  });

  describe('client-contract parity (BS#1866)', () => {
    // A diacritic-bearing name (from wxyc-shared/test-utils) exercises the iOS
    // repairingMojibake() no-op path: the emitted bytes must be clean UTF-8.
    const niluferRow = {
      ...jessicaPrattRow,
      id: 2602260,
      track_title: 'Midnight Sun',
      artist_name: 'Nilüfer Yanya',
      album_title: 'PAINLESS',
      record_label: 'ATO Records',
    };

    it('v=1 flat playcut matches the Android PlaylistResponseDto shape', async () => {
      mockLimit.mockResolvedValue([niluferRow]);

      const [entry] = await getRecentEntriesFlat(50);

      // PlaylistResponseDto: id:Int, entryType:String, playcut:?, hour:Long, chronOrderID:Int
      expect(Number.isInteger(entry.id)).toBe(true);
      expect(typeof entry.entryType).toBe('string');
      expect(Number.isInteger(entry.hour)).toBe(true);
      expect(Number.isInteger(entry.chronOrderID)).toBe(true);
      // PlayCutDetailsDto: rotation/request/songTitle/labelName/artistName/releaseTitle (all String)
      const pc = entry.playcut;
      expect(pc).toBeDefined();
      for (const key of ['rotation', 'request', 'songTitle', 'labelName', 'artistName', 'releaseTitle'] as const) {
        expect(typeof pc?.[key]).toBe('string');
      }
      // Diacritic preserved byte-for-byte (no mojibake).
      expect(pc?.artistName).toBe('Nilüfer Yanya');
    });

    it('v=1 flat marker entries deserialize cleanly (Android renders by entryType)', async () => {
      mockLimit.mockResolvedValue([talksetRow, breakpointRow, showStartRow]);

      const result = await getRecentEntriesFlat(50);

      for (const e of result) {
        expect(['talkset', 'breakpoint', 'showDelimiter']).toContain(e.entryType);
        expect(e.playcut).toBeUndefined();
      }
    });

    it('v=2 grouped playcut matches the iOS Playcut decoder shape', async () => {
      mockLimit.mockResolvedValue([niluferRow]);

      const result = await getRecentEntries(50);
      const pc = result.playcuts[0];

      // iOS Playcut: id/hour/chronOrderID/timeCreated (UInt64), songTitle/artistName (String),
      // rotation decoded as Bool-or-String (here the "true"/"false" string).
      expect(Number.isInteger(pc.id)).toBe(true);
      expect(Number.isInteger(pc.hour)).toBe(true);
      expect(Number.isInteger(pc.chronOrderID)).toBe(true);
      expect(Number.isInteger(pc.timeCreated)).toBe(true);
      expect(typeof pc.songTitle).toBe('string');
      expect(typeof pc.artistName).toBe('string');
      expect(typeof pc.rotation).toBe('string');
      expect(pc.artistName).toBe('Nilüfer Yanya');
    });

    it('v=2 grouped exposes the iOS Playlist keys (playcuts/talksets/breakpoints)', async () => {
      mockLimit.mockResolvedValue([jessicaPrattRow, talksetRow, breakpointRow]);

      const result = await getRecentEntries(50);

      expect(result).toHaveProperty('playcuts');
      expect(result).toHaveProperty('talksets');
      expect(result).toHaveProperty('breakpoints');
      // iOS reads showMarkers/onAir via decodeIfPresent — their absence is tolerated.
    });
  });
});
