/**
 * Unit tests for the B-2.2 backfill orchestrator.
 *
 * The orchestrator iterates unlinked flowsheet rows, calls LML, looks up
 * library rows by canonical_entity_id, and stamps `album_id` /
 * `linkage_source='lml_high_confidence'` / `linkage_confidence` /
 * `linked_at` when exactly one library row matches.
 *
 * Tests cover:
 *   - applyLink writes the four linkage columns under the right WHERE guard.
 *   - findLibraryByCanonicalEntity returns 0 / 1 / >1 distinct results.
 *   - processRow stitches lookup → resolve → library-lookup → write and
 *     produces the right outcome category for each branch.
 *   - runBackfill paginates by id, throttles between LML calls, exits on the
 *     first empty batch, and keeps going past per-row errors.
 */

import { db, pickPrimaryLibraryRow } from '@wxyc/database';
import {
  applyLink,
  enqueueReview,
  findLibraryByCanonicalEntity,
  processRow,
  runBackfill,
  BATCH_SIZE,
  THROTTLE_MS,
} from '../../../../jobs/flowsheet-lml-link-backfill/orchestrate';
import type { LmlLookupResponse } from '../../../../jobs/flowsheet-lml-link-backfill/lml-types';

type SqlLike = {
  sql?: string | string[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

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

describe('applyLink', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stamps album_id, linkage_source='lml_high_confidence', confidence and linked_at", async () => {
    // The four columns are the audit contract from B-1.4. Missing any of them
    // would leave us unable to tell at a glance how a link was made.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await applyLink({ flowsheetId: 42, libraryId: 7, confidence: 0.95 });

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/album_id"?\s*=/i);
    expect(sqlText).toMatch(/linkage_source"?\s*=\s*'lml_high_confidence'/i);
    expect(sqlText).toMatch(/linkage_confidence"?\s*=/i);
    expect(sqlText).toMatch(/linked_at"?\s*=\s*now\(\)/i);
  });

  it('guards the UPDATE with album_id IS NULL so a concurrent link is not overwritten', async () => {
    // The forward path (B-2.1) and review queue (B-3.1) may link the same
    // row between the time we read it and the time we write. The IS NULL
    // guard makes the UPDATE idempotent — if someone else got there first,
    // the row count is 0 and we move on.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await applyLink({ flowsheetId: 42, libraryId: 7, confidence: 0.95 });

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NULL/i);
  });
});

describe('enqueueReview', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('inserts a review row with the candidate ids, confidences and suggested action', async () => {
    // The B-3.1 CLI scans flowsheet_linkage_review for unreviewed rows and
    // shows the operator the candidate library rows in LML's ranking order.
    // The columns persisted here are exactly the contract that CLI reads.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await enqueueReview({
      flowsheetId: 7,
      candidateLibraryIds: [100, 101],
      candidateConfidences: [0.5, 0.5],
      suggestedAction: 'review_fallback',
    });

    const call = findExecuteCallMatching(/INSERT[\s\S]*flowsheet_linkage_review/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/flowsheet_id/i);
    expect(sqlText).toMatch(/candidate_library_ids/i);
    expect(sqlText).toMatch(/candidate_confidences/i);
    expect(sqlText).toMatch(/suggested_action/i);
  });

  it('uses ON CONFLICT DO NOTHING on flowsheet_id to make re-runs idempotent', async () => {
    // The backfill is restartable; without the conflict guard, a second
    // sweep over the same fallback row would either error on the UNIQUE
    // constraint or duplicate review rows depending on conflict handling.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await enqueueReview({
      flowsheetId: 7,
      candidateLibraryIds: [],
      candidateConfidences: [],
      suggestedAction: 'review_fallback',
    });

    const call = findExecuteCallMatching(/INSERT[\s\S]*flowsheet_linkage_review/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/ON\s+CONFLICT[\s\S]*flowsheet_id[\s\S]*DO\s+NOTHING/i);
  });
});

