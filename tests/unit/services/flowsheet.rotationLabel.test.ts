/**
 * BS#2505 — `rotation_label`, the rotation release's CANONICAL label, resolved
 * `flowsheet.rotation_id -> rotation.label_id -> labels.label_name`.
 *
 * Why it exists: the weekly airplay report names each ranked line from the
 * FIRST rotation-linked flowsheet entry of the week, and that entry's
 * `record_label` is free text a DJ typed mid-show. 2.5% of rotation releases
 * carry more than one label spelling across their weekly plays, so one variant
 * or one wrong early entry names the whole chart line. Sourcing from the linked
 * release removes the spelling contest at the root.
 *
 * Three layers are pinned here:
 *   1. the SQL projection — the field is the raw `labels.label_name` column ref,
 *      and EVERY `FSEntryFieldsRaw` read path joins `labels` on
 *      `rotation.label_id` (the field lives on the shared select object, so a
 *      site that skipped the join would render invalid SQL, not a null);
 *   2. `transformToIFSEntry` — the raw row reaches `IFSEntry` unmodified;
 *   3. `transformToV2` — the track wire carries it, and `record_label` is
 *      untouched beside it.
 *
 * The harness mirrors `flowsheet.discogsUnavailable.test.ts`'s
 * `installRecursiveSelectMock`, which is itself modelled on
 * `flowsheet.albumMetadataProjection.test.ts`.
 */

import { jest } from '@jest/globals';
import { db, rotation, labels } from '@wxyc/database';
import { eq } from 'drizzle-orm';
import {
  getEntriesByPage,
  getEntriesByRange,
  getEntriesByShow,
  getEntriesInTimeWindow,
  transformToIFSEntry,
  transformToV2,
  type FSEntryRaw,
} from '../../../apps/backend/services/flowsheet.service';
import { IFSEntry, IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';

type LeftJoinCall = { table: unknown; on: unknown };

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
    c.innerJoin = jest.fn().mockReturnValue(c);
    c.where = jest.fn().mockReturnValue(c);
    c.orderBy = jest.fn().mockReturnValue(c);
    c.offset = jest.fn().mockReturnValue(c);
    c.limit = jest.fn().mockReturnValue(c);
    c.as = jest.fn().mockReturnValue({ id: 'mock-page-id' });
    c.then = jest.fn().mockImplementation((onFulfilled: (v: unknown) => unknown) => {
      return Promise.resolve([]).then(onFulfilled);
    });
    return c;
  };

  (db as unknown as { select: jest.Mock }).select = jest.fn().mockImplementation((fields: unknown) => {
    capture.fieldsArg = fields;
    const chain = makeChain();
    return { from: jest.fn().mockReturnValue(chain) };
  });

  return capture;
}

