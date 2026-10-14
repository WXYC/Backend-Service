/**
 * The re-ask's write payload (BS#3143): the release group written as a unit
 * (nulls included), the all-NULL `clear` release group, the artist group, and
 * the decision-8 artist rule for a healthy rebind answer.
 *
 * Runs against the REAL `normalizeLookup` (the unit config maps
 * `@wxyc/metadata` to source), so the bio is cleaned exactly as the
 * enrichment worker cleans it.
 *
 * @see WXYC/Backend-Service#3137 ("What is rewritten")
 */

import { describe, it, expect } from '@jest/globals';
import {
  CLEAR_RELEASE_GROUP,
  buildPayload,
  mergeArtistGroup,
  type ArtistGroup,
} from '../../../../jobs/album-metadata-reask/payload';

const FALLBACKS = { artist: 'Juana Molina', album: 'DOGA' };

const lookup = (artwork: Record<string, unknown>) =>
  ({
    search_type: 'direct',
    results: [
      {
        library_item: { id: 1001, title: 'DOGA' },
        artwork: { release_id: 4101, release_url: 'https://www.discogs.com/release/4101', ...artwork },
      },
    ],
  }) as never;

describe('buildPayload', () => {
  it('maps every release- and artist-group field of a full answer', () => {
    const tracklist = [{ position: 'A1', title: 'la paradoja' }];
    const tokens = [{ type: 'text', text: 'Argentine singer.' }];

    expect(
      buildPayload(
        lookup({
          artwork_url: 'https://i.discogs.com/4101.jpg',
          release_year: 2008,
          label: 'Sonamos',
          full_release_date: '2008-05-12',
          genres: ['Rock'],
          styles: ['Folk'],
          tracklist,
          discogs_artist_id: 61025,
          artist_bio: 'Argentine singer from [a=Buenos Aires].',
          wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
          artist_image_url: 'https://i.discogs.com/a61025.jpg',
          profile_tokens: tokens,
        }),
        FALLBACKS
      )
    ).toEqual({
      release: {
        discogs_url: 'https://www.discogs.com/release/4101',
        artwork_url: 'https://i.discogs.com/4101.jpg',
        release_year: 2008,
        label: 'Sonamos',
        full_release_date: '2008-05-12',
        genres: ['Rock'],
        styles: ['Folk'],
        tracklist,
      },
      artist: {
        discogs_artist_id: 61025,
        artist_bio: 'Argentine singer from Buenos Aires.',
        artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
        artist_image_url: 'https://i.discogs.com/a61025.jpg',
        bio_tokens: tokens,
      },
    });
  });

  it.each([
    ['the spacer GIF', { artwork_url: 'https://st.discogs.com/images/spacer.gif' }, { artwork_url: null }],
    ['release year 0', { release_year: 0 }, { release_year: null }],
  ])('writes NULL for %s', (_label, artwork, expected) => {
    expect(buildPayload(lookup(artwork), FALLBACKS).release).toMatchObject(expected);
  });

  it('writes every release- and artist-group column, nulls included, and nothing else', () => {
    // The release group moves as a unit: a column the answer lacks (including
    // the cover, decision 3) is written NULL, never left holding the old
    // release's value. Streaming columns are never in the payload: LML
    // resolves them per catalog row, not per release. `toEqual` pins the keys.
    const { release, artist } = buildPayload(lookup({}), FALLBACKS);

    expect(release).toEqual({
      discogs_url: 'https://www.discogs.com/release/4101',
      artwork_url: null,
      release_year: null,
      label: null,
      full_release_date: null,
      genres: null,
      styles: null,
      tracklist: null,
    });
    expect(artist).toEqual({
      discogs_artist_id: null,
      artist_bio: null,
      artist_wikipedia_url: null,
      artist_image_url: null,
      bio_tokens: null,
    });
  });
});

describe('CLEAR_RELEASE_GROUP', () => {
  it('is every release-group column, all NULL', () => {
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
  });
});

describe('mergeArtistGroup (decision 8, with "same release" false: a rebind always changes the release)', () => {
  const STORED_ID = 61025;
  const OTHER_ID = 99999;
  const stored = (discogs_artist_id: number | null): ArtistGroup => ({
    discogs_artist_id,
    artist_bio: 'Stored bio.',
    artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Stereolab',
    artist_image_url: 'https://i.discogs.com/stored.jpg',
    bio_tokens: [{ type: 'text', text: 'Stored bio.' }],
  });
  const nullAnswer = (discogs_artist_id: number | null): ArtistGroup => ({
    discogs_artist_id,
    artist_bio: null,
    artist_wikipedia_url: null,
    artist_image_url: null,
    bio_tokens: null,
  });
  const fullAnswer = (discogs_artist_id: number | null): ArtistGroup => ({
    discogs_artist_id,
    artist_bio: 'Answered bio.',
    artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Answered',
    artist_image_url: 'https://i.discogs.com/answered.jpg',
    bio_tokens: [{ type: 'text', text: 'Answered bio.' }],
  });

  it.each([
    // The healthy-answer carry-forward that differs from the worker: same
    // Discogs artist on a sibling release, so a null in the answer keeps the
    // stored value of that same artist.
    { name: 'both ids equal, null answer', storedId: STORED_ID, answer: nullAnswer(STORED_ID), kept: true },
    { name: 'both ids equal, full answer', storedId: STORED_ID, answer: fullAnswer(STORED_ID), kept: false },
    { name: 'ids differ, null answer', storedId: STORED_ID, answer: nullAnswer(OTHER_ID), kept: false },
    { name: 'ids differ, full answer', storedId: STORED_ID, answer: fullAnswer(OTHER_ID), kept: false },
    // Either id null: "same release" decides, and a rebind is never the same release.
    { name: 'stored id null, null answer', storedId: null, answer: nullAnswer(OTHER_ID), kept: false },
    { name: 'stored id null, full answer', storedId: null, answer: fullAnswer(OTHER_ID), kept: false },
    { name: 'answer id null, null answer', storedId: STORED_ID, answer: nullAnswer(null), kept: false },
    { name: 'answer id null, full answer', storedId: STORED_ID, answer: fullAnswer(null), kept: false },
    { name: 'both ids null, null answer', storedId: null, answer: nullAnswer(null), kept: false },
  ])('$name (stored kept: $kept)', ({ storedId, answer, kept }) => {
    const merged = mergeArtistGroup(stored(storedId), answer);

    expect(merged).toEqual(kept ? stored(storedId) : answer);
  });

  it('keeps stored values only where the same-artist answer is null', () => {
    const answer = { ...nullAnswer(STORED_ID), artist_bio: 'A newer bio.' };

    expect(mergeArtistGroup(stored(STORED_ID), answer)).toEqual({ ...stored(STORED_ID), artist_bio: 'A newer bio.' });
  });
});
