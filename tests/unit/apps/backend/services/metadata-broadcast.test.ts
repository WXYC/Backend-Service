/**
 * Unit tests for metadata-broadcast filter (BS#892 / Epic C C2, PR-2).
 *
 * Pins the perimeter: only flowsheet UPDATE events with a terminal
 * metadata_status (`enriched_match` | `enriched_no_match` |
 * `failed_no_retry`) produce a broadcast. INSERTs (handled separately by
 * the worker's CDC consumer), DELETEs, and intermediate-state UPDATEs
 * (`pending` ← C6 sweep, `enriching` ← claim) are skipped.
 *
 * False positives would amplify SSE traffic; false negatives would leave
 * dj-site without the post-enrichment refresh signal that closes #893/#628.
 */

import type { CdcEvent } from '@wxyc/database';
import { INTERNAL_FLOWSHEET_COLUMNS, makeFullFlowsheetRow } from '../../../../fixtures/flowsheet-row.fixture';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

jest.mock('../../../../../apps/backend/utils/serverEvents.js', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { update: 'update', insert: 'insert' },
  serverEventsMgr: { broadcast: jest.fn() },
}));

jest.mock('@wxyc/database', () => ({
  onCdcEvent: jest.fn(),
}));

// BS#1962: the SSE feeder's discogs-unavailable enrichment is a thin guard
// around this cache module (LRU + in-flight coalescing tested on its own in
// discogs-unavailable-cache.test.ts). Mocking it here isolates these tests to
// the broadcast-handler plumbing: the album_id guard, the additive-failure
// try/catch, and same-row insert/update ordering over a shared promise.
const mockGetCachedDiscogsUnavailableFlags = jest.fn<() => Promise<unknown>>();
const mockInvalidateDiscogsUnavailableFlags = jest.fn();
jest.mock('../../../../../apps/backend/services/metadata-broadcast/discogs-unavailable-cache.js', () => ({
  getCachedDiscogsUnavailableFlags: mockGetCachedDiscogsUnavailableFlags,
  invalidateDiscogsUnavailableFlags: mockInvalidateDiscogsUnavailableFlags,
}));

// BS#2131 review follow-up: the insert handler's suppression metric.
const mockRecordInsertSuppressed = jest.fn();
jest.mock('../../../../../apps/backend/services/sse/sse-metrics.js', () => ({
  recordInsertSuppressed: mockRecordInsertSuppressed,
}));

import * as Sentry from '@sentry/node';
import {
  filterMetadataUpdate,
  filterMetadataInsert,
  isAgeSuppressedInsert,
  setupMetadataBroadcast,
  resolveLiveFsInsertMaxAgeMs,
  __resetLiveFsInsertMaxAgeWarnLatchForTests,
} from '../../../../../apps/backend/services/metadata-broadcast/metadata-broadcast';
import { onCdcEvent } from '@wxyc/database';
import { serverEventsMgr } from '../../../../../apps/backend/utils/serverEvents.js';

/** Flushes pending microtasks (the cache-await + Object.assign + broadcast chain). */
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// File-wide: the warn-once latch inside resolveLiveFsInsertMaxAgeMs is
// module-level state (deliberately, to bound log volume during a real bulk
// import — see the source's docstring). Reset it after every test so a
// warn-count assertion in one describe block can't be silently starved by
// an earlier test that happened to warm the latch with the same raw value.
afterEach(() => {
  __resetLiveFsInsertMaxAgeWarnLatchForTests();
});

/**
 * Fixed reference instant shared by every fixture's `CdcEvent.timestamp`
 * (BS#2131 review follow-up: filterMetadataInsert reads the age-guard "now"
 * from the event's own timestamp, not `Date.now()` — see
 * `resolveEventNowMs`'s doc in the source file).
 */
const NOW = 1779856000000;

const flowsheetUpdate = (overrides: Partial<Record<string, unknown>> = {}): CdcEvent => ({
  table: 'flowsheet',
  schema: 'wxyc_schema',
  action: 'UPDATE',
  data: {
    id: 42,
    metadata_status: 'enriched_match',
    ...overrides,
  },
  timestamp: NOW,
});

