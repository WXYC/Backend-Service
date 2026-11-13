/**
 * The release-group mapping lives in `@wxyc/metadata` (BS#3791), so the
 * release picker (BS#3790) writes `album_metadata` through the same code as
 * the re-ask (BS#3137). The mapping's behaviour is pinned by the re-ask's own
 * `payload.test.ts`, unchanged by the move; this file pins that the re-ask
 * really uses the shared copy rather than keeping its own.
 */

import { describe, it, expect } from '@jest/globals';
import { CLEAR_RELEASE_GROUP as SHARED_CLEAR, buildReleaseGroup } from '@wxyc/metadata';
import { CLEAR_RELEASE_GROUP, buildPayload } from '../../../../jobs/album-metadata-reask/payload';

const FALLBACKS = { artist: 'Jessica Pratt', album: 'On Your Own Love Again' };

const lookup = (artwork: Record<string, unknown> | undefined) =>
  ({
    search_type: 'direct',
    results: artwork === undefined ? [] : [{ library_item: { id: 1002, title: 'On Your Own Love Again' }, artwork }],
  }) as never;

describe('release group in @wxyc/metadata', () => {
  it('is the clear group the re-ask writes', () => {
    expect(CLEAR_RELEASE_GROUP).toBe(SHARED_CLEAR);
  });

  it.each([
    [
      'a full answer',
      {
        release_id: 6150,
        release_url: 'https://www.discogs.com/release/6150',
        artwork_url: 'https://i.discogs.com/6150.jpg',
        release_year: 2015,
        label: 'Drag City',
        full_release_date: '2015-01-27',
        genres: ['Rock'],
        styles: ['Folk'],
        tracklist: [{ position: 'A1', title: 'Back, Baby' }],
      },
    ],
    ['an answer with no extended fields', { release_id: 6150, release_url: 'https://www.discogs.com/release/6150' }],
    [
      'a coverless answer with year 0',
      {
        release_id: 6150,
        release_url: 'https://www.discogs.com/release/6150',
        artwork_url: 'https://s.discogs.com/spacer.gif',
        release_year: 0,
      },
    ],
    ['no result', undefined],
  ])('maps %s exactly as the re-ask payload does', (_label, artwork) => {
    expect(buildReleaseGroup(lookup(artwork), FALLBACKS)).toEqual(buildPayload(lookup(artwork), FALLBACKS).release);
  });
});
