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

import * as Sentry from '@sentry/node';
import {
  filterMetadataUpdate,
  filterMetadataInsert,
  setupMetadataBroadcast,
} from '../../../../../apps/backend/services/metadata-broadcast/metadata-broadcast';
import { onCdcEvent } from '@wxyc/database';
import { serverEventsMgr } from '../../../../../apps/backend/utils/serverEvents.js';

/** Flushes pending microtasks (the cache-await + Object.assign + broadcast chain). */
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const flowsheetUpdate = (overrides: Partial<Record<string, unknown>> = {}): CdcEvent => ({
  table: 'flowsheet',
  schema: 'wxyc_schema',
  action: 'UPDATE',
  data: {
    id: 42,
    metadata_status: 'enriched_match',
    ...overrides,
  },
  timestamp: 1779856000000,
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

const flowsheetInsert = (overrides: Partial<Record<string, unknown>> = {}): CdcEvent => ({
  table: 'flowsheet',
  schema: 'wxyc_schema',
  action: 'INSERT',
  data: {
    id: 77,
    entry_type: 'track',
    metadata_status: 'pending',
    ...overrides,
  },
  timestamp: 1779856000000,
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
    const payload = filterMetadataInsert(flowsheetInsert(makeFullFlowsheetRow()));
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
  });

  it('does not broadcast on a non-track INSERT', () => {
    (serverEventsMgr.broadcast as jest.Mock).mockImplementation(() => undefined);

    setupMetadataBroadcast();

    const insertCb = (onCdcEvent as jest.Mock).mock.calls[1][0] as (event: CdcEvent) => void;
    insertCb(flowsheetInsert({ entry_type: 'show_start' }));

    expect(serverEventsMgr.broadcast).not.toHaveBeenCalled();
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