describe('filterMetadataUpdate (BS#892 PR-2)', () => {
  // Pre-BS-2 payload was `{id, metadata_status}` — dj-site's listener
  // middleware would patch only those two fields and rely on the rest
  // already being in the local cache. BS-2 inlined the row so newly-mounted
  // clients (a /live viewer that just opened the page) can surface
  // metadata-enriched fields like `artwork_url` without a follow-up GET.
  // BS#1534 projects that row through the CLIENT_FACING_FLOWSHEET_COLUMNS
  // allow-list before it hits the anonymous SSE stream: the payload stays
  // rich enough to cache-patch (the `LiveFsUpdateEvent` contract), but the
  // internal columns (search_doc, composer, legacy_*, linkage_*, …) that the
  // raw CDC `to_jsonb(NEW)` row carried no longer ride the public broadcast.

  it('projects the client-facing row as the payload, dropping internal columns (BS#1534)', () => {
    const event = flowsheetUpdate({
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
      record_label: 'Sonamos',
      artwork_url: 'https://example.com/doga.jpg',
      // Internal columns present on the raw CDC row — must be stripped.
      search_doc: "'juana':1A",
      composer: 'Juana Molina',
      legacy_entry_id: 9999,
    });
    expect(filterMetadataUpdate(event)).toEqual({
      id: 42,
      metadata_status: 'enriched_match',
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
      record_label: 'Sonamos',
      artwork_url: 'https://example.com/doga.jpg',
    });
  });

  it('strips every internal column and keeps every client column from a full CDC row (BS#1534)', () => {
    // The shared leak fixture carries all 12 internal columns truthy alongside
    // the client set — same fixture the mutation/peek leak suites use, so a new
    // internal column is covered here from the one update site.
    const payload = filterMetadataUpdate(flowsheetUpdate(makeFullFlowsheetRow()));
    expect(payload).not.toBeNull();
    for (const internalKey of INTERNAL_FLOWSHEET_COLUMNS) {
      expect(payload).not.toHaveProperty(internalKey);
    }
    // A representative slice of client-facing columns survives, including the
    // enrichment fields the SSE consumer exists to receive.
    expect(payload).toMatchObject({
      id: 42,
      metadata_status: 'enriched_match',
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      artwork_url: 'https://example.com/art.jpg',
      release_year: 2022,
    });
  });

  it('still returns payload for an enriched_match UPDATE (id + status guaranteed)', () => {
    const payload = filterMetadataUpdate(flowsheetUpdate());
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({ id: 42, metadata_status: 'enriched_match' });
  });

  it('still returns payload for an enriched_no_match UPDATE', () => {
    const payload = filterMetadataUpdate(flowsheetUpdate({ metadata_status: 'enriched_no_match' }));
    expect(payload).toMatchObject({ id: 42, metadata_status: 'enriched_no_match' });
  });

  it('still returns payload for a failed_no_retry UPDATE', () => {
    const payload = filterMetadataUpdate(flowsheetUpdate({ metadata_status: 'failed_no_retry' }));
    expect(payload).toMatchObject({ id: 42, metadata_status: 'failed_no_retry' });
  });

  it('skips UPDATE to enriching (claim-time, not user-visible)', () => {
    expect(filterMetadataUpdate(flowsheetUpdate({ metadata_status: 'enriching' }))).toBeNull();
  });

  it('skips UPDATE to pending (C6 stranded-claim sweep — not user-visible)', () => {
    expect(filterMetadataUpdate(flowsheetUpdate({ metadata_status: 'pending' }))).toBeNull();
  });

  it("skips INSERT events (those are the worker's input, not its output)", () => {
    expect(filterMetadataUpdate({ ...flowsheetUpdate(), action: 'INSERT' })).toBeNull();
  });

  it('skips DELETE events', () => {
    expect(filterMetadataUpdate({ ...flowsheetUpdate(), action: 'DELETE' })).toBeNull();
  });

  it('skips events for tables other than flowsheet', () => {
    expect(filterMetadataUpdate({ ...flowsheetUpdate(), table: 'library' })).toBeNull();
  });

  it('skips when data is missing', () => {
    expect(filterMetadataUpdate({ ...flowsheetUpdate(), data: null })).toBeNull();
  });

  it('skips when id is missing or not a number', () => {
    expect(filterMetadataUpdate(flowsheetUpdate({ id: undefined }))).toBeNull();
    expect(filterMetadataUpdate(flowsheetUpdate({ id: 'forty-two' }))).toBeNull();
  });

  it('skips when metadata_status is missing', () => {
    expect(filterMetadataUpdate(flowsheetUpdate({ metadata_status: undefined }))).toBeNull();
  });

  it('skips when metadata_status is some other string (defensive against schema drift)', () => {
    expect(filterMetadataUpdate(flowsheetUpdate({ metadata_status: 'unknown_status' }))).toBeNull();
  });
});

describe('setupMetadataBroadcast Sentry path (BS-2)', () => {
  // Pre-BS-2 a broadcast throw was logged to console.error and lost in CW
  // tail noise. BS-2 routes the exception through Sentry so a rate spike
  // becomes visible.

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('captures broadcast exceptions to Sentry with module + payload tags', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });

    setupMetadataBroadcast();

    const cb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    cb(flowsheetUpdate());

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    expect(context).toMatchObject({
      tags: expect.objectContaining({ module: 'metadata-broadcast' }),
      extra: expect.objectContaining({ id: 42, metadata_status: 'enriched_match' }),
    });
  });

  it('does not call Sentry on a normal broadcast', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => undefined);

    setupMetadataBroadcast();

    const cb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    cb(flowsheetUpdate());

    expect(serverEventsMgr.broadcast).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

