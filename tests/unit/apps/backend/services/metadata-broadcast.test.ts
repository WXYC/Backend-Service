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

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

jest.mock('../../../../../apps/backend/utils/serverEvents.js', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { update: 'update' },
  serverEventsMgr: { broadcast: jest.fn() },
}));

jest.mock('@wxyc/database', () => ({
  onCdcEvent: jest.fn(),
}));

import * as Sentry from '@sentry/node';
import {
  filterMetadataUpdate,
  setupMetadataBroadcast,
} from '../../../../../apps/backend/services/metadata-broadcast/metadata-broadcast';
import { onCdcEvent } from '@wxyc/database';
import { serverEventsMgr } from '../../../../../apps/backend/utils/serverEvents.js';

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
  // already being in the local cache. BS-2 inlines the full row so
  // newly-mounted clients (a /live viewer that just opened the page) can
  // surface metadata-enriched fields like `artwork_url` without a follow-up
  // GET. The wxyc-shared `LiveFsUpdateEvent` contract pins this shape.

  it('returns the full row data as the payload (BS-2)', () => {
    const event = flowsheetUpdate({
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
      record_label: 'Sonamos',
      artwork_url: 'https://example.com/doga.jpg',
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
