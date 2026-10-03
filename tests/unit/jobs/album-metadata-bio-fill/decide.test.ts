/**
 * `decideBioFill` — what one LML bulk result is allowed to write.
 *
 * Exactly one verdict writes. The other five exist so that each way of NOT
 * getting a trustworthy bio is counted under its own name in the run summary,
 * and so that none of them can fall through into a write.
 *
 * Runs against the REAL `normalizeLookup` (the unit config maps
 * `@wxyc/metadata` to source). The fill's claim is "the bio the enrichment
 * worker would have stored", and the worker stores `normalizeLookup`'s output.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect } from '@jest/globals';
import { decideBioFill } from '../../../../jobs/album-metadata-bio-fill/decide';

const CANDIDATE = {
  album_id: 42,
  legacy_release_id: 1042,
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
};

const BIO = 'American singer-songwriter based in Los Angeles.';
const WIKI = 'https://en.wikipedia.org/wiki/Jessica_Pratt';

/** A real Discogs match for the candidate's own card, with the given artwork overrides. */
const lookup = (artwork: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) => ({
  search_type: 'direct',
  results: [
    {
      library_item: { id: CANDIDATE.legacy_release_id, title: CANDIDATE.album_title },
      artwork:
        artwork === null
          ? null
          : { release_id: 6789, release_url: 'https://www.discogs.com/release/6789', artwork_url: 'x', ...artwork },
    },
  ],
  ...overrides,
});

const matchItem = (body: unknown, index = 0) => ({ index, status: 'match', lookup: body });

const decide = (item: unknown, position = 0) => decideBioFill(CANDIDATE, item as never, position);

describe('decideBioFill', () => {
  it.each([
    ['a shed for limiter saturation', { index: 0, status: 'shed_limiter_saturated', lookup: { results: [] } }],
    // A shed carries a non-null placeholder `lookup`, so this must branch on
    // status. Reading nullity would treat it as a match.
    ['a shed for an open breaker', { index: 0, status: 'shed_breaker_open', lookup: lookup({ artist_bio: BIO }) }],
    ['a per-item error', { index: 0, status: 'error', lookup: null, message: 'TimeoutError' }],
    ['a skipped item', { index: 0, status: 'skipped_discogs_unavailable', lookup: { results: [] } }],
    ['a missing item', undefined],
    ['a match with a null lookup', matchItem(null)],
    ['a match with no results', matchItem({ search_type: 'direct', results: [] })],
  ])('is indeterminate on %s', (_label, item) => {
    expect(decide(item)).toEqual({ kind: 'indeterminate', unexpectedIndex: false });
  });

  it('is indeterminate, and says why, when the result is out of input order (BS#1088 pin)', () => {
    // A silently reordered bulk response would otherwise write one album's
    // bio onto another.
    expect(decide(matchItem(lookup({ artist_bio: BIO }), 7))).toEqual({ kind: 'indeterminate', unexpectedIndex: true });
  });

  it.each([
    ['no_match', { index: 0, status: 'no_match', lookup: null }, 'no_match'],
    ['a fallback search type', matchItem(lookup({ artist_bio: BIO }, { search_type: 'alternative' })), 'untrusted'],
    ['an absent search type', matchItem(lookup({ artist_bio: BIO }, { search_type: undefined })), 'untrusted'],
    [
      'a different catalog card',
      matchItem({ search_type: 'direct', results: [{ library_item: { id: 9999 }, artwork: { artist_bio: BIO } }] }),
      'card_mismatch',
    ],
    ['no artwork at all', matchItem(lookup(null)), 'no_bio'],
    ['a match with no bio', matchItem(lookup({})), 'no_bio'],
    ['a Wikipedia URL but no bio', matchItem(lookup({ wikipedia_url: WIKI })), 'no_bio'],
    ['a whitespace-only bio', matchItem(lookup({ artist_bio: '   ' })), 'no_bio'],
    [
      'a synthetic streaming-only result',
      matchItem(lookup({ release_id: 0, release_url: '', artist_bio: BIO, wikipedia_url: WIKI })),
      'no_bio',
    ],
  ])('writes nothing on %s', (_label, item, kind) => {
    expect(decide(item)).toEqual({ kind });
  });

  // A degraded lookup shed its Discogs work (LML#755 / LML#930): the library
  // rows are real, nothing Discogs-derived is, and bulk still labels it
  // `match` (or `no_match` when no row came back). Short of a fill it says
  // nothing about this album, so it must be asked again, not settled.
  const degraded = (reason: string, body: Record<string, unknown>) => ({
    ...body,
    degraded: true,
    degraded_reason: reason,
  });

  it.each([
    ['a load shed with no artwork', matchItem(degraded('cache_only', lookup(null)))],
    ['a deadline shed with no artwork', matchItem(degraded('deadline_exceeded', lookup(null)))],
    ['a saturated Discogs with no artwork', matchItem(degraded('upstream_unavailable', lookup(null)))],
    ['a degraded match with artwork but no bio', matchItem(degraded('upstream_unavailable', lookup({})))],
    [
      'a degraded no_match',
      { index: 0, status: 'no_match', lookup: degraded('cache_only', { search_type: 'none', results: [] }) },
    ],
    [
      'a degraded match on a fallback search type',
      matchItem(degraded('deadline_exceeded', lookup({ artist_bio: BIO }, { search_type: 'alternative' }))),
    ],
    [
      'a degraded match on a different card',
      matchItem(
        degraded('cache_only', {
          search_type: 'direct',
          results: [{ library_item: { id: 9999 }, artwork: { artist_bio: BIO } }],
        })
      ),
    ],
  ])('is indeterminate on %s', (_label, item) => {
    expect(decide(item)).toEqual({ kind: 'indeterminate', unexpectedIndex: false });
  });

  it('still fills from a degraded lookup that carries a bio for this card', () => {
    // Degradation sheds work; it does not make what did come back untrue.
    expect(decide(matchItem(degraded('deadline_exceeded', lookup({ artist_bio: BIO }))))).toEqual({
      kind: 'fill',
      fill: { artist_bio: BIO, artist_wikipedia_url: null },
    });
  });

  it('fills the bio and the Wikipedia URL when both come back', () => {
    expect(decide(matchItem(lookup({ artist_bio: BIO, wikipedia_url: WIKI })))).toEqual({
      kind: 'fill',
      fill: { artist_bio: BIO, artist_wikipedia_url: WIKI },
    });
  });

  it('fills the bio alone when there is no Wikipedia URL', () => {
    expect(decide(matchItem(lookup({ artist_bio: BIO })))).toEqual({
      kind: 'fill',
      fill: { artist_bio: BIO, artist_wikipedia_url: null },
    });
  });

  it('stores what the enrichment worker would: Discogs markup cleaned out of the bio', () => {
    const verdict = decide(matchItem(lookup({ artist_bio: 'Member of [a=Stereolab] and [l=Drag City].' })));

    expect(verdict).toEqual({
      kind: 'fill',
      fill: { artist_bio: 'Member of Stereolab and Drag City.', artist_wikipedia_url: null },
    });
  });
});