const flowsheetInsert = (
  overrides: Partial<Record<string, unknown>> = {},
  eventOverrides: Partial<CdcEvent> = {}
): CdcEvent => ({
  table: 'flowsheet',
  schema: 'wxyc_schema',
  action: 'INSERT',
  data: {
    id: 77,
    entry_type: 'track',
    metadata_status: 'pending',
    ...overrides,
  },
  timestamp: NOW,
  ...eventOverrides,
});

describe('filterMetadataInsert (BS#1888)', () => {
  // Symmetric with filterMetadataUpdate: a flowsheet INSERT of a `track` row is
  // the Epic C "a new track was played" event. The CDC trigger captures every
  // insert source (dj-site/iOS addEntry, flowsheet ETL, auto-dj), so a live
  // subscriber appends the row regardless of origin. The row is `pending` at
  // insert; enrichment arrives seconds later as the existing `liveFs:update`.

  it('projects the client-facing row as the payload on a track INSERT, dropping internal columns', () => {
    const event = flowsheetInsert({
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      track_title: 'Back, Baby',
      record_label: 'Drag City',
      // pre-enrichment: enrichment fields still null
      artwork_url: null,
      release_year: null,
      // internal columns on the raw CDC row — must be stripped
      search_doc: "'jessica':1A",
      composer: 'Jessica Pratt',
      legacy_entry_id: 8888,
    });
    expect(filterMetadataInsert(event)).toEqual({
      id: 77,
      entry_type: 'track',
      metadata_status: 'pending',
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      track_title: 'Back, Baby',
      record_label: 'Drag City',
      artwork_url: null,
      release_year: null,
    });
  });

  it('strips every internal column and keeps client columns from a full CDC row', () => {
    // makeFullFlowsheetRow() supplies its own id (42) + entry_type ('track'),
    // which win over flowsheetInsert's defaults via the spread.
    //
    // Round-tripped through JSON.parse(JSON.stringify(...)) — the
    // flowsheet-projection.test.ts convention for "emulate the parsed-JSON
    // shape: dates arrive as ISO strings, not Dates" — with a FRESH add_time
    // (the fixture's own default is 2024-01-01, and a Date object at that).
    // Both details matter here: makeFullFlowsheetRow()'s raw add_time is a
    // Date OBJECT, which the age guard's parseAddTimeMs fails open on by
    // TYPE alone (never reaching Date.parse), so a bare
    // `filterMetadataInsert(flowsheetInsert(makeFullFlowsheetRow()))` call
    // would pass this test without ever exercising the guard — exactly the
    // gap a review caught (BS#2131). Stamping a recent add_time and
    // round-tripping through JSON makes this the most production-faithful
    // fixture in the file actually exercise the guard's real pass-through
    // path, not its fail-open path.
    const freshRow = JSON.parse(JSON.stringify(makeFullFlowsheetRow({ add_time: new Date(NOW - 60_000) }))) as Record<
      string,
      unknown
    >;
    const payload = filterMetadataInsert(flowsheetInsert(freshRow));
    expect(payload).not.toBeNull();
    for (const internalKey of INTERNAL_FLOWSHEET_COLUMNS) {
      expect(payload).not.toHaveProperty(internalKey);
    }
    expect(payload).toMatchObject({ id: 42, entry_type: 'track' });
  });

  it('skips a non-track INSERT (marker/message rows are not the "new track" signal)', () => {
    expect(filterMetadataInsert(flowsheetInsert({ entry_type: 'breakpoint' }))).toBeNull();
    expect(filterMetadataInsert(flowsheetInsert({ entry_type: 'message' }))).toBeNull();
    expect(filterMetadataInsert(flowsheetInsert({ entry_type: 'dj_join' }))).toBeNull();
  });

  it('skips UPDATE events (those are the enrichment output, handled by filterMetadataUpdate)', () => {
    expect(filterMetadataInsert({ ...flowsheetInsert(), action: 'UPDATE' })).toBeNull();
  });

  it('skips DELETE events', () => {
    expect(filterMetadataInsert({ ...flowsheetInsert(), action: 'DELETE' })).toBeNull();
  });

  it('skips events for tables other than flowsheet', () => {
    expect(filterMetadataInsert({ ...flowsheetInsert(), table: 'rotation' })).toBeNull();
  });

  it('skips when data is missing', () => {
    expect(filterMetadataInsert({ ...flowsheetInsert(), data: null })).toBeNull();
  });

  it('skips when id is missing or not a number', () => {
    expect(filterMetadataInsert(flowsheetInsert({ id: undefined }))).toBeNull();
    expect(filterMetadataInsert(flowsheetInsert({ id: 'seventy-seven' }))).toBeNull();
  });
});