describe('rotation_label — SQL projection (BS#2505)', () => {
  let capture: MockCapture;

  beforeEach(() => {
    capture = installRecursiveSelectMock();
  });

  /**
   * All FOUR `.select(FSEntryFieldsRaw)` sites, not just the range read the
   * ticket names. They share one select object, so the join is not optional at
   * any of them — a site that resolved the label and a site that did not would
   * be a Postgres error, not a silent null.
   */
  describe.each([
    ['getEntriesByPage', () => getEntriesByPage(0, 10)],
    ['getEntriesByRange', () => getEntriesByRange(1, 10)],
    ['getEntriesByShow', () => getEntriesByShow(1)],
    [
      'getEntriesInTimeWindow',
      () => getEntriesInTimeWindow(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-08T00:00:00Z')),
    ],
  ] as const)('%s', (_name, run) => {
    it('projects rotation_label as the raw labels.label_name column ref', async () => {
      await run();

      const fields = capture.fieldsArg as Record<string, unknown>;
      expect(fields.rotation_label).toBe(labels.label_name);
    });

    it('LEFT JOINs labels on rotation.label_id', async () => {
      await run();

      const labelsJoin = capture.leftJoinCalls.find((c) => c.table === labels);
      expect(labelsJoin).toBeDefined();
      expect(labelsJoin?.on).toEqual(eq(labels.id, rotation.label_id));
    });

    it('joins labels AFTER rotation, which its predicate depends on', async () => {
      await run();

      const tables = capture.leftJoinCalls.map((c) => c.table);
      expect(tables.indexOf(rotation)).toBeGreaterThanOrEqual(0);
      expect(tables.indexOf(labels)).toBeGreaterThan(tables.indexOf(rotation));
    });

    /**
     * The join is deliberately unwindowed, matching the `rotation` join it
     * hangs off (BS#2183): a KILLED release with plays in the window still
     * resolves its label. `GET /library/rotation` serves active rows only; this
     * read is a historical report and must not inherit that filter.
     */
    it('adds no kill_date or add_date predicate of its own', async () => {
      await run();

      const labelsJoin = capture.leftJoinCalls.find((c) => c.table === labels);
      expect(JSON.stringify(labelsJoin?.on)).not.toMatch(/kill_date|add_date/);
    });
  });
});

const makeRaw = (overrides: Partial<FSEntryRaw> = {}): FSEntryRaw => ({
  id: 1,
  show_id: 1,
  album_id: null,
  entry_type: 'track',
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  track_position: null,
  record_label: 'sonamos',
  rotation_label: null,
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
  add_time: new Date('2026-09-15T00:00:00.000Z'),
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

describe('rotation_label — transformToIFSEntry (BS#2505)', () => {
  it('carries the resolved label through unmodified', () => {
    const entry = transformToIFSEntry(makeRaw({ rotation_label: "People's Potential Unlimited" }));

    expect(entry.rotation_label).toBe("People's Potential Unlimited");
  });

  it('is null when the release has no label_id, or no rotation link at all', () => {
    expect(transformToIFSEntry(makeRaw({ rotation_label: null })).rotation_label).toBeNull();
  });

  /**
   * The free-text snapshot is untouched — it stays the fallback the consumer
   * uses everywhere `rotation_label` is null, which is every row until BS#2412
   * backfills `rotation.label_id`.
   */
  it('leaves record_label exactly as it found it', () => {
    const entry = transformToIFSEntry(makeRaw({ record_label: 'sonamos', rotation_label: 'Sonamos' }));

    expect(entry.record_label).toBe('sonamos');
    expect(entry.rotation_label).toBe('Sonamos');
  });
});

const makeEntry = (overrides: Partial<IFSEntry> = {}): IFSEntry => ({
  ...transformToIFSEntry(makeRaw()),
  metadata: {} as IFSEntryMetadata,
  ...overrides,
});

describe('rotation_label — transformToV2 (BS#2505)', () => {
  it('emits rotation_label alongside an unchanged record_label on a track entry', () => {
    const v2 = transformToV2(
      makeEntry({ entry_type: 'track', record_label: 'MCA Nashville', rotation_label: "People's Potential Unlimited" })
    );

    expect(v2.rotation_label).toBe("People's Potential Unlimited");
    expect(v2.record_label).toBe('MCA Nashville');
  });

  /**
   * Present-and-null, not absent. The contract declares the field nullable
   * rather than optional, and a consumer choosing between the two labels needs
   * to distinguish "no linked label" from "field not in this response".
   */
  it('emits an explicit null rather than omitting the key', () => {
    const v2 = transformToV2(makeEntry({ entry_type: 'track', rotation_label: null }));

    expect(v2).toHaveProperty('rotation_label');
    expect(v2.rotation_label).toBeNull();
  });

  it('does not put a label on a marker entry, which has no release', () => {
    const v2 = transformToV2(makeEntry({ entry_type: 'show_start', rotation_label: 'Drag City' }));

    expect(v2).not.toHaveProperty('rotation_label');
  });
});
