/**
 * Unit tests for the B-2.2 backfill observability wiring (B-3.2).
 *
 * The orchestrator already keeps internal `Totals` for the run report. On
 * top of that, B-3.2 adds an injectable `metrics` sink so each row outcome
 * surfaces under one of the five canonical observability counter names —
 * `linked_high_conf`, `gray_zone_review`, `no_candidate`, `lml_error`,
 * `lml_timeout` — and so each LML failure routes to Sentry with
 * `subsystem='lml-linkage'`, `path='backfill'` from the job's wiring (in
 * `job.ts`, not under test here — the orchestrator only sees the sink).
 */

import { db } from '@wxyc/database';
import { processRow, runBackfill } from '../../../../jobs/flowsheet-lml-link-backfill/orchestrate';
import type { LmlLookupResponse } from '../../../../jobs/flowsheet-lml-link-backfill/lml-types';

const directResponse = (releaseId: number): LmlLookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id: releaseId } }],
  search_type: 'direct',
});

const fallbackResponse = (releaseId: number): LmlLookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id: releaseId } }],
  search_type: 'fallback',
});

const emptyResponse = (): LmlLookupResponse => ({
  results: [],
  search_type: 'none',
});

const makeMetrics = () => {
  const recordOutcome = jest.fn();
  const reportError = jest.fn();
  return { sink: { recordOutcome, reportError }, recordOutcome, reportError };
};

describe('processRow metrics integration (B-3.2)', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records linked_high_conf when one library row matches a direct hit', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 100 }]).mockResolvedValueOnce({ count: 1 });
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('linked_high_conf');
  });

  it('records gray_zone_review on a fallback hit (review-bound)', async () => {
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn(() => Promise.resolve(fallbackResponse(33)));

    await processRow({ id: 7, artist_name: 'Jessica Pratt', album_title: 'On Your Own' }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('gray_zone_review');
  });

  it('records linked_high_conf on multi_match resolved via B-2.3 tie-break', async () => {
    // Multi-match used to defer to a review queue; B-2.3 wired the tie-break
    // (rotation > format > plays > id) into the orchestrator so the row gets
    // linked to the picked library_id. The metric reflects a successful link.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }]) // findLibraryByCanonicalEntity
      .mockResolvedValueOnce([{ id: 100, format_name: 'vinyl', plays: 50, in_rotation: false }]) // pickPrimaryLibraryRow lookup
      .mockResolvedValueOnce(undefined); // applyLink
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    await processRow({ id: 7, artist_name: 'Stereolab', album_title: 'Aluminum Tunes' }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('linked_high_conf');
  });

  it('records no_candidate on no_library_match', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    await processRow({ id: 7, artist_name: 'Stereolab', album_title: 'Dots and Loops' }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('no_candidate');
  });

  it('records no_candidate on no_match (LML returned nothing)', async () => {
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn(() => Promise.resolve(emptyResponse()));

    await processRow({ id: 7, artist_name: 'Unknown', album_title: 'Unknown' }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('no_candidate');
  });

  it('records no_candidate when a row lacks artist or album text (filtered out before LML)', async () => {
    // The orchestrator short-circuits these to 'no_match' without calling
    // LML. From the metric's perspective, no candidate produced.
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn();

    await processRow({ id: 7, artist_name: '', album_title: null }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('no_candidate');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('records lml_error and reports the error on a generic LML failure', async () => {
    const err = new Error('LML 502');
    const { sink, recordOutcome, reportError } = makeMetrics();
    const lookup = jest.fn(() => Promise.reject(err));

    const status = await processRow({ id: 7, artist_name: 'a', album_title: 'b' }, { lookup, metrics: sink });

    expect(status).toBe('error');
    expect(recordOutcome).toHaveBeenCalledWith('lml_error');
    expect(reportError).toHaveBeenCalledWith(err, expect.objectContaining({ flowsheetId: 7 }));
  });

  it('records lml_timeout (not lml_error) on AbortError-style timeouts', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { sink, recordOutcome, reportError } = makeMetrics();
    const lookup = jest.fn(() => Promise.reject(err));

    await processRow({ id: 7, artist_name: 'a', album_title: 'b' }, { lookup, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledWith('lml_timeout');
    expect(reportError).toHaveBeenCalled();
  });

  it('works without a metrics sink (sink is optional — tests/CLI runs are unaffected)', async () => {
    // The existing orchestrate tests do not pass a sink. Adding the sink as
    // required would break every prior call site. The default must be a
    // silent no-op so old wiring still works.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 100 }]).mockResolvedValueOnce({ count: 1 });
    const lookup = jest.fn(() => Promise.resolve(directResponse(123)));

    const status = await processRow({ id: 7, artist_name: 'a', album_title: 'b' }, { lookup });

    expect(status).toBe('linked');
  });
});

describe('runBackfill metrics integration (B-3.2)', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('threads the metrics sink through to every row processed', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
      ])
      .mockResolvedValueOnce([]);
    const { sink, recordOutcome } = makeMetrics();
    const lookup = jest.fn(() => Promise.resolve(emptyResponse()));

    await runBackfill({ lookup, throttleMs: 0, metrics: sink });

    expect(recordOutcome).toHaveBeenCalledTimes(2);
    expect(recordOutcome).toHaveBeenCalledWith('no_candidate');
  });
});
