/**
 * Unit tests for forward-path observability wiring (B-3.2).
 *
 * Each outcome of `runLmlLinkage` increments exactly one counter; an LML
 * error reports to Sentry with `subsystem='lml-linkage'` and `path='forward'`
 * (so the operator can split the issue stream by forward-vs-backfill) and
 * surfaces as either `lml_timeout` or `lml_error` depending on the error
 * shape.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: jest.fn().mockReturnValue(true),
}));

import { runLmlLinkage } from '../../../apps/backend/services/flowsheet-linkage.service';
import {
  getLinkageCounters,
  resetLinkageCounters,
} from '../../../apps/backend/services/linkage-metrics.service';

const directMatch = (release_id: number) => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id, release_url: '', confidence: 0 } }],
  search_type: 'direct',
  song_not_found: false,
  found_on_compilation: false,
});

const fallbackMatch = (release_id: number) => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id, release_url: '', confidence: 0 } }],
  search_type: 'fallback',
  song_not_found: false,
  found_on_compilation: false,
});

const noneMatch = () => ({
  results: [],
  search_type: 'none',
  song_not_found: false,
  found_on_compilation: false,
});

describe('runLmlLinkage observability (B-3.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetLinkageCounters();
  });

  it("increments linked_high_conf when a direct match resolves to one library row", async () => {
    mockLookupMetadata.mockResolvedValue(directMatch(123456));
    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([{ id: 88 }]);
    db.select.mockReturnValueOnce(selectChain);
    db.update.mockReturnValueOnce(createMockQueryChain());

    await runLmlLinkage({ flowsheetId: 7, artistName: 'Juana Molina', albumTitle: 'DOGA' });

    expect(getLinkageCounters().linked_high_conf).toBe(1);
    expect(getLinkageCounters().gray_zone_review).toBe(0);
    expect(getLinkageCounters().no_candidate).toBe(0);
  });

  it("increments gray_zone_review on a fallback (low-confidence) match", async () => {
    mockLookupMetadata.mockResolvedValue(fallbackMatch(987));

    await runLmlLinkage({ flowsheetId: 7, artistName: 'Andy Stott', albumTitle: 'Faith' });

    expect(getLinkageCounters().gray_zone_review).toBe(1);
    expect(getLinkageCounters().linked_high_conf).toBe(0);
  });

  it("increments no_candidate when LML returns no canonical entity", async () => {
    mockLookupMetadata.mockResolvedValue(noneMatch());

    await runLmlLinkage({ flowsheetId: 7, artistName: 'Unknown', albumTitle: 'Unknown' });

    expect(getLinkageCounters().no_candidate).toBe(1);
  });

  it("increments no_candidate when canonical entity exists but no library row carries it", async () => {
    mockLookupMetadata.mockResolvedValue(directMatch(555));
    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(selectChain);

    await runLmlLinkage({ flowsheetId: 7, artistName: 'Jessica Pratt', albumTitle: 'Quiet Signs' });

    expect(getLinkageCounters().no_candidate).toBe(1);
  });

  it("increments gray_zone_review on multi_match (defers to B-2.3 / review)", async () => {
    // Multiple library rows under one canonical entity = a tie-break decision
    // a human or B-2.3 has to make. The dashboard treats it as review-bound
    // so the gauge captures the gap between "LML matched" and "linkage applied".
    mockLookupMetadata.mockResolvedValue(directMatch(42));
    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    db.select.mockReturnValueOnce(selectChain);

    await runLmlLinkage({ flowsheetId: 7, artistName: 'Stereolab', albumTitle: 'Aluminum Tunes' });

    expect(getLinkageCounters().gray_zone_review).toBe(1);
  });

  it("increments lml_error and reports Sentry with subsystem='lml-linkage' on a generic LML failure", async () => {
    const err = new Error('LML 502 Bad Gateway');
    mockLookupMetadata.mockRejectedValue(err);

    const outcome = await runLmlLinkage({ flowsheetId: 7, artistName: 'Stereolab', albumTitle: 'Dots' });

    expect(outcome).toEqual(expect.objectContaining({ status: 'error' }));
    expect(getLinkageCounters().lml_error).toBe(1);
    expect(getLinkageCounters().lml_timeout).toBe(0);
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ subsystem: 'lml-linkage', path: 'forward' }),
      })
    );
  });

  it("increments lml_timeout (not lml_error) when the LML call times out", async () => {
    // Splitting the two failure modes lets the operator distinguish "LML
    // is slow / cold" (transient, retried on next sweep) from "linkage code
    // is broken" (needs a human).
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockLookupMetadata.mockRejectedValue(err);

    const outcome = await runLmlLinkage({ flowsheetId: 7, artistName: 'Stereolab', albumTitle: 'Dots' });

    expect(outcome).toEqual(expect.objectContaining({ status: 'error' }));
    expect(getLinkageCounters().lml_timeout).toBe(1);
    expect(getLinkageCounters().lml_error).toBe(0);
    expect(mockCaptureException).toHaveBeenCalledWith(err, expect.anything());
  });

  it("never writes album_id on the error path (row stays NULL for the next sweep)", async () => {
    mockLookupMetadata.mockRejectedValue(new Error('boom'));

    await runLmlLinkage({ flowsheetId: 7, artistName: 'a', albumTitle: 'b' });

    expect(db.update).not.toHaveBeenCalled();
  });
});
