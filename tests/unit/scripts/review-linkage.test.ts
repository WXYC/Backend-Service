/**
 * Unit tests for the B-3.1 manual review CLI core.
 *
 * The CLI itself is interactive, so the IO loop isn't unit-tested here —
 * what we pin is the three DB operations that drive every accept / reject
 * decision. They have to be exact: a typo in the linkage_source string
 * would silently misclassify human-review links as ETL links, and missing
 * the album_id IS NULL guard would let the CLI clobber a row a parallel
 * forward-path link just stamped.
 *
 *   - loadNextReviewCase  → SELECT against flowsheet_linkage_review joined
 *                            to flowsheet (and library for each candidate),
 *                            scoped to unreviewed rows in created_at order.
 *   - acceptReviewCase    → UPDATE flowsheet (album_id + linkage_source +
 *                            linkage_confidence + linked_at) AND mark the
 *                            review row reviewed.
 *   - rejectReviewCase    → mark the review row reviewed without touching
 *                            the flowsheet row.
 */

import { db } from '@wxyc/database';
import {
  loadNextReviewCase,
  acceptReviewCase,
  rejectReviewCase,
} from '../../../scripts/review-linkage';

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

describe('loadNextReviewCase', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('selects unreviewed rows in created_at order and returns the first', async () => {
    // The CLI presents one case at a time. It has to pick the oldest
    // unreviewed row so the queue drains in arrival order; selecting
    // arbitrarily would make it possible for some rows to languish forever
    // while newer rows keep cycling to the front.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 1,
          flowsheet_id: 7,
          candidate_library_ids: [100, 101],
          candidate_confidences: [0.5, 0.5],
          suggested_action: 'review_fallback',
          flowsheet_artist: 'Jessica Pratt',
          flowsheet_album: 'On Your Own',
          flowsheet_track: 'Back, Baby',
        },
      ])
      .mockResolvedValueOnce([
        { id: 100, artist_name: 'Jessica Pratt', album_title: 'Quiet Signs' },
        { id: 101, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
      ]);

    const next = await loadNextReviewCase();

    expect(next).not.toBeNull();
    expect(next?.reviewId).toBe(1);
    expect(next?.flowsheetId).toBe(7);
    expect(next?.candidates).toHaveLength(2);
    expect(next?.candidates[0]).toMatchObject({
      libraryId: 100,
      artistName: 'Jessica Pratt',
      confidence: 0.5,
    });
    const selectCall = findExecuteCallMatching(/SELECT[\s\S]*flowsheet_linkage_review/i);
    const sqlText = renderSql(selectCall?.[0]);
    expect(sqlText).toMatch(/reviewed_at"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/ORDER\s+BY[\s\S]*created_at/i);
    expect(sqlText).toMatch(/LIMIT\s+1/i);
  });

  it('returns null when the queue is empty', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    const next = await loadNextReviewCase();

    expect(next).toBeNull();
  });

  it('excludes review ids passed in (operator-skipped within the session)', async () => {
    // "skip" doesn't mark the row reviewed — we just don't want to keep
    // re-showing it for the duration of the CLI session.
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadNextReviewCase([1, 2, 3]);

    const selectCall = findExecuteCallMatching(/SELECT[\s\S]*flowsheet_linkage_review/i);
    const serialized = JSON.stringify(selectCall?.[0]);
    expect(serialized).toContain('1');
    expect(serialized).toContain('2');
    expect(serialized).toContain('3');
  });
});

describe('acceptReviewCase', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it("stamps album_id, linkage_source='human_review', linked_at on the flowsheet row", async () => {
    // The audit columns are how analytics distinguishes human-curated links
    // from heuristic ones. linkage_source must be 'human_review' verbatim.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ count: 1 }) // UPDATE flowsheet
      .mockResolvedValueOnce({ count: 1 }); // UPDATE review row

    await acceptReviewCase({ reviewId: 1, flowsheetId: 7, libraryId: 100 });

    const flowsheetUpdate = findExecuteCallMatching(/UPDATE[\s\S]*"flowsheet"[\s\S]*album_id/i);
    expect(flowsheetUpdate).toBeDefined();
    const sqlText = renderSql(flowsheetUpdate?.[0]);
    expect(sqlText).toMatch(/album_id"?\s*=/i);
    expect(sqlText).toMatch(/linkage_source"?\s*=\s*'human_review'/i);
    expect(sqlText).toMatch(/linked_at"?\s*=\s*now\(\)/i);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NULL/i);
  });

  it("marks the review row reviewed_at=now(), reviewed_decision='accepted'", async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await acceptReviewCase({ reviewId: 1, flowsheetId: 7, libraryId: 100 });

    const reviewUpdate = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet_linkage_review/i);
    expect(reviewUpdate).toBeDefined();
    const sqlText = renderSql(reviewUpdate?.[0]);
    expect(sqlText).toMatch(/reviewed_at"?\s*=\s*now\(\)/i);
    expect(sqlText).toMatch(/reviewed_decision"?\s*=\s*'accepted'/i);
  });
});

describe('rejectReviewCase', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it("marks the review row reviewed without touching the flowsheet row", async () => {
    // Reject = "this isn't the right album". The flowsheet row's album_id
    // stays NULL so a future LML improvement can pick it up; only the
    // review-queue row is marked done.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await rejectReviewCase(1);

    const reviewUpdate = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet_linkage_review/i);
    expect(reviewUpdate).toBeDefined();
    const sqlText = renderSql(reviewUpdate?.[0]);
    expect(sqlText).toMatch(/reviewed_decision"?\s*=\s*'rejected'/i);
    expect(findExecuteCallMatching(/UPDATE[\s\S]*"flowsheet"[\s\S]*album_id/i)).toBeUndefined();
  });
});
