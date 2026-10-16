// BS#897 — Epic D / D1. The V2 read path must LEFT JOIN album_metadata
// keyed by flowsheet.album_id = album_metadata.album_id so the projection
// can COALESCE the 10 metadata columns (artwork_url, discogs_url,
// release_year, spotify_url, apple_music_url, youtube_music_url,
// bandcamp_url, soundcloud_url, artist_bio, artist_wikipedia_url) from
// album_metadata over flowsheet. D1 only ships the schema + read-path
// projection — the inline columns stay populated until D4.

import { flowsheet, album_metadata } from '@wxyc/database';
import {
  getEntriesByPage,
  getEntriesByRange,
  getEntriesByShow,
} from '../../../apps/backend/services/flowsheet.service';
import {
  installRecursiveSelectMock,
  type RecursiveSelectMockCapture as MockCapture,
} from '../../utils/recursive-select-mock';

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