describe('filterMetadataInsert add_time age guard (BS#2131, parent #2118 site 4)', () => {
  // #2118 site 4: flowsheet.id is not a chronological key, so a bulk
  // historical/backfill INSERT lands at the head of the serial PK but not
  // at the head of the timeline. Without an age guard, filterMetadataInsert
  // would broadcast every row of such an import on the anonymous liveFs
  // topic — #1888's stated invariant ("a steady-state insert is always a
  // live/recent row") enforced for the first time here.
  //
  // Fail-open is the load-bearing policy: every fixture above omits
  // add_time entirely, and production guarantees the column via NOT NULL +
  // to_jsonb(NEW), so "missing" only happens in tests / a schema drift —
  // never silently drop a live insert because of that.
  //
  // "now" comes from the fixture's own CdcEvent.timestamp (via
  // resolveEventNowMs in the source), not a second function argument or a
  // faked Date.now() — every flowsheetInsert() call below defaults to
  // `timestamp: NOW`, so add_time offsets are computed against that same
  // module-level NOW constant.

  const REAL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // default LIVE_FS_INSERT_MAX_AGE_HOURS = 24

  /**
   * Renders `ms` as an ISO string carrying an explicit fixed UTC offset
   * (e.g. "-04:00") instead of a "Z" suffix — mirroring how Postgres's
   * to_jsonb(timestamptz) renders the session-timezone offset, never a
   * guaranteed "Z". Round-trips through Date.parse to the same instant.
   */
  const toOffsetIso = (ms: number, offsetHours: number): string => {
    const shifted = new Date(ms + offsetHours * 60 * 60 * 1000);
    const isoLocal = shifted.toISOString().replace('Z', '');
    const sign = offsetHours >= 0 ? '+' : '-';
    const abs = Math.abs(offsetHours);
    const hh = String(Math.trunc(abs)).padStart(2, '0');
    const mm = String(Math.round((abs % 1) * 60)).padStart(2, '0');
    return `${isoLocal}${sign}${hh}:${mm}`;
  };

  afterEach(() => {
    delete process.env.LIVE_FS_INSERT_MAX_AGE_HOURS;
  });

  it('broadcasts a track INSERT whose add_time is well within the threshold', () => {
    const addTime = new Date(NOW - 60_000).toISOString(); // 1 minute old
    const payload = filterMetadataInsert(flowsheetInsert({ add_time: addTime }));
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({ id: 77 });
  });

  it('does not broadcast a track INSERT whose add_time is well outside the threshold', () => {
    const addTime = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days old
    expect(filterMetadataInsert(flowsheetInsert({ add_time: addTime }))).toBeNull();
  });

  it('still broadcasts exactly at the threshold boundary (age === threshold is not "older")', () => {
    const addTime = new Date(NOW - REAL_THRESHOLD_MS).toISOString();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: addTime }))).not.toBeNull();
  });

  it('does not broadcast one millisecond past the threshold boundary', () => {
    const addTime = new Date(NOW - REAL_THRESHOLD_MS - 1).toISOString();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: addTime }))).toBeNull();
  });

  it('parses an offset-bearing (non-Z) ISO string the way to_jsonb(timestamptz) renders it', () => {
    // Postgres's to_jsonb on a timestamptz renders the session-timezone
    // offset, not a guaranteed Z suffix — e.g. "-04:00" rather than "Z".
    // Parsing must not pattern-match on a trailing "Z".
    const recentOffsetAddTime = toOffsetIso(NOW - 60_000, -4); // 1 minute old
    expect(filterMetadataInsert(flowsheetInsert({ add_time: recentOffsetAddTime }))).not.toBeNull();

    const staleOffsetAddTime = toOffsetIso(NOW - 30 * 24 * 60 * 60 * 1000, -4); // 30 days old
    expect(filterMetadataInsert(flowsheetInsert({ add_time: staleOffsetAddTime }))).toBeNull();
  });

  it('fails open (still broadcasts) when add_time is entirely absent, matching every existing fixture', () => {
    const event = flowsheetInsert(); // no add_time key at all
    expect(filterMetadataInsert(event)).not.toBeNull();
  });

  it('fails open when add_time is null', () => {
    expect(filterMetadataInsert(flowsheetInsert({ add_time: null }))).not.toBeNull();
  });

  it('fails open when add_time is an unparseable string (Date.parse -> NaN)', () => {
    expect(filterMetadataInsert(flowsheetInsert({ add_time: 'not-a-real-timestamp' }))).not.toBeNull();
  });

  it('fails open when add_time is not a string at all (defensive against schema drift)', () => {
    expect(filterMetadataInsert(flowsheetInsert({ add_time: 12345 }))).not.toBeNull();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: {} }))).not.toBeNull();
  });

  it('honors LIVE_FS_INSERT_MAX_AGE_HOURS to shrink the threshold', () => {
    process.env.LIVE_FS_INSERT_MAX_AGE_HOURS = '1';
    const twoHoursOld = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const thirtyMinutesOld = new Date(NOW - 30 * 60 * 1000).toISOString();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: twoHoursOld }))).toBeNull();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: thirtyMinutesOld }))).not.toBeNull();
  });

  it('honors LIVE_FS_INSERT_MAX_AGE_HOURS to widen the threshold', () => {
    process.env.LIVE_FS_INSERT_MAX_AGE_HOURS = '720'; // 30 days
    const twentyDaysOld = new Date(NOW - 20 * 24 * 60 * 60 * 1000).toISOString();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: twentyDaysOld }))).not.toBeNull();
  });

  it('LIVE_FS_INSERT_MAX_AGE_HOURS=0 is NOT a kill switch — a fresh insert still broadcasts', () => {
    // The regression this test pins (review finding, BS#2131 follow-up):
    // resolveLiveFsInsertMaxAgeMs('0') used to return 0ms verbatim, and
    // isOlderThanThreshold's `nowMs - parsedAddTimeMs > 0` is true for every
    // real insert (a row is always at least a few ms old by the time this
    // callback runs) — so `0` silently classified every live play as
    // historical and took the whole liveFs:insert feed dark station-wide.
    // `0` must now be rejected (warn-and-default to 24h), so a one-second-old
    // insert still broadcasts even with the misconfigured value set.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.LIVE_FS_INSERT_MAX_AGE_HOURS = '0';
    const oneSecondOld = new Date(NOW - 1000).toISOString();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: oneSecondOld }))).not.toBeNull();
    warnSpy.mockRestore();
  });

  it("falls back to Date.now() when the CDC event's own timestamp is missing or non-numeric", () => {
    // cdc-listener.ts's onCdcEvent dispatch does a bare `JSON.parse(payload)
    // as CdcEvent` with no runtime validation, so `timestamp` isn't
    // guaranteed present or numeric. resolveEventNowMs falls back to the
    // real wall clock in that case — exercised here against REAL current
    // time (not the fixed NOW constant) since that's exactly what
    // production would do.
    const recentRealAddTime = new Date(Date.now() - 1000).toISOString(); // 1 second old
    const staleRealAddTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days old

    expect(
      filterMetadataInsert(flowsheetInsert({ add_time: recentRealAddTime }, { timestamp: undefined }))
    ).not.toBeNull();
    expect(filterMetadataInsert(flowsheetInsert({ add_time: staleRealAddTime }, { timestamp: undefined }))).toBeNull();

    // Non-numeric timestamp (e.g. a parse artifact) falls back the same way.
    expect(
      filterMetadataInsert(
        flowsheetInsert({ add_time: recentRealAddTime }, { timestamp: 'not-a-number' as unknown as number })
      )
    ).not.toBeNull();
  });
});

