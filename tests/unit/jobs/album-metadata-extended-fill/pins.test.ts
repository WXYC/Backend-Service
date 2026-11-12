/**
 * The release-pin gate (BS#1442 scope addition): a row whose stored release
 * disagrees with LML's hand-verified pin (`lml_cache.library_release_override`)
 * is settled as `pin_disagrees` and never filled, since the stored release's
 * tracklist and label would be the wrong record's. Re-resolving it is BS#3137's.
 *
 * Pins are keyed by `library.legacy_release_id`, one call per batch.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { PinnedTracklist, PinnedTracklistsResult } from '@wxyc/lml-client';
import type { FillCandidate } from '../../../../jobs/album-metadata-extended-fill/cohort';
import type { Fetched } from '../../../../jobs/album-metadata-extended-fill/fetch';
import { checkPin, lookupBatchPins } from '../../../../jobs/album-metadata-extended-fill/pins';

const pin = (discogs_release_id: number): PinnedTracklist => ({
  discogs_release_id,
  source: 'alex-2026-10',
  in_cache: true,
  tracks: [],
});

const candidate = (album_id: number, legacy_release_id: number | null): FillCandidate => ({
  album_id,
  discogs_url: `https://www.discogs.com/release/${album_id}`,
  has_bio: true,
  has_wikipedia_url: false,
  missing: ['tracklist'],
  legacy_release_id,
});

describe('checkPin', () => {
  it.each([
    ['no legacy id, so no pin was asked for', 36792451, undefined, 'proceed'],
    ['the row has no pin', 36792451, { ok: true, pin: null }, 'proceed'],
    ['the pin names the stored release', 530321, { ok: true, pin: pin(530321) }, 'proceed'],
    // Library 30342 (legacy 39541) stores 36792451; the pin is 530321.
    ['the pin names a different release', 36792451, { ok: true, pin: pin(530321) }, 'pin_disagrees'],
    ['the pins call went unanswered', 36792451, { ok: false, status: 502 }, 'pin_unanswered'],
  ] as const)('%s -> %s', (_label, storedReleaseId, lookup, expected) => {
    expect(checkPin(storedReleaseId, lookup)).toBe(expected);
  });
});

describe('lookupBatchPins', () => {
  const pinsFetcher = (answer: Fetched<PinnedTracklistsResult[]>) => ({
    pins: jest.fn((ids: number[]) => {
      void ids;
      return Promise.resolve(answer);
    }),
  });

  it('asks once for the batch, sending only the non-null legacy ids, and keys the answers per album', async () => {
    const lml = pinsFetcher({
      ok: true,
      value: [
        { legacy_release_id: 39541, pin: pin(530321) },
        { legacy_release_id: 1442, pin: null },
      ],
    });

    const lookups = await lookupBatchPins([candidate(30342, 39541), candidate(2, null), candidate(3, 1442)], lml);

    expect(lml.pins).toHaveBeenCalledTimes(1);
    expect(lml.pins).toHaveBeenCalledWith([39541, 1442]);
    expect(lookups.get(30342)).toEqual({ ok: true, pin: pin(530321) });
    expect(lookups.get(2)).toBeUndefined();
    expect(lookups.get(3)).toEqual({ ok: true, pin: null });
  });

  it('makes no call when no album in the batch has a legacy id', async () => {
    const lml = pinsFetcher({ ok: true, value: [] });

    expect((await lookupBatchPins([candidate(1, null)], lml)).size).toBe(0);
    expect(lml.pins).not.toHaveBeenCalled();
  });

  it.each([502, 504])('marks every album with a legacy id unanswered when the call fails with %s', async (status) => {
    const lookups = await lookupBatchPins(
      [candidate(1, 11), candidate(2, null), candidate(3, 33)],
      pinsFetcher({ ok: false, status })
    );

    expect(lookups.get(1)).toEqual({ ok: false, status });
    expect(lookups.get(3)).toEqual({ ok: false, status });
    expect(lookups.get(2)).toBeUndefined();
  });
});
