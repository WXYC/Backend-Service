/**
 * Unit tests for the playlist proxy service.
 *
 * Tests SSE event parsing, in-memory store management, and artwork
 * enrichment from album_metadata (joined via flowsheet.album_id). The
 * EventSource connection is mocked; only the pure logic is exercised here.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

// Mock the database module
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockInnerJoin = jest.fn();
const mockWhere = jest.fn();
const mockGroupBy = jest.fn();
const mockLimit = jest.fn();

const mockDbChain = {
  select: mockSelect,
  from: mockFrom,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  groupBy: mockGroupBy,
  limit: mockLimit,
};
mockSelect.mockReturnValue(mockDbChain);
mockFrom.mockReturnValue(mockDbChain);
mockInnerJoin.mockReturnValue(mockDbChain);
mockWhere.mockReturnValue(mockDbChain);
mockGroupBy.mockResolvedValue([]);
mockLimit.mockResolvedValue([]);

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    innerJoin: (...args: unknown[]) => mockInnerJoin(...args),
    where: (...args: unknown[]) => mockWhere(...args),
    groupBy: (...args: unknown[]) => mockGroupBy(...args),
    limit: (...args: unknown[]) => mockLimit(...args),
  },
  flowsheet: {
    artist_name: 'artist_name',
    album_title: 'album_title',
    artwork_url: 'artwork_url',
    album_id: 'album_id',
  },
  album_metadata: {
    album_id: 'album_metadata.album_id',
    artwork_url: 'album_metadata.artwork_url',
  },
}));

jest.mock('drizzle-orm', () => ({
  sql: Object.assign(jest.fn(), { raw: jest.fn() }),
  inArray: jest.fn(),
  isNotNull: jest.fn(),
  and: jest.fn(),
  eq: jest.fn(),
}));

// Mock EventSource — we do not want to open real SSE connections in tests.
// The service file imports EventSource as a default import.
const mockEventSourceInstance = {
  addEventListener: jest.fn(),
  close: jest.fn(),
  readyState: 1,
};

jest.mock('eventsource', () => ({
  __esModule: true,
  default: jest.fn(() => mockEventSourceInstance),
  EventSource: jest.fn(() => mockEventSourceInstance),
}));

// Suppress console output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import {
  processInitEvent,
  processCreatedEvent,
  processDeletedEvent,
  processUpdatedEvent,
  getRecentEntries,
  isConnected,
  resetState,
} from '../../../apps/backend/services/playlist-proxy.service';

// --- Fixtures: representative WXYC data ---

const ninaSimoneEntry = {
  id: 2602249,
  chronOrderID: 171606010,
  hour: 1775080800000,
  timeCreated: 1775082908948,
  entryType: 'playcut' as const,
  playcut: {
    songTitle: 'I Shall Be Released',
    artistName: 'Nina Simone',
    releaseTitle: 'Best of',
    labelName: 'BMG',
    request: 'false',
    rotation: 'false',
  },
};

const juanaMolinaEntry = {
  id: 2602250,
  chronOrderID: 171606011,
  hour: 1775080800000,
  timeCreated: 1775082999000,
  entryType: 'playcut' as const,
  playcut: {
    songTitle: 'la paradoja',
    artistName: 'Juana Molina',
    releaseTitle: 'DOGA',
    labelName: 'Sonamos',
    request: 'false',
    rotation: 'false',
  },
};

const talksetEntry = {
  id: 2602247,
  chronOrderID: 171606008,
  hour: 1775080800000,
  timeCreated: 1775082820391,
  entryType: 'talkset' as const,
};

const breakpointEntry = {
  id: 2602238,
  chronOrderID: 171605047,
  hour: 1775077200000,
  timeCreated: 1775076979166,
  entryType: 'breakpoint' as const,
};

const showDelimiterEntry = {
  id: 2602200,
  chronOrderID: 171605000,
  hour: 1775073600000,
  timeCreated: 1775073600000,
  entryType: 'showDelimiter' as const,
};

// --- Tests ---

describe('playlist-proxy.service', () => {
  beforeEach(() => {
    resetState();
    jest.clearAllMocks();
    // Reset the db chain mocks
    mockSelect.mockReturnValue(mockDbChain);
    mockFrom.mockReturnValue(mockDbChain);
    mockInnerJoin.mockReturnValue(mockDbChain);
    mockWhere.mockReturnValue(mockDbChain);
    mockGroupBy.mockResolvedValue([]); // batch enrichment default
    mockLimit.mockResolvedValue([]); // single enrichment default
  });

  describe('isConnected', () => {
    it('returns false before init event is processed', () => {
      expect(isConnected()).toBe(false);
    });

    it('returns true after init event is processed', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry, talksetEntry, breakpointEntry]));
      expect(isConnected()).toBe(true);
    });
  });

  describe('processInitEvent', () => {
    it('parses init event into grouped response', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry, talksetEntry, breakpointEntry]));

      const result = getRecentEntries(50);
      expect(result.playcuts).toHaveLength(1);
      expect(result.talksets).toHaveLength(1);
      expect(result.breakpoints).toHaveLength(1);
    });

    it('flattens playcut nested object to top level', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));

      const result = getRecentEntries(50);
      const playcut = result.playcuts[0];
      expect(playcut.songTitle).toBe('I Shall Be Released');
      expect(playcut.artistName).toBe('Nina Simone');
      expect(playcut.releaseTitle).toBe('Best of');
      expect(playcut.labelName).toBe('BMG');
      expect(playcut.request).toBe('false');
      expect(playcut.rotation).toBe('false');
    });

    it('preserves base fields on playcuts', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));

      const result = getRecentEntries(50);
      const playcut = result.playcuts[0];
      expect(playcut.id).toBe(2602249);
      expect(playcut.chronOrderID).toBe(171606010);
      expect(playcut.hour).toBe(1775080800000);
      expect(playcut.timeCreated).toBe(1775082908948);
    });

    it('preserves talkset fields unchanged', async () => {
      await processInitEvent(JSON.stringify([talksetEntry]));

      const result = getRecentEntries(50);
      expect(result.talksets[0]).toEqual({
        id: 2602247,
        chronOrderID: 171606008,
        hour: 1775080800000,
        timeCreated: 1775082820391,
      });
    });

    it('preserves breakpoint fields unchanged', async () => {
      await processInitEvent(JSON.stringify([breakpointEntry]));

      const result = getRecentEntries(50);
      expect(result.breakpoints[0]).toEqual({
        id: 2602238,
        chronOrderID: 171605047,
        hour: 1775077200000,
        timeCreated: 1775076979166,
      });
    });

    it('omits showDelimiter entries', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry, showDelimiterEntry, talksetEntry, breakpointEntry]));

      const result = getRecentEntries(50);
      expect(result.playcuts).toHaveLength(1);
      expect(result.talksets).toHaveLength(1);
      expect(result.breakpoints).toHaveLength(1);
    });

    it('enriches playcuts with artwork from DB', async () => {
      mockGroupBy.mockResolvedValue([{ key: 'nina simone-best of', artwork_url: 'https://i.discogs.com/nina.jpg' }]);

      await processInitEvent(JSON.stringify([ninaSimoneEntry]));

      const result = getRecentEntries(50);
      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/nina.jpg');
    });

    it('handles entries with no metadata match (artworkURL omitted)', async () => {
      mockGroupBy.mockResolvedValue([]);

      await processInitEvent(JSON.stringify([ninaSimoneEntry]));

      const result = getRecentEntries(50);
      expect(result.playcuts[0].artworkURL).toBeUndefined();
    });

    it('preserves existing artwork when DB fails on re-init', async () => {
      // First init succeeds with artwork
      mockGroupBy.mockResolvedValue([{ key: 'nina simone-best of', artwork_url: 'https://i.discogs.com/nina.jpg' }]);
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));
      expect(getRecentEntries(50).playcuts[0].artworkURL).toBe('https://i.discogs.com/nina.jpg');

      // Second init: DB fails — existing artwork should be preserved
      mockGroupBy.mockRejectedValue(new Error('DB connection lost'));
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));

      const result = getRecentEntries(50);
      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/nina.jpg');
    });
  });

  describe('processCreatedEvent', () => {
    it('adds a new playcut entry', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry, talksetEntry]));
      await processCreatedEvent(JSON.stringify(juanaMolinaEntry));

      const result = getRecentEntries(50);
      expect(result.playcuts).toHaveLength(2);
      expect(result.playcuts.some((p) => p.artistName === 'Juana Molina')).toBe(true);
    });

    it('adds a new talkset entry', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));
      const newTalkset = { ...talksetEntry, id: 9999, chronOrderID: 999999 };
      await processCreatedEvent(JSON.stringify(newTalkset));

      const result = getRecentEntries(50);
      expect(result.talksets).toHaveLength(1);
      expect(result.talksets[0].id).toBe(9999);
    });

    it('caps entries at MAX_ENTRIES (200) and trims oldest', async () => {
      // Init with 200 entries (at capacity)
      const initEntries = Array.from({ length: 200 }, (_, i) => ({
        ...ninaSimoneEntry,
        id: 1000 + i,
        chronOrderID: 100000 + i,
        timeCreated: 1775082908948 + i,
      }));
      await processInitEvent(JSON.stringify(initEntries));

      // Add one more — should trim the oldest
      const newEntry = { ...juanaMolinaEntry, id: 9999, chronOrderID: 999999 };
      await processCreatedEvent(JSON.stringify(newEntry));

      const result = getRecentEntries(200);
      expect(result.playcuts).toHaveLength(200);
      // Newest should be first
      expect(result.playcuts[0].artistName).toBe('Juana Molina');
      // Last entry from init array (id: 1199) should have been trimmed
      expect(result.playcuts.some((p) => p.id === 1199)).toBe(false);
    });

    it('enriches newly created playcuts with artwork', async () => {
      await processInitEvent(JSON.stringify([talksetEntry]));

      mockLimit.mockResolvedValue([{ artwork_url: 'https://i.discogs.com/juana.jpg' }]);

      await processCreatedEvent(JSON.stringify(juanaMolinaEntry));

      const result = getRecentEntries(50);
      const juana = result.playcuts.find((p) => p.artistName === 'Juana Molina');
      expect(juana?.artworkURL).toBe('https://i.discogs.com/juana.jpg');
    });
  });

  describe('processDeletedEvent', () => {
    it('removes an entry by id', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry, talksetEntry, breakpointEntry]));
      processDeletedEvent(JSON.stringify({ id: ninaSimoneEntry.id }));

      const result = getRecentEntries(50);
      expect(result.playcuts).toHaveLength(0);
      expect(result.talksets).toHaveLength(1);
      expect(result.breakpoints).toHaveLength(1);
    });

    it('removes a talkset entry by id', async () => {
      await processInitEvent(JSON.stringify([talksetEntry, breakpointEntry]));
      processDeletedEvent(JSON.stringify({ id: talksetEntry.id }));

      const result = getRecentEntries(50);
      expect(result.talksets).toHaveLength(0);
    });

    it('handles deletion of non-existent entry gracefully', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));
      processDeletedEvent(JSON.stringify({ id: 99999 }));

      const result = getRecentEntries(50);
      expect(result.playcuts).toHaveLength(1);
    });
  });

  describe('processUpdatedEvent', () => {
    it('replaces an existing entry', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry, talksetEntry]));

      const updatedEntry = {
        ...ninaSimoneEntry,
        playcut: {
          ...ninaSimoneEntry.playcut,
          songTitle: 'Feeling Good',
        },
      };

      await processUpdatedEvent(JSON.stringify(updatedEntry));

      const result = getRecentEntries(50);
      expect(result.playcuts).toHaveLength(1);
      expect(result.playcuts[0].songTitle).toBe('Feeling Good');
    });

    it('enriches updated playcuts with artwork', async () => {
      await processInitEvent(JSON.stringify([ninaSimoneEntry]));

      mockLimit.mockResolvedValue([{ artwork_url: 'https://i.discogs.com/updated.jpg' }]);

      await processUpdatedEvent(JSON.stringify(ninaSimoneEntry));

      const result = getRecentEntries(50);
      expect(result.playcuts[0].artworkURL).toBe('https://i.discogs.com/updated.jpg');
    });
  });

  describe('getRecentEntries', () => {
    it('slices results to n', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        ...ninaSimoneEntry,
        id: 1000 + i,
        chronOrderID: 100000 + i,
        timeCreated: 1775082908948 + i,
      }));

      await processInitEvent(JSON.stringify(entries));

      const result = getRecentEntries(3);
      expect(result.playcuts).toHaveLength(3);
    });

    it('returns empty groups when not connected', () => {
      const result = getRecentEntries(50);
      expect(result.playcuts).toEqual([]);
      expect(result.talksets).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });
  });

  describe('artwork query: partial-index alignment (regression for #511, BS#1012)', () => {
    // The post-D5 partial functional index `flowsheet_album_link_lookup_idx`
    // (migration 0081) only covers rows where `album_id IS NOT NULL`. The
    // playlist-proxy queries an INNER JOIN of flowsheet ⨝ album_metadata,
    // which drops `flowsheet.album_id IS NULL` rows naturally and therefore
    // matches the partial-index predicate so the lookup_key probe is an
    // index scan instead of a 2.6M-row seq scan (incident #511).
    //
    // Source-grep over the deployed file is the right shape because the
    // bug class is a *missing* clause in the SQL builder. A behavioural test
    // wouldn't catch a future regression where someone adds a new query
    // path without the join + filter; the source-grep does.
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');

    const proxySource = fs.readFileSync(
      path.resolve(__dirname, '../../../apps/backend/services/playlist-proxy.service.ts'),
      'utf-8'
    );

    it('imports `and`, `isNotNull`, and `eq` from drizzle-orm', () => {
      expect(proxySource).toMatch(/from\s+'drizzle-orm'/);
      expect(proxySource).toMatch(/\band\b/);
      expect(proxySource).toMatch(/\bisNotNull\b/);
      expect(proxySource).toMatch(/\beq\b/);
    });

    it('imports album_metadata alongside flowsheet from @wxyc/database', () => {
      expect(proxySource).toMatch(/from\s+'@wxyc\/database'/);
      expect(proxySource).toMatch(/\balbum_metadata\b/);
    });

    it('every flowsheet artwork SELECT inner-joins album_metadata on album_id and filters isNotNull(album_metadata.artwork_url)', () => {
      // Find every WHERE that targets the flowsheetLookupKey-on-flowsheet
      // pattern. Each must be paired with an `.innerJoin(album_metadata, ...)`
      // upstream in the same chain and combined with
      // `isNotNull(album_metadata.artwork_url)` so the partial index fires.
      // Two call sites exist today (enrichPlaycuts, enrichSinglePlaycut); any
      // future addition should match the same shape.
      const chains = proxySource.match(/db\s*\.\s*select[\s\S]*?\.\s*(?:groupBy|limit)\([\s\S]*?\)\s*;/g) ?? [];
      const artworkChains = chains.filter((c) => /flowsheetLookupKey/.test(c));
      expect(artworkChains.length).toBeGreaterThanOrEqual(2);
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
});