describe('isAgeSuppressedInsert (BS#2131 review follow-up)', () => {
  afterEach(() => {
    delete process.env.LIVE_FS_INSERT_MAX_AGE_HOURS;
  });

  it('is true for a track INSERT the age guard would suppress', () => {
    const staleAddTime = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(isAgeSuppressedInsert(flowsheetInsert({ add_time: staleAddTime }))).toBe(true);
  });

  it('is false for a track INSERT within the threshold', () => {
    const recentAddTime = new Date(NOW - 60_000).toISOString();
    expect(isAgeSuppressedInsert(flowsheetInsert({ add_time: recentAddTime }))).toBe(false);
  });

  it('is false for an ordinary non-applicable CDC event (not a track insert at all)', () => {
    // These are NOT "suppressed by the age guard" — they're simply not the
    // shape the guard applies to. isAgeSuppressedInsert must not conflate
    // routine onCdcEvent traffic with an intentional historical-row drop.
    expect(isAgeSuppressedInsert({ ...flowsheetInsert(), action: 'UPDATE' })).toBe(false);
    expect(isAgeSuppressedInsert({ ...flowsheetInsert(), table: 'rotation' })).toBe(false);
    expect(isAgeSuppressedInsert(flowsheetInsert({ entry_type: 'show_start' }))).toBe(false);
    expect(isAgeSuppressedInsert(flowsheetInsert({ id: undefined }))).toBe(false);
  });

  it('is false (fails open, matches filterMetadataInsert) when add_time is missing or unparseable', () => {
    expect(isAgeSuppressedInsert(flowsheetInsert())).toBe(false);
    expect(isAgeSuppressedInsert(flowsheetInsert({ add_time: 'garbage' }))).toBe(false);
  });
});

