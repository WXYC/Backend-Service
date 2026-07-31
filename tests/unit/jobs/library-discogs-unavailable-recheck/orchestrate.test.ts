/**
 * Unit tests for jobs/library-discogs-unavailable-recheck orchestrate.ts
 * (BS#1283). Drives `runRecheck` with injected deps — no live DB or LML.
 *
 * Covers issue tests 3 (low-confidence match) and 4 (miss), plus the
 * lml_error / db_error / raced isolation properties mirrored from the
 * sibling `rotation-release-id-backfill` orchestrator.
 */
import { jest } from '@jest/globals';

import {
  CONFIDENCE_FLOOR,
  runRecheck,
  type Candidate,
  type LookupOutcome,
} from '../../../../jobs/library-discogs-unavailable-recheck/orchestrate';

const candidate: Candidate = { id: 42, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' };

describe('runRecheck', () => {
  test('confidence floor is 0.95', () => {
    expect(CONFIDENCE_FLOOR).toBe(0.95);
  });

  test('high-confidence match: writes and counts matched (issue test 2 path)', async () => {
    const lookup = jest.fn<() => Promise<LookupOutcome>>().mockResolvedValue({
      kind: 'match',
      releaseId: 99999,
      confidence: 0.98,
    });
    const writeMatch = jest.fn().mockResolvedValue({ written: true, rotationRowsUpdated: 1 });
    const stamp = jest.fn().mockResolvedValue({ written: true });
    const recordLowConfidence = jest.fn();

    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate]),
      lookup,
      writeMatch,
      stamp,
      recordLowConfidence,
    });

    expect(writeMatch).toHaveBeenCalledWith(42, 99999);
    expect(stamp).not.toHaveBeenCalled();
    expect(recordLowConfidence).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ scanned: 1, matched: 1, low_confidence: 0, no_match: 0 });
  });

  test('low-confidence match (issue test 3): no write, Sentry counter fires, timestamp stamped', async () => {
    const lookup = jest.fn<() => Promise<LookupOutcome>>().mockResolvedValue({
      kind: 'match',
      releaseId: 55555,
      confidence: 0.85,
    });
    const writeMatch = jest.fn();
    const stamp = jest.fn().mockResolvedValue({ written: true });
    const recordLowConfidence = jest.fn();

    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate]),
      lookup,
      writeMatch,
      stamp,
      recordLowConfidence,
    });

    expect(writeMatch).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledWith(42);
    expect(recordLowConfidence).toHaveBeenCalledWith({
      libraryId: 42,
      artistName: 'Jessica Pratt',
      albumTitle: 'On Your Own Love Again',
      confidence: 0.85,
    });
    expect(totals).toMatchObject({ scanned: 1, matched: 0, low_confidence: 1, no_match: 0 });
  });

  test('a match exactly at the floor (0.95) counts as high-confidence, not low-confidence', async () => {
    const lookup = jest.fn<() => Promise<LookupOutcome>>().mockResolvedValue({
      kind: 'match',
      releaseId: 1,
      confidence: 0.95,
    });
    const writeMatch = jest.fn().mockResolvedValue({ written: true, rotationRowsUpdated: 1 });
    const stamp = jest.fn().mockResolvedValue({ written: true });

    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate]),
      lookup,
      writeMatch,
      stamp,
      recordLowConfidence: jest.fn(),
    });

    expect(writeMatch).toHaveBeenCalledWith(42, 1);
    expect(totals.matched).toBe(1);
    expect(totals.low_confidence).toBe(0);
  });

  test('miss (issue test 4): only the timestamp is stamped', async () => {
    const lookup = jest.fn<() => Promise<LookupOutcome>>().mockResolvedValue({ kind: 'no_match' });
    const writeMatch = jest.fn();
    const stamp = jest.fn().mockResolvedValue({ written: true });
    const recordLowConfidence = jest.fn();

    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate]),
      lookup,
      writeMatch,
      stamp,
      recordLowConfidence,
    });

    expect(writeMatch).not.toHaveBeenCalled();
    expect(recordLowConfidence).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledWith(42);
    expect(totals).toMatchObject({ scanned: 1, matched: 0, low_confidence: 0, no_match: 1 });
  });

  test('isolates a thrown LML lookup to lml_error and leaves the row unstamped (retryable)', async () => {
    const lookup = jest.fn<() => Promise<LookupOutcome>>().mockRejectedValue(new Error('LML timeout'));
    const stamp = jest.fn();

    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate]),
      lookup,
      writeMatch: jest.fn(),
      stamp,
      recordLowConfidence: jest.fn(),
    });

    expect(stamp).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ scanned: 1, lml_error: 1, matched: 0, low_confidence: 0, no_match: 0 });
  });

  test('isolates a thrown DB write to db_error without aborting the batch', async () => {
    const lookup = jest
      .fn<() => Promise<LookupOutcome>>()
      .mockResolvedValueOnce({ kind: 'match', releaseId: 1, confidence: 0.99 })
      .mockResolvedValueOnce({ kind: 'no_match' });
    const writeMatch = jest.fn().mockRejectedValue(new Error('connection reset'));
    const stamp = jest.fn().mockResolvedValue({ written: true });

    const second: Candidate = { id: 43, artist_name: 'Cat Power', album_title: 'Moon Pix' };
    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate, second]),
      lookup,
      writeMatch,
      stamp,
      recordLowConfidence: jest.fn(),
    });

    expect(totals).toMatchObject({ scanned: 2, db_error: 1, matched: 0, no_match: 1 });
    expect(stamp).toHaveBeenCalledWith(43);
  });

  test('surfaces a raced write (0 rows affected) distinctly from a successful write', async () => {
    const lookup = jest.fn<() => Promise<LookupOutcome>>().mockResolvedValue({
      kind: 'match',
      releaseId: 1,
      confidence: 0.99,
    });
    const writeMatch = jest.fn().mockResolvedValue({ written: false, rotationRowsUpdated: 0 });

    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([candidate]),
      lookup,
      writeMatch,
      stamp: jest.fn(),
      recordLowConfidence: jest.fn(),
    });

    expect(totals).toMatchObject({ scanned: 1, matched: 0, raced: 1 });
  });

  test('cadence (issue test 6): an empty candidate list is a no-op', async () => {
    const { totals } = await runRecheck({
      loadCandidates: () => Promise.resolve([]),
      lookup: jest.fn(),
      writeMatch: jest.fn(),
      stamp: jest.fn(),
      recordLowConfidence: jest.fn(),
    });

    expect(totals).toMatchObject({ scanned: 0, matched: 0, low_confidence: 0, no_match: 0 });
  });
});
