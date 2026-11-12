/**
 * The BS#1442 `--execute` loop: every album through the real `fillAlbum`, one
 * pins call per batch, the per-album aborts, ANALYZE after any run that wrote
 * (aborts included), and a `next_run` that carries the unsettled albums and the
 * first-404 ids however the run ends.
 *
 * The UPDATE and the ANALYZE are mocked; their SQL runs on a real PostgreSQL
 * in the integration specs.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../../jobs/album-metadata-extended-fill/write', () => ({
  writeFill: jest.fn(),
  analyzeAlbumMetadata: jest.fn(),
}));

import type { DiscogsReleaseMetadata } from '@wxyc/lml-client';
import type { FillCandidate } from '../../../../jobs/album-metadata-extended-fill/cohort';
import {
  FillAbortError,
  executeFill,
  type ExecuteOptions,
  type ExecuteSummary,
} from '../../../../jobs/album-metadata-extended-fill/execute';
import type { Fetched, LmlFetcher } from '../../../../jobs/album-metadata-extended-fill/fetch';
import { EXTENDED_COLUMNS } from '../../../../jobs/album-metadata-extended-fill/map';
import * as write from '../../../../jobs/album-metadata-extended-fill/write';

const writeFill = write.writeFill as unknown as jest.Mock<(...args: unknown[]) => Promise<string[] | null>>;
const analyze = write.analyzeAlbumMetadata as unknown as jest.Mock<() => Promise<void>>;

// Album n stores release 1000 + n. No artist id, so no artist calls unless a test adds one.
const release = (id: number, extra: object = {}) =>
  ({
    release_id: id,
    tracklist: [{ position: 'A1', title: 'x', artists: [] }],
    cached: true,
    ...extra,
  }) as unknown as DiscogsReleaseMetadata;

const candidates = (...ids: number[]): FillCandidate[] =>
  ids.map((id) => ({
    album_id: id,
    discogs_url: `https://www.discogs.com/release/${1000 + id}`,
    has_bio: true,
    has_wikipedia_url: false,
    missing: ['tracklist'],
    legacy_release_id: null,
  }));

/** A fetcher answering each release id with `answers[id]`, or a 200 by default. */
const fetcher = (answers: Record<number, Fetched<DiscogsReleaseMetadata>> = {}) => {
  const releaseFn: LmlFetcher['release'] = (id) => Promise.resolve(answers[id] ?? { ok: true, value: release(id) });
  const artistFn: LmlFetcher['artist'] = () => Promise.resolve({ ok: false, status: 404 });
  // One null pin per id, in order, as LML answers.
  const pinsFn: LmlFetcher['pins'] = (ids) =>
    Promise.resolve({ ok: true, value: ids.map((id) => ({ legacy_release_id: id, pin: null })) });
  return { release: jest.fn(releaseFn), artist: jest.fn(artistFn), pins: jest.fn(pinsFn), calls: () => 0 };
};

const OPTIONS: ExecuteOptions = {
  afterAlbumId: 0,
  albumIds: [],
  maxAlbums: 2400,
  notFoundReleaseIds: [],
  notFoundArtistIds: [],
  limits: { maxConsecutiveUnanswered: 3, maxConsecutiveNotFound: 3, maxConsecutiveWriteFailures: 3 },
};
const control = (shouldStop = () => false) => ({ shouldStop, onProgress: jest.fn<(s: ExecuteSummary) => void>() });

beforeEach(() => {
  jest.clearAllMocks();
  // The row after the UPDATE: every column set.
  writeFill.mockResolvedValue([...EXTENDED_COLUMNS]);
  analyze.mockResolvedValue(undefined);
});

