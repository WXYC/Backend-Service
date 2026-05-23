/**
 * Unit tests for enrichment-worker cdc-subscriber.ts (BS#892 / Epic C C2).
 *
 * Pins the CDC event filter: only flowsheet track INSERTs with
 * `metadata_status='pending'` and a non-empty `artist_name` produce an
 * enrichment candidate. Every other shape (UPDATE, DELETE, marker rows,
 * already-claimed rows, missing artist) is skipped.
 *
 * The filter is the perimeter that decides which CDC events the consumer
 * acts on. Getting it wrong wastes LML calls or silently drops work, so
 * the cases below are exhaustive of the documented criteria.
 */
import type { CdcEvent } from '@wxyc/database';
import { filterForEnrichment, makeLogOnlyHandler } from '../../../../apps/enrichment-worker/cdc-subscriber';

const flowsheetInsert = (overrides: Partial<Record<string, unknown>> = {}): CdcEvent => ({
  table: 'flowsheet',
  schema: 'wxyc_schema',
  action: 'INSERT',
  data: {
    id: 42,
    entry_type: 'track',
    metadata_status: 'pending',
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
    track_title: 'la paradoja',
    album_id: 1234,
    ...overrides,
  },
  timestamp: 1779856000000,
});

describe('filterForEnrichment (BS#892)', () => {
  it('returns a candidate for a pending flowsheet track INSERT with an artist', () => {
    const result = filterForEnrichment(flowsheetInsert());
    expect(result).toEqual({
      id: 42,
      entry_type: 'track',
      metadata_status: 'pending',
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
      album_id: 1234,
    });
  });

  it('Epic D / BS#899: forwards album_id when linked, null when unlinked', () => {
    // Linked: candidate carries the album_id so the worker can UPSERT
    // album_metadata. Unlinked (free-form entries): null → worker writes
    // inline on flowsheet as before.
    expect(filterForEnrichment(flowsheetInsert({ album_id: 1234 }))?.album_id).toBe(1234);
    expect(filterForEnrichment(flowsheetInsert({ album_id: null }))?.album_id).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ album_id: undefined }))?.album_id).toBeNull();
    // Defensive coercion: malformed CDC payload (string) → null, not a crash.
    expect(filterForEnrichment(flowsheetInsert({ album_id: '1234' }))?.album_id).toBeNull();
  });

  it('skips events for tables other than flowsheet', () => {
    expect(filterForEnrichment({ ...flowsheetInsert(), table: 'library' })).toBeNull();
  });

  it('skips UPDATE events (only INSERTs trigger first-time enrichment)', () => {
    expect(filterForEnrichment({ ...flowsheetInsert(), action: 'UPDATE' })).toBeNull();
  });

  it('skips DELETE events', () => {
    expect(filterForEnrichment({ ...flowsheetInsert(), action: 'DELETE' })).toBeNull();
  });

  it('skips events with null data', () => {
    expect(filterForEnrichment({ ...flowsheetInsert(), data: null })).toBeNull();
  });

  it('skips non-track rows (show_start, dj_join, talkset, message, etc.)', () => {
    expect(filterForEnrichment(flowsheetInsert({ entry_type: 'show_start' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ entry_type: 'talkset' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ entry_type: 'message' }))).toBeNull();
  });

  it('skips rows already in enriching or terminal state (re-delivery guard)', () => {
    expect(filterForEnrichment(flowsheetInsert({ metadata_status: 'enriching' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ metadata_status: 'enriched_match' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ metadata_status: 'enriched_no_match' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ metadata_status: 'failed_no_retry' }))).toBeNull();
  });

  it('skips rows with null or empty artist_name (LML requires an artist)', () => {
    expect(filterForEnrichment(flowsheetInsert({ artist_name: null }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ artist_name: '' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ artist_name: undefined }))).toBeNull();
  });

  it('skips rows whose id is not a number (defensive against malformed CDC payloads)', () => {
    expect(filterForEnrichment(flowsheetInsert({ id: '42' }))).toBeNull();
    expect(filterForEnrichment(flowsheetInsert({ id: null }))).toBeNull();
  });

  it('coerces missing or non-string album_title and track_title to null', () => {
    const result = filterForEnrichment(flowsheetInsert({ album_title: null, track_title: undefined }));
    expect(result?.album_title).toBeNull();
    expect(result?.track_title).toBeNull();
  });
});

describe('makeLogOnlyHandler (BS#892 PR-1)', () => {
  it('returns a handler that logs candidates and ignores non-candidates', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = makeLogOnlyHandler();

    handler(flowsheetInsert());
    expect(consoleSpy).toHaveBeenCalledWith(
      '[enrichment-worker] would-enrich',
      expect.objectContaining({ id: 42, artist: 'Juana Molina' })
    );

    consoleSpy.mockClear();
    handler({ ...flowsheetInsert(), table: 'library' });
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
