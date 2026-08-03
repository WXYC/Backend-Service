/**
 * Unit tests for BS#1908 (Not-on-Discogs epic #1280): emitting the MD-set
 * `discogsUnavailable` / `discogsUnavailableNote` flag on the V2
 * flowsheet-entry album embed, mirroring the BS#1895 read surfaces
 * (library-search.service.ts, library.service.ts's LIBRARY_VIEW_PROJECTION,
 * proxy.controller.ts) and matching the already-published wxyc-shared@3.2.0
 * contract (`FlowsheetEntryResponse.discogsUnavailable` — boolean, NOT
 * required; `discogsUnavailableNote` — nullable string).
 *
 * Three layers, matching `flowsheet.albumMetadataProjection.test.ts` (SQL
 * shape) and `flowsheet.transformToV2.metadata-status.test.ts` (wire shape):
 *
 *   1. SQL projection: `discogs_unavailable`/`discogs_unavailable_note` ride
 *      the SAME `library` LEFT JOIN every V2 read path already performs
 *      (getEntriesByPage/getEntriesByRange/getEntriesByShow) — a single
 *      `db.select(...)` per query, not a per-row lookup. This is the "no
 *      N+1" acceptance criterion: the flag data is read as raw `library.*`
 *      column refs alongside `on_streaming`, not via a second query.
 *   2. `transformToIFSEntry`: raw SQL row -> IFSEntry, preserving the
 *      three-way null/true/false distinction off the joined `library` row.
 *   3. `transformToV2`: IFSEntry -> V2 wire shape, camelCased
 *      (`withDiscogsUnavailableCamelCase` convention) and present-or-absent
 *      (never `null`/`false` for a non-library row — the field is omitted
 *      entirely, matching `upcoming_show`/`critic_reviews`).
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts (see
 * jest.unit.config.ts), so layer 1 pins the query SHAPE without PostgreSQL.
 */

import { jest } from '@jest/globals';
import { db, library } from '@wxyc/database';
import {
  getEntriesByPage,
  getEntriesByRange,
  getEntriesByShow,
  transformToIFSEntry,
  transformToV2,
  type FSEntryRaw,
} from '../../../apps/backend/services/flowsheet.service';
import { IFSEntry, IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';

// ---------------------------------------------------------------------------
// Layer 1: SQL projection shape (no N+1)
// ---------------------------------------------------------------------------

type LeftJoinCall = { table: unknown; on: unknown };

interface MockCapture {
  fieldsArg: unknown;
  leftJoinCalls: LeftJoinCall[];
  selectCallCount: number;
}

// Mirrors flowsheet.albumMetadataProjection.test.ts's installRecursiveSelectMock.
function installRecursiveSelectMock(): MockCapture {
  const capture: MockCapture = { fieldsArg: undefined, leftJoinCalls: [], selectCallCount: 0 };

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
    c.then = jest.fn().mockImplementation((onFulfilled: (v: unknown) => unknown) => {
      return Promise.resolve([]).then(onFulfilled);
    });
    return c;
  };

  (db as unknown as { select: jest.Mock }).select = jest.fn().mockImplementation((fields: unknown) => {
    capture.fieldsArg = fields;
    capture.selectCallCount += 1;
    const chain = makeChain();
    const from = jest.fn().mockReturnValue(chain);
    return { from };
  });

  return capture;
}