describe('resolveLiveFsInsertMaxAgeMs', () => {
  afterEach(() => {
    delete process.env.LIVE_FS_INSERT_MAX_AGE_HOURS;
  });

  it('defaults to 24 hours when unset', () => {
    expect(resolveLiveFsInsertMaxAgeMs(undefined)).toBe(24 * 60 * 60 * 1000);
  });

  it('defaults to 24 hours on an empty/whitespace value', () => {
    expect(resolveLiveFsInsertMaxAgeMs('')).toBe(24 * 60 * 60 * 1000);
    expect(resolveLiveFsInsertMaxAgeMs('   ')).toBe(24 * 60 * 60 * 1000);
  });

  it('accepts a positive override', () => {
    expect(resolveLiveFsInsertMaxAgeMs('1')).toBe(60 * 60 * 1000);
    expect(resolveLiveFsInsertMaxAgeMs('0.5')).toBe(30 * 60 * 1000);
  });

  it('rejects 0 and warns-and-defaults to 24h — 0 is a station-wide kill switch, not "disabled"', () => {
    // nowMs - parsedAddTimeMs > 0 is true for every real insert, so a 0ms
    // threshold would classify every live play as historical. Same hazard,
    // same handling as DIGEST_MAX_PLAY_AGE_HOURS's requirePositiveInt.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveLiveFsInsertMaxAgeMs('0')).toBe(24 * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/LIVE_FS_INSERT_MAX_AGE_HOURS/);
    warnSpy.mockRestore();
  });

  it('warns and falls back to the default on a negative or non-numeric value', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveLiveFsInsertMaxAgeMs('-1')).toBe(24 * 60 * 60 * 1000);
    expect(resolveLiveFsInsertMaxAgeMs('abc')).toBe(24 * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toMatch(/LIVE_FS_INSERT_MAX_AGE_HOURS/);
    warnSpy.mockRestore();
  });

  it('warn-once latch: repeating the SAME invalid raw value warns only once, but a DIFFERENT invalid value warns again', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    resolveLiveFsInsertMaxAgeMs('bogus-repeat-value');
    resolveLiveFsInsertMaxAgeMs('bogus-repeat-value');
    resolveLiveFsInsertMaxAgeMs('bogus-repeat-value');
    const callsForRepeat = warnSpy.mock.calls.filter((c) => String(c[0]).includes('bogus-repeat-value')).length;
    expect(callsForRepeat).toBe(1);

    resolveLiveFsInsertMaxAgeMs('bogus-different-value');
    const callsForDifferent = warnSpy.mock.calls.filter((c) => String(c[0]).includes('bogus-different-value')).length;
    expect(callsForDifferent).toBe(1);

    warnSpy.mockRestore();
  });
});

describe('setupMetadataBroadcast liveFs:insert registration (BS#1888)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('broadcasts a liveFs:insert on a track INSERT via a second CDC registration', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => undefined);

    setupMetadataBroadcast();

    // Three registrations: [0] = update, [1] = insert, [2] = library-CDC cache
    // invalidation (BS#1962). The insert handler stays at index [1].
    expect((onCdcEvent as jest.Mock).mock.calls.length).toBe(3);
    const insertCb = (onCdcEvent as jest.Mock).mock.calls[1][0] as (event: CdcEvent) => void;
    insertCb(flowsheetInsert({ artist_name: 'Stereolab', album_title: 'Aluminum Tunes' }));

    expect(serverEventsMgr.broadcast).toHaveBeenCalledTimes(1);
    const [topic, frame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[0];
    expect(topic).toBe('live-fs-topic');
    expect(frame).toMatchObject({
      type: 'insert',
      payload: expect.objectContaining({ id: 77, entry_type: 'track', metadata_status: 'pending' }),
    });
    // A normal live broadcast is NOT a suppression (BS#2131 review follow-up).
    expect(mockRecordInsertSuppressed).not.toHaveBeenCalled();
  });

  it('does not broadcast on a non-track INSERT, and does not record it as a suppression', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => undefined);

    setupMetadataBroadcast();

    const insertCb = (onCdcEvent as jest.Mock).mock.calls[1][0] as (event: CdcEvent) => void;
    insertCb(flowsheetInsert({ entry_type: 'show_start' }));

    expect(serverEventsMgr.broadcast).not.toHaveBeenCalled();
    // A marker row isn't "a track insert the age guard suppressed" — it was
    // never a candidate in the first place, so it must not inflate the metric.
    expect(mockRecordInsertSuppressed).not.toHaveBeenCalled();
  });

  it('records SSE/InsertSuppressed (not a broadcast) when the age guard drops a historical track INSERT', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => undefined);

    setupMetadataBroadcast();

    const insertCb = (onCdcEvent as jest.Mock).mock.calls[1][0] as (event: CdcEvent) => void;
    const staleAddTime = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days old
    insertCb(flowsheetInsert({ add_time: staleAddTime }));

    expect(serverEventsMgr.broadcast).not.toHaveBeenCalled();
    expect(mockRecordInsertSuppressed).toHaveBeenCalledTimes(1);
    expect(mockRecordInsertSuppressed).toHaveBeenCalledWith('live-fs-topic');
  });

  it('captures an insert-broadcast exception to Sentry with module tag', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => {
      throw new Error('insert boom');
    });

    setupMetadataBroadcast();

    const insertCb = (onCdcEvent as jest.Mock).mock.calls[1][0] as (event: CdcEvent) => void;
    insertCb(flowsheetInsert());

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect((err as Error).message).toBe('insert boom');
    expect(context).toMatchObject({
      tags: expect.objectContaining({ module: 'metadata-broadcast' }),
      extra: expect.objectContaining({ id: 77 }),
    });
  });
});