describe('findLibraryByCanonicalEntity', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('returns the matching library ids for a canonical_entity_id', async () => {
    // The orchestrator branches on count: 0 → no_library_match, 1 → link,
    // >1 → defer to B-2.3's tie-break. The query is just `SELECT id FROM
    // library WHERE canonical_entity_id = $1`.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 100 }]);

    const ids = await findLibraryByCanonicalEntity('discogs:987654');

    expect(ids).toEqual([100]);
    const call = findExecuteCallMatching(/SELECT[\s\S]*library[\s\S]*canonical_entity_id/i);
    expect(call).toBeDefined();
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('discogs:987654');
  });

  it('returns multiple ids when the canonical entity spans library duplicates', async () => {
    // B-2.3 (out of scope for this issue) handles tie-breaking. This job
    // just surfaces the multi-match case so the caller can defer.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 100 }, { id: 101 }]);

    const ids = await findLibraryByCanonicalEntity('discogs:987654');

    expect(ids).toEqual([100, 101]);
  });

  it('returns an empty array when nothing matches', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    const ids = await findLibraryByCanonicalEntity('discogs:987654');

    expect(ids).toEqual([]);
  });
});

describe('processRow', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls LML with (artist, album) — wiring guard so the args don't get swapped", async () => {
    // Verifies the wiring between flowsheet row → lookup. Swapping
    // artist/album would still match some inputs but be silently wrong.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ id: 100 }]) // findLibraryByCanonicalEntity
      .mockResolvedValueOnce({ count: 1 }); // applyLink
    const lookup = jest.fn(() => Promise.resolve(directResponse(123)));

    await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup });

    expect(lookup).toHaveBeenCalledWith('Juana Molina', 'DOGA');
  });

  it('links the row and reports linked when exactly one library row matches', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ id: 100 }]) // SELECT library
      .mockResolvedValueOnce({ count: 1 }); // UPDATE flowsheet
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    const status = await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup });

    expect(status).toBe('linked');
    const updateCall = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    expect(updateCall).toBeDefined();
    const serialized = JSON.stringify(updateCall?.[0]);
    expect(serialized).toContain('100'); // library_id
    expect(serialized).toContain('7'); // flowsheet_id
  });

  it('links via the B-2.3 tie-break when more than one library row matches', async () => {
    // With B-2.3 in place, multi-match is no longer a terminal "review"
    // outcome — the tie-break utility picks one library row deterministically
    // (rotation > format > plays > id) and the orchestrator stamps the
    // linkage exactly the same way it would for a single match.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }]) // SELECT library
      .mockResolvedValueOnce({ count: 1 }); // UPDATE flowsheet (tie-break-picked)
    (pickPrimaryLibraryRow as jest.Mock).mockResolvedValueOnce(101);
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    const status = await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup });

    expect(pickPrimaryLibraryRow).toHaveBeenCalledWith([100, 101]);
    expect(status).toBe('linked');
    const updateCall = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    expect(updateCall).toBeDefined();
    const serialized = JSON.stringify(updateCall?.[0]);
    expect(serialized).toContain('101'); // tie-break picked id
  });

  it('reports no_library_match when the tie-break returns null (concurrent-delete safety net)', async () => {
    // pickPrimaryLibraryRow returns null when the candidate ids are gone
    // by the time the tie-break runs. The orchestrator should treat this
    // the same as the canonical-entity-not-in-library case: no UPDATE,
    // and the row stays NULL for the next sweep to retry.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 100 }, { id: 101 }]);
    (pickPrimaryLibraryRow as jest.Mock).mockResolvedValueOnce(null);
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    const status = await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup });

    expect(status).toBe('no_library_match');
    expect(findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i)).toBeUndefined();
  });

  it("reports no_library_match when LML's canonical entity isn't in our library", async () => {
    // Canonical entity exists in the world but not in WXYC's library — the
    // album isn't on hand. Leave NULL; if the album later lands in the
    // catalog, the next sweep links it.
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    const status = await processRow({ id: 7, artist_name: 'Stereolab', album_title: 'Dots and Loops' }, { lookup });

    expect(status).toBe('no_library_match');
    expect(findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i)).toBeUndefined();
  });

  it('enqueues a review row on a fallback hit without stamping flowsheet linkage', async () => {
    // Review-flagged rows roll forward to B-3.1's CLI. The orchestrator must
    // (a) persist them to flowsheet_linkage_review with the resolved library
    // candidates, and (b) NOT stamp flowsheet.album_id / linkage_source —
    // doing so would skip the human-review step entirely.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }]) // SELECT library for first candidate
      .mockResolvedValueOnce([]) // SELECT library for second candidate (no match locally)
      .mockResolvedValueOnce({ count: 1 }); // INSERT review row
    const lookup = jest.fn(() =>
      Promise.resolve({
        results: [
          { library_item: { id: 1 }, artwork: { release_id: 33 } },
          { library_item: { id: 2 }, artwork: { release_id: 44 } },
        ],
        search_type: 'fallback' as const,
      })
    );

    const status = await processRow({ id: 7, artist_name: 'Jessica Pratt', album_title: 'On Your Own' }, { lookup });

    expect(status).toBe('review');
    expect(findExecuteCallMatching(/UPDATE[\s\S]*flowsheet"\s/i)).toBeUndefined();
    const insertCall = findExecuteCallMatching(/INSERT[\s\S]*flowsheet_linkage_review/i);
    expect(insertCall).toBeDefined();
    const serialized = JSON.stringify(insertCall?.[0]);
    expect(serialized).toContain('7'); // flowsheet_id
    expect(serialized).toContain('100'); // resolved library_id from candidate 1
    expect(serialized).toContain('101');
  });

  it('enqueues a review row even when no candidate resolves to a local library row', async () => {
    // Empty candidate arrays are intentional: the operator can still see the
    // flowsheet text and skip the entry. Skipping the enqueue would silently
    // hide the case from the queue.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([]) // SELECT library for the only candidate
      .mockResolvedValueOnce({ count: 1 }); // INSERT review row
    const lookup = jest.fn(() =>
      Promise.resolve({
        results: [{ library_item: { id: 1 }, artwork: { release_id: 33 } }],
        search_type: 'fallback' as const,
      })
    );

    const status = await processRow({ id: 7, artist_name: 'Jessica Pratt', album_title: 'On Your Own' }, { lookup });

    expect(status).toBe('review');
    expect(findExecuteCallMatching(/INSERT[\s\S]*flowsheet_linkage_review/i)).toBeDefined();
  });

  it('reports no_match on an empty LML response without writing', async () => {
    const lookup = jest.fn(() => Promise.resolve(emptyResponse()));

    const status = await processRow({ id: 7, artist_name: 'Unknown', album_title: 'Unknown' }, { lookup });

    expect(status).toBe('no_match');
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });

  it('reports error on LML failure without writing (next sweep retries)', async () => {
    // Failure tolerance: an LML 5xx must not stamp the row, or it would be
    // removed from the retry pool and lose the eventual recovery.
    const lookup = jest.fn(() => Promise.reject(new Error('LML 502')));

    const status = await processRow({ id: 7, artist_name: 'Stereolab', album_title: 'Dots and Loops' }, { lookup });

    expect(status).toBe('error');
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe('runBackfill', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a sensible BATCH_SIZE (bounded reads — never SELECT *)', () => {
    // The flowsheet has ~1.18M unlinked rows. An unbounded SELECT would pin
    // a connection for an hour; a too-small batch would explode the
    // round-trip overhead per row.
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(50);
    expect(BATCH_SIZE).toBeLessThanOrEqual(2000);
  });

  it('throttles between LML calls (THROTTLE_MS > 0)', () => {
    // The throttle is what keeps a multi-day sweep from stampeding LML.
    // Dropping it to 0 risks blowing through LML's rate budget in seconds.
    expect(THROTTLE_MS).toBeGreaterThan(0);
  });

  it('selects only unlinked track rows that have artist+album text', async () => {
    // Issue scope: album_id IS NULL AND entry_type='track' AND artist_name
    // IS NOT NULL AND album_title IS NOT NULL. Plus the B-0.5 admission:
    // include broken-FK residuals (legacy_link_attempted_at IS NOT NULL)
    // alongside never-had-FK rows (legacy_release_id IS NULL).
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await runBackfill({ lookup: jest.fn(), throttleMs: 0 });

    const selectCall = findExecuteCallMatching(/SELECT[\s\S]*FROM[\s\S]*flowsheet/i);
    expect(selectCall).toBeDefined();
    const sqlText = renderSql(selectCall?.[0]);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/entry_type"?\s*=\s*'track'/i);
    expect(sqlText).toMatch(/artist_name"?\s+IS\s+NOT\s+NULL/i);
    expect(sqlText).toMatch(/album_title"?\s+IS\s+NOT\s+NULL/i);
    expect(sqlText).toMatch(/legacy_release_id"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/legacy_link_attempted_at"?\s+IS\s+NOT\s+NULL/i);
  });

  it('paginates forward by id (last-id cursor restartable across batches)', async () => {
    // Without `id > $lastId` the second loadBatch re-scans the same rows
    // forever — the WHERE filter on album_id IS NULL still matches a row
    // we just left as review (no album_id stamp).
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
      ])
      // both rows fall through to no_match (no DB writes)
      .mockResolvedValueOnce([]);
    const lookup = jest.fn(() => Promise.resolve(emptyResponse()));

    await runBackfill({ lookup, throttleMs: 0 });

    const selectCalls = (db.execute as jest.Mock).mock.calls
      .map((c) => renderSql(c[0]))
      .filter((s) => /SELECT[\s\S]*FROM[\s\S]*flowsheet/i.test(s));
    expect(selectCalls.length).toBe(2);
    const secondSelectSerialized = JSON.stringify(
      (db.execute as jest.Mock).mock.calls.filter((c) =>
        /SELECT[\s\S]*FROM[\s\S]*flowsheet/i.test(renderSql(c[0]))
      )[1]?.[0]
    );
    expect(secondSelectSerialized).toContain('2');
  });

  it('exits cleanly on the first empty batch (already-backfilled state)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    const lookup = jest.fn();

    const result = await runBackfill({ lookup, throttleMs: 0 });

    expect(lookup).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(0);
  });

  it('counts each outcome separately for the run report', async () => {
    // The summary the operator sees is what tells us whether B-3.1's review
    // queue is going to have anything in it. Per-outcome counts are the
    // whole point of running the job.
    (db.execute as jest.Mock)
      // batch 1
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
        { id: 3, artist_name: 'c', album_title: 'c' },
        { id: 4, artist_name: 'd', album_title: 'd' },
        { id: 5, artist_name: 'e', album_title: 'e' },
      ])
      // row 1 — auto_accept, library has one match
      .mockResolvedValueOnce([{ id: 100 }])
      .mockResolvedValueOnce({ count: 1 })
      // row 2 — auto_accept, library has zero matches
      .mockResolvedValueOnce([])
      // row 3 — auto_accept, library has two matches → tie-break picks 201, link
      .mockResolvedValueOnce([{ id: 200 }, { id: 201 }])
      .mockResolvedValueOnce({ count: 1 }) // row 3 applyLink after tie-break picks 201
      // row 4 — review (fallback): SELECT library for the one candidate +
      // INSERT into flowsheet_linkage_review
      .mockResolvedValueOnce([{ id: 300 }])
      .mockResolvedValueOnce({ count: 1 })
      // row 5 — no_match (empty results — no DB writes)
      // batch 2 — empty
      .mockResolvedValueOnce([]);

    (pickPrimaryLibraryRow as jest.Mock).mockResolvedValueOnce(201);

    let call = 0;
    const lookup = jest.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(directResponse(111));
      if (call === 2) return Promise.resolve(directResponse(222));
      if (call === 3) return Promise.resolve(directResponse(333));
      if (call === 4) return Promise.resolve(fallbackResponse(444));
      return Promise.resolve(emptyResponse());
    });

    const result = await runBackfill({ lookup, throttleMs: 0 });

    // Two linked: the single-match (row 1) and the tie-break-picked (row 3).
    expect(result.totals.linked).toBe(2);
    expect(result.totals.no_library_match).toBe(1);
    expect(result.totals.review).toBe(1);
    expect(result.totals.no_match).toBe(1);
    expect(result.totals.error).toBe(0);
    expect(result.totals.scanned).toBe(5);
  });

  it('keeps going when a single row errors (failure-tolerant — does not abort the run)', async () => {
    // One LML failure must not poison the run. The error count goes up; the
    // scan continues. The errored row stays NULL and gets retried on the
    // next sweep.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
      ])
      .mockResolvedValueOnce([{ id: 100 }]) // SELECT library for row 2
      .mockResolvedValueOnce({ count: 1 }) // UPDATE flowsheet for row 2
      .mockResolvedValueOnce([]);

    let call = 0;
    const lookup = jest.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('LML 502'));
      return Promise.resolve(directResponse(222));
    });

    const result = await runBackfill({ lookup, throttleMs: 0 });

    expect(result.totals.error).toBe(1);
    expect(result.totals.linked).toBe(1);
    expect(result.totals.scanned).toBe(2);
  });
});