describe('flowsheet.service — discogs-unavailable SQL projection (BS#1908)', () => {
  let capture: MockCapture;

  beforeEach(() => {
    capture = installRecursiveSelectMock();
  });

  describe.each([
    ['getEntriesByPage', () => getEntriesByPage(0, 10)],
    ['getEntriesByRange', () => getEntriesByRange(1, 10)],
    ['getEntriesByShow', () => getEntriesByShow(1)],
  ] as const)('%s', (_name, run) => {
    it('projects discogs_unavailable/discogs_unavailable_note as raw library column refs', async () => {
      await run();

      const fields = capture.fieldsArg as Record<string, unknown>;
      expect(fields.discogs_unavailable).toBe(library.discogs_unavailable);
      expect(fields.discogs_unavailable_note).toBe(library.discogs_unavailable_note);
    });

    it('LEFT JOINs library (the same join the flag rides, no new join added)', async () => {
      await run();

      const joinedTables = capture.leftJoinCalls.map((c) => c.table);
      expect(joinedTables).toContain(library);
      // Still exactly 3 leftJoins (rotation, library, album_metadata) — the
      // flag didn't add a 4th join or a second query.
      expect(capture.leftJoinCalls).toHaveLength(3);
    });

    it('issues exactly one db.select call regardless of page size (no N+1)', async () => {
      await run();

      expect(capture.selectCallCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 2: transformToIFSEntry (raw SQL row -> IFSEntry)
// ---------------------------------------------------------------------------

const makeRaw = (overrides: Partial<FSEntryRaw> = {}): FSEntryRaw => ({
  id: 1,
  show_id: 100,
  album_id: 501,
  entry_type: 'track',
  artist_name: 'Chuquimamani-Condori',
  album_title: 'Edits',
  track_title: 'Call Your Name',
  track_position: null,
  record_label: 'self-released',
  label_id: null,
  rotation_id: null,
  rotation_bin: null,
  artist_id: null,
  request_flag: false,
  segue: false,
  message: null,
  play_order: 1,
  legacy_entry_id: null,
  legacy_release_id: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  dj_name: null,
  linkage_source: null,
  linkage_confidence: null,
  linked_at: null,
  artwork_url: null,
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
  on_streaming: null,
  discogs_unavailable: null,
  discogs_unavailable_note: null,
  metadata_status: 'enriched_match',
  enriching_since: null,
  radio_hour: null,
  ...overrides,
});

describe('transformToIFSEntry discogs-unavailable mapping (BS#1908)', () => {
  it('passes a SET flag + note through unchanged', () => {
    const entry = transformToIFSEntry(
      makeRaw({ discogs_unavailable: true, discogs_unavailable_note: 'Embargoed promo pressing' })
    );

    expect(entry.discogs_unavailable).toBe(true);
    expect(entry.discogs_unavailable_note).toBe('Embargoed promo pressing');
  });

  it('passes an UNSET flag (false, not omitted) through unchanged', () => {
    const entry = transformToIFSEntry(makeRaw({ discogs_unavailable: false, discogs_unavailable_note: null }));

    expect(entry.discogs_unavailable).toBe(false);
    expect(entry.discogs_unavailable_note).toBeNull();
  });

  it('passes a NULL flag through (no library row / LEFT JOIN miss)', () => {
    const entry = transformToIFSEntry(makeRaw({ discogs_unavailable: null, discogs_unavailable_note: null }));

    expect(entry.discogs_unavailable).toBeNull();
    expect(entry.discogs_unavailable_note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 3: transformToV2 (IFSEntry -> V2 wire shape)
// ---------------------------------------------------------------------------

const nullMetadata: IFSEntryMetadata = {
  artwork_url: null,
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
};

const createTrackEntry = (overrides: Partial<IFSEntry> = {}): IFSEntry => ({
  id: 1,
  show_id: 100,
  album_id: 501,
  rotation_id: null,
  entry_type: 'track',
  track_title: 'Call Your Name',
  track_position: null,
  album_title: 'Edits',
  artist_name: 'Chuquimamani-Condori',
  record_label: 'self-released',
  label_id: null,
  play_order: 1,
  request_flag: false,
  segue: false,
  message: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  dj_name: null,
  rotation_bin: null,
  on_streaming: null,
  legacy_entry_id: null,
  legacy_release_id: null,
  linkage_source: null,
  linkage_confidence: null,
  linked_at: null,
  metadata_status: 'enriched_match',
  enriching_since: null,
  radio_hour: null,
  metadata: nullMetadata,
  artist_id: null,
  discogs_unavailable: null,
  discogs_unavailable_note: null,
  ...overrides,
});

describe('transformToV2 discogs-unavailable projection (BS#1908)', () => {
  it('library-linked entry with the flag SET: emits discogsUnavailable: true + its note', () => {
    const entry = createTrackEntry({
      discogs_unavailable: true,
      discogs_unavailable_note: 'Embargoed promo pressing',
    });

    const result = transformToV2(entry);

    expect(result.discogsUnavailable).toBe(true);
    expect(result.discogsUnavailableNote).toBe('Embargoed promo pressing');
  });

  it('library-linked entry with the flag UNSET: emits discogsUnavailable: false (present, not omitted)', () => {
    const entry = createTrackEntry({ discogs_unavailable: false, discogs_unavailable_note: null });

    const result = transformToV2(entry);

    expect(result).toHaveProperty('discogsUnavailable', false);
    expect(result).not.toHaveProperty('discogsUnavailableNote');
  });

  it('non-library row (no album_id / no matching library row): omits discogsUnavailable entirely', () => {
    const entry = createTrackEntry({
      album_id: null,
      discogs_unavailable: null,
      discogs_unavailable_note: null,
    });

    const result = transformToV2(entry);

    expect(result).not.toHaveProperty('discogsUnavailable');
    expect(result).not.toHaveProperty('discogsUnavailableNote');
    // Never null or false — genuinely absent from the JSON, matching the
    // published contract (boolean-when-present, NOT required).
    expect(Object.prototype.hasOwnProperty.call(result, 'discogsUnavailable')).toBe(false);
  });

  it('non-track entry types never carry discogsUnavailable (matches artwork_url/discogs_url siblings)', () => {
    const entry = createTrackEntry({
      entry_type: 'show_start',
      discogs_unavailable: true,
      discogs_unavailable_note: 'should not leak',
    });

    const result = transformToV2(entry);

    expect(result).not.toHaveProperty('discogsUnavailable');
    expect(result).not.toHaveProperty('discogsUnavailableNote');
  });
});
