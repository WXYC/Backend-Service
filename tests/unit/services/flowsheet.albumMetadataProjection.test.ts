// BS#897 — Epic D / D1. The V2 read path must LEFT JOIN album_metadata
// keyed by flowsheet.album_id = album_metadata.album_id so the projection
// can COALESCE the 10 metadata columns (artwork_url, discogs_url,
// release_year, spotify_url, apple_music_url, youtube_music_url,
// bandcamp_url, soundcloud_url, artist_bio, artist_wikipedia_url) from
// album_metadata over flowsheet. D1 only ships the schema + read-path
// projection — the inline columns stay populated until D4.

import { jest } from '@jest/globals';
import { db, flowsheet, album_metadata } from '@wxyc/database';
import {
  getEntriesByPage,
  getEntriesByRange,
  getEntriesByShow,
} from '../../../apps/backend/services/flowsheet.service';

type LeftJoinCall = { table: unknown; on: unknown };

const METADATA_COLUMNS = [
  'artwork_url',
  'discogs_url',
  'release_year',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'bandcamp_url',
  'soundcloud_url',
  'artist_bio',
  'artist_wikipedia_url',
] as const;

interface MockCapture {
  fieldsArg: unknown;
  leftJoinCalls: LeftJoinCall[];
}

function installRecursiveSelectMock(): MockCapture {
  const capture: MockCapture = { fieldsArg: undefined, leftJoinCalls: [] };

  const makeChain = () => {
    const c: Record<string, jest.Mock> = {};
    c.leftJoin = jest.fn().mockImplementation((table: unknown, on: unknown) => {
      capture.leftJoinCalls.push({ table, on });
      return c;
    });
    c.where = jest.fn().mockReturnValue(c);
    c.orderBy = jest.fn().mockReturnValue(c);
    c.offset = jest.fn().mockReturnValue(c);
    c.limit = jest.fn().mockResolvedValue([] as never);
    // Drizzle terminal methods that may be awaited directly
    c.then = jest.fn().mockImplementation((onFulfilled: (v: unknown) => unknown) => {
      return Promise.resolve([]).then(onFulfilled);
    });
    return c;
  };

  (db as unknown as { select: jest.Mock }).select = jest.fn().mockImplementation((fields: unknown) => {
    capture.fieldsArg = fields;
    const chain = makeChain();
    const from = jest.fn().mockReturnValue(chain);
    return { from };
  });

  return capture;
}

function expectMetadataColumnsAreCoalesceExpressions(fields: unknown): void {
  expect(fields).toBeDefined();
  const f = fields as Record<string, unknown>;
  for (const col of METADATA_COLUMNS) {
    // Once COALESCE is in place, each field should NOT be the raw flowsheet
    // column ref — it should be a Drizzle sql object built via the template
    // literal. We assert non-identity with the bare column ref; that's the
    // smallest test that exercises "the field changed shape".
    expect(f[col]).toBeDefined();
    expect(f[col]).not.toBe((flowsheet as unknown as Record<string, unknown>)[col]);
  }
}

describe('flowsheet.service — album_metadata projection (BS#897)', () => {
  let capture: MockCapture;

  beforeEach(() => {
    capture = installRecursiveSelectMock();
  });

  describe('getEntriesByPage', () => {
    it('LEFT JOINs album_metadata', async () => {
      await getEntriesByPage(0, 10);

      const joinedTables = capture.leftJoinCalls.map((c) => c.table);
      expect(joinedTables).toContain(album_metadata);
    });

    it('projects the 10 metadata columns as COALESCE expressions, not raw flowsheet columns', async () => {
      await getEntriesByPage(0, 10);

      expectMetadataColumnsAreCoalesceExpressions(capture.fieldsArg);
    });
  });

  describe('getEntriesByRange', () => {
    it('LEFT JOINs album_metadata', async () => {
      await getEntriesByRange(1, 10);

      const joinedTables = capture.leftJoinCalls.map((c) => c.table);
      expect(joinedTables).toContain(album_metadata);
    });

    it('projects the 10 metadata columns as COALESCE expressions, not raw flowsheet columns', async () => {
      await getEntriesByRange(1, 10);

      expectMetadataColumnsAreCoalesceExpressions(capture.fieldsArg);
    });
  });

  describe('getEntriesByShow', () => {
    it('LEFT JOINs album_metadata', async () => {
      await getEntriesByShow(1);

      const joinedTables = capture.leftJoinCalls.map((c) => c.table);
      expect(joinedTables).toContain(album_metadata);
    });

    it('projects the 10 metadata columns as COALESCE expressions, not raw flowsheet columns', async () => {
      await getEntriesByShow(1);

      expectMetadataColumnsAreCoalesceExpressions(capture.fieldsArg);
    });
  });
});