describe('executeFill', () => {
  it('fills each album, moves the cursor past the last, reaches the end under the cap, and ANALYZEs', async () => {
    const summary = await executeFill(candidates(1, 2, 3), fetcher(), OPTIONS, control());

    expect(writeFill).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      processed: 3,
      outcomes: { filled: 3 },
      filled_by_column: { tracklist: 3 },
      last_album_id: 3,
      reached_end: true,
      stopped_early: false,
      next_run: {
        EXTENDED_FILL_ALBUM_AFTER_ID: 3,
        EXTENDED_FILL_ALBUM_IDS: '',
        EXTENDED_FILL_NOT_FOUND_RELEASE_IDS: '',
        EXTENDED_FILL_NOT_FOUND_ARTIST_IDS: '',
      },
    });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('does not ANALYZE a run that wrote nothing', async () => {
    writeFill.mockResolvedValue(null);

    await executeFill(candidates(1), fetcher(), OPTIONS, control());

    expect(analyze).not.toHaveBeenCalled();
  });

  it('a run that used its whole cap has not reached the end', async () => {
    const summary = await executeFill(candidates(1, 2), fetcher(), { ...OPTIONS, maxAlbums: 2 }, control());

    expect(summary.reached_end).toBe(false);
  });

  it('carries an unanswered album and a first 404 as the list, and the 404 release id for the next run', async () => {
    const lml = fetcher({ 1002: { ok: false, status: 502 }, 1003: { ok: false, status: 404 } });

    const summary = await executeFill(candidates(1, 2, 3, 4), lml, OPTIONS, control());

    expect(summary.next_run).toEqual({
      EXTENDED_FILL_ALBUM_AFTER_ID: 4,
      EXTENDED_FILL_ALBUM_IDS: '2,3',
      EXTENDED_FILL_NOT_FOUND_RELEASE_IDS: '1003',
      EXTENDED_FILL_NOT_FOUND_ARTIST_IDS: '',
    });
    expect(summary.resume_after_album_id).toBe(1);
  });

  it('a listed release that 404s again settles and leaves the lists; one never asked stays listed', async () => {
    const lml = fetcher({ 1003: { ok: false, status: 404 } });

    const summary = await executeFill(
      candidates(3),
      lml,
      { ...OPTIONS, albumIds: [3], notFoundReleaseIds: [1003, 1009] },
      control()
    );

    expect(summary.outcomes.release_not_found).toBe(1);
    // A retry run that left nothing has no next run.
    expect(summary.next_run).toBeNull();
    expect(summary.reached_end).toBe(true);
  });

  it('carries an artist 404 id for the next run while still writing the release columns', async () => {
    const lml = fetcher({ 1001: { ok: true, value: release(1001, { artist_id: 82730 }) } });

    // The artist is asked only for a row that still lacks an artist column.
    const missingArtist = candidates(1).map((c) => ({
      ...c,
      missing: ['tracklist' as const, 'artist_image_url' as const],
    }));

    const summary = await executeFill(missingArtist, lml, OPTIONS, control());

    expect(summary.outcomes.filled).toBe(1);
    expect(summary.next_run).toMatchObject({
      EXTENDED_FILL_ALBUM_IDS: '1',
      EXTENDED_FILL_NOT_FOUND_ARTIST_IDS: '82730',
    });
  });

  it.each([
    ['unanswered', { ok: false, status: 504 }, 'lml_unanswered'],
    ['404', { ok: false, status: 404 }, 'release_not_found'],
  ] as const)(
    'aborts after 3 %s releases in a row, ANALYZEs what it wrote, and carries them',
    async (_l, answer, trip) => {
      const lml = fetcher({ 1002: answer, 1003: answer, 1004: answer });

      const error = await executeFill(candidates(1, 2, 3, 4, 5), lml, OPTIONS, control()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FillAbortError);
      const { summary } = error as FillAbortError;
      expect((error as FillAbortError).trip).toBe(trip);
      expect(summary).toMatchObject({
        processed: 4,
        abort: trip,
        stopped_early: true,
        reached_end: false,
        next_run: { EXTENDED_FILL_ALBUM_AFTER_ID: 4, EXTENDED_FILL_ALBUM_IDS: '2,3,4' },
      });
      expect(analyze).toHaveBeenCalledTimes(1);
    }
  );

  it('aborts after 3 failed writes in a row and carries them', async () => {
    writeFill.mockRejectedValue(new Error('connection refused'));

    const error = (await executeFill(candidates(1, 2, 3, 4), fetcher(), OPTIONS, control()).catch(
      (e: unknown) => e
    )) as FillAbortError;

    expect(error.trip).toBe('write_failed');
    expect(error.summary.next_run?.EXTENDED_FILL_ALBUM_IDS).toBe('1,2,3');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('a stop request ends the run before the next album, with next_run current', async () => {
    const lml = fetcher();

    const summary = await executeFill(
      candidates(1, 2, 3),
      lml,
      OPTIONS,
      control(() => lml.release.mock.calls.length >= 1)
    );

    expect(summary).toMatchObject({ processed: 1, stopped_early: true, reached_end: false });
    expect(summary.next_run?.EXTENDED_FILL_ALBUM_AFTER_ID).toBe(1);
  });

  it('asks for pins once per batch of 100, before the batch', async () => {
    const lml = fetcher();
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);

    await executeFill(
      candidates(...ids).map((c) => ({ ...c, legacy_release_id: c.album_id })),
      lml,
      OPTIONS,
      control()
    );

    expect(lml.pins).toHaveBeenCalledTimes(2);
  });
});