describe('setupMetadataBroadcast discogs-unavailable enrichment (BS#1962)', () => {
  // AC #3 (non-library rows omit the field) is covered by every existing
  // test above — none of their fixtures set album_id, so they stay on the
  // fully-synchronous no-cache-call path unchanged. These tests cover the
  // album_id-bearing branch: the guarded async enrich, additive-failure
  // degrade, and same-row insert/update ordering over a shared (coalesced)
  // promise.

  beforeEach(() => {
    jest.clearAllMocks();
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => undefined);
  });

  it('enriches an update broadcast for a flagged library-linked album (id + note)', async () => {
    mockGetCachedDiscogsUnavailableFlags.mockResolvedValueOnce({
      discogsUnavailable: true,
      discogsUnavailableNote: 'Embargoed promo pressing',
      lastDiscogsRecheckAt: null,
    });

    setupMetadataBroadcast();
    const updateCb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    updateCb(flowsheetUpdate({ album_id: 501 }));

    await flushAsync();

    expect(mockGetCachedDiscogsUnavailableFlags).toHaveBeenCalledWith(501);
    expect(serverEventsMgr.broadcast).toHaveBeenCalledTimes(1);
    const [, frame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[0];
    expect(frame.payload).toMatchObject({
      id: 42,
      discogsUnavailable: true,
      discogsUnavailableNote: 'Embargoed promo pressing',
    });
  });

  it('emits discogsUnavailable: false (present, not omitted) for a linked-unflagged album', async () => {
    mockGetCachedDiscogsUnavailableFlags.mockResolvedValueOnce({
      discogsUnavailable: false,
      discogsUnavailableNote: null,
      lastDiscogsRecheckAt: null,
    });

    setupMetadataBroadcast();
    const updateCb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    updateCb(flowsheetUpdate({ album_id: 501 }));

    await flushAsync();

    const [, frame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[0];
    expect(frame.payload).toHaveProperty('discogsUnavailable', false);
    expect(frame.payload).not.toHaveProperty('discogsUnavailableNote');
  });

  it('a null album_id never calls the cache and stays on the synchronous path (AC #3)', () => {
    setupMetadataBroadcast();
    const updateCb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    updateCb(flowsheetUpdate()); // default fixture carries no album_id

    // No await/flush at all: if this were routed onto the async enrich path,
    // the broadcast would not yet have fired synchronously here.
    expect(serverEventsMgr.broadcast).toHaveBeenCalledTimes(1);
    expect(mockGetCachedDiscogsUnavailableFlags).not.toHaveBeenCalled();
    const [, frame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[0];
    expect(frame.payload).not.toHaveProperty('discogsUnavailable');
    expect(frame.payload).not.toHaveProperty('discogsUnavailableNote');
  });

  it('a rejected cache lookup degrades to omitting the fields — broadcast still fires, no Sentry trip', async () => {
    mockGetCachedDiscogsUnavailableFlags.mockRejectedValueOnce(new Error('db blip'));

    setupMetadataBroadcast();
    const updateCb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    updateCb(flowsheetUpdate({ album_id: 501 }));

    await flushAsync();

    expect(serverEventsMgr.broadcast).toHaveBeenCalledTimes(1);
    const [, frame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[0];
    expect(frame.payload).not.toHaveProperty('discogsUnavailable');
    expect(frame.payload).not.toHaveProperty('discogsUnavailableNote');
    // The additive-failure catch is INNER and swallowing — it must not trip
    // the broadcast-level Sentry capture, which stays scoped to genuine
    // serverEventsMgr.broadcast failures.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('the same per-path Sentry extra shape (id + metadata_status) still fires on a broadcast failure with album_id present', async () => {
    mockGetCachedDiscogsUnavailableFlags.mockResolvedValueOnce({
      discogsUnavailable: true,
      discogsUnavailableNote: null,
      lastDiscogsRecheckAt: null,
    });
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });

    setupMetadataBroadcast();
    const updateCb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    updateCb(flowsheetUpdate({ album_id: 501 }));

    await flushAsync();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(context).toMatchObject({
      tags: expect.objectContaining({ module: 'metadata-broadcast' }),
      extra: expect.objectContaining({ id: 42, metadata_status: 'enriched_match' }),
    });
  });

  it('insert then update for the same cold album_id broadcast in insert-before-update order (coalesced shared promise)', async () => {
    // Every call to the (mocked) cache returns the SAME pending promise —
    // the faithful stand-in for the real cache module's in-flight
    // coalescing (both the insert and update handler await the identical
    // promise). Both handlers register their `await` in call order, so
    // resolving the shared promise resumes them FIFO: insert broadcasts
    // before update.
    let resolveShared!: (value: unknown) => void;
    const sharedPromise = new Promise((resolve) => {
      resolveShared = resolve;
    });
    mockGetCachedDiscogsUnavailableFlags.mockReturnValue(sharedPromise);

    setupMetadataBroadcast();
    const updateCb = (onCdcEvent as jest.Mock).mock.calls[0][0] as (event: CdcEvent) => void;
    const insertCb = (onCdcEvent as jest.Mock).mock.calls[1][0] as (event: CdcEvent) => void;

    insertCb(flowsheetInsert({ id: 501, album_id: 501 }));
    updateCb(flowsheetUpdate({ id: 501, album_id: 501 }));

    resolveShared({ discogsUnavailable: true, discogsUnavailableNote: null, lastDiscogsRecheckAt: null });
    await flushAsync();

    expect(serverEventsMgr.broadcast).toHaveBeenCalledTimes(2);
    const [, firstFrame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[0];
    const [, secondFrame] = (serverEventsMgr.broadcast as jest.Mock).mock.calls[1];
    expect(firstFrame.type).toBe('insert');
    expect(secondFrame.type).toBe('update');
  });
});

describe('setupMetadataBroadcast library-CDC cache invalidation (BS#1962)', () => {
  // The third onCdcEvent registration invalidates the discogs-unavailable cache
  // off the same CDC stream, so a `library` flag flip is dropped from every BS
  // instance's cache (not just the one that served the PATCH). Registered LAST,
  // so `mock.calls[2]` is this handler and the update/insert indices above are
  // unchanged.
  const libraryCb = (): ((event: CdcEvent) => void) => {
    setupMetadataBroadcast();
    return (onCdcEvent as jest.Mock).mock.calls[2][0] as (event: CdcEvent) => void;
  };

  const libraryEvent = (overrides: Partial<CdcEvent> = {}): CdcEvent => ({
    table: 'library',
    schema: 'wxyc_schema',
    action: 'UPDATE',
    data: { id: 42, discogs_unavailable: true },
    timestamp: 1779856000000,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invalidates the cache for the library row id on a library UPDATE', () => {
    libraryCb()(libraryEvent({ action: 'UPDATE' }));
    expect(mockInvalidateDiscogsUnavailableFlags).toHaveBeenCalledWith(42);
    expect(mockInvalidateDiscogsUnavailableFlags).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache for the library row id on a library DELETE', () => {
    libraryCb()(libraryEvent({ action: 'DELETE', data: { id: 7 } }));
    expect(mockInvalidateDiscogsUnavailableFlags).toHaveBeenCalledWith(7);
  });

  it('does NOT invalidate on a library INSERT (a fresh serial id can not be cached yet)', () => {
    libraryCb()(libraryEvent({ action: 'INSERT' }));
    expect(mockInvalidateDiscogsUnavailableFlags).not.toHaveBeenCalled();
  });

  it('ignores non-library tables', () => {
    libraryCb()(libraryEvent({ table: 'flowsheet' }));
    expect(mockInvalidateDiscogsUnavailableFlags).not.toHaveBeenCalled();
  });

  it('skips an event whose data is missing or carries a non-numeric id', () => {
    const cb = libraryCb();
    cb(libraryEvent({ data: null }));
    cb(libraryEvent({ data: { id: 'forty-two' } }));
    cb(libraryEvent({ data: {} }));
    expect(mockInvalidateDiscogsUnavailableFlags).not.toHaveBeenCalled();
  });
});
