/**
 * Pins `buildReleaseGroup` and `CLEAR_RELEASE_GROUP` in `@wxyc/metadata` (BS#3791) with literal values, so the
 * mapping the re-ask (BS#3137) and the release picker (BS#3790) write through has coverage of its own, independent of
 * either caller's tests.
 */

import { describe, it, expect } from '@jest/globals';
import { CLEAR_RELEASE_GROUP, buildReleaseGroup } from '@wxyc/metadata';

const FALLBACKS = { artist: 'Jessica Pratt', album: 'On Your Own Love Again' };
const RELEASE_URL = 'https://www.discogs.com/release/6150';

const lookup = (artwork: Record<string, unknown> | undefined) =>
  ({
    search_type: 'direct',
    results: artwork === undefined ? [] : [{ library_item: { id: 1002, title: 'On Your Own Love Again' }, artwork }],
  }) as never;

describe('buildReleaseGroup', () => {
  it.each<[string, Record<string, unknown> | undefined, Record<string, unknown>]>([
    [
      'a full answer',
      {
        release_id: 6150,
        release_url: RELEASE_URL,
        artwork_url: 'https://i.discogs.com/6150.jpg',
        release_year: 2015,
        label: 'Drag City',
        full_release_date: '2015-01-27',
        genres: ['Rock'],
        styles: ['Folk'],
        tracklist: [{ position: 'A1', title: 'Back, Baby' }],
      },
      {
        discogs_url: RELEASE_URL,
        artwork_url: 'https://i.discogs.com/6150.jpg',
        release_year: 2015,
        label: 'Drag City',
        full_release_date: '2015-01-27',
        genres: ['Rock'],
        styles: ['Folk'],
        tracklist: [{ position: 'A1', title: 'Back, Baby' }],
      },
    ],
    [
      'an answer with no extended fields (each one NULL)',
      { release_id: 6150, release_url: RELEASE_URL },
      { ...CLEAR_RELEASE_GROUP, discogs_url: RELEASE_URL },
    ],
    [
      'a coverless answer with year 0 (both NULL)',
      { release_id: 6150, release_url: RELEASE_URL, artwork_url: 'https://s.discogs.com/spacer.gif', release_year: 0 },
      { ...CLEAR_RELEASE_GROUP, discogs_url: RELEASE_URL },
    ],
    ['no result (all NULL)', undefined, CLEAR_RELEASE_GROUP],
  ])('maps %s', (_label, artwork, expected) => {
    expect(buildReleaseGroup(lookup(artwork), FALLBACKS)).toEqual(expected);
  });
});

describe('CLEAR_RELEASE_GROUP', () => {
  it('is every release-group column, all NULL, and frozen', () => {
    expect(CLEAR_RELEASE_GROUP).toEqual({
      discogs_url: null,
      artwork_url: null,
      release_year: null,
      label: null,
      full_release_date: null,
      genres: null,
      styles: null,
      tracklist: null,
    });
    expect(Object.isFrozen(CLEAR_RELEASE_GROUP)).toBe(true);
  });
});
