/**
 * `decideReask` — what one LML bulk result is allowed to write (BS#3143).
 *
 * Exactly three verdicts write: `rebind`, `rebind_unpinned` and `clear`. Every
 * other verdict names one way of not getting an answer the job may trust, so
 * the run summary counts it under its own name and none of them can fall
 * through into a write. Degraded answers never write, whatever they carry
 * (decision 8 on BS#3137).
 *
 * Runs against the REAL `normalizeLookup` and `isTrustedLmlAlbumMatch` (the
 * unit config maps `@wxyc/metadata` and `@wxyc/lml-client` to source).
 *
 * @see WXYC/Backend-Service#3137 ("Verdicts")
 */

import { describe, it, expect } from '@jest/globals';
import { decideReask, type ReaskCandidate } from '../../../../jobs/album-metadata-reask/decide';

const PIN = 4101;
const STORED = 4102;
const EXPECTED = 4103;
const OTHER = 4104;

/** A card whose stored release disagrees with its pin. */
const MISMATCH: ReaskCandidate = {
  legacy_release_id: 1001,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  reason: 'pin_mismatch',
  stored_release_id: STORED,
  pin_release_id: PIN,
  expected_release_id: null,
};

/** Tier 1: step 2 removed the pin, and its play-corroborated no-pin release is EXPECTED. */
const REMOVED_TIER_1: ReaskCandidate = {
  legacy_release_id: 1002,
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
  reason: 'pin_removed',
  stored_release_id: STORED,
  pin_release_id: null,
  expected_release_id: EXPECTED,
};

/** Tier 2a: step 2 removed the pin, and no release is expected. */
const REMOVED_TIER_2A: ReaskCandidate = {
  legacy_release_id: 1003,
  artist_name: 'Stereolab',
  album_title: 'Dots and Loops',
  reason: 'pin_removed',
  stored_release_id: STORED,
  pin_release_id: null,
  expected_release_id: null,
};

const DEGRADED_REASONS = ['cache_only', 'deadline_exceeded', 'upstream_unavailable'] as const;

/** A direct match on the candidate's own card for `releaseId`, with artwork overrides. */
const answer = (
  candidate: ReaskCandidate,
  releaseId: number,
  artwork: Record<string, unknown> | null = {},
  overrides: Record<string, unknown> = {}
) => ({
  search_type: 'direct',
  results: [
    {
      library_item: { id: candidate.legacy_release_id, title: candidate.album_title },
      artwork:
        artwork === null
          ? null
          : {
              release_id: releaseId,
              release_url: `https://www.discogs.com/release/${releaseId}`,
              artwork_url: `https://i.discogs.com/${releaseId}.jpg`,
              release_year: 2017,
              ...artwork,
            },
    },
  ],
  ...overrides,
});

/** LML's synthetic streaming-only shape (LML#401): `release_id: 0`, empty URL. */
const synthetic = (candidate: ReaskCandidate) => answer(candidate, 0, { release_url: '', artwork_url: null });

const match = (body: unknown, index = 0) => ({ index, status: 'match', lookup: body });
const noMatch = (lookup: unknown = null) => ({ index: 0, status: 'no_match', lookup });
const degrade = (reason: string, body: Record<string, unknown>) => ({
  ...body,
  degraded: true,
  degraded_reason: reason,
});

type Row = [label: string, candidate: ReaskCandidate, item: unknown, kind: string, position?: number];

const ROWS: Row[] = [
  // indeterminate: LML did not answer for this album.
  ['a missing item (the call threw or the slot is absent)', MISMATCH, undefined, 'indeterminate'],
  [
    'a shed for an open breaker',
    MISMATCH,
    { index: 0, status: 'shed_breaker_open', lookup: answer(MISMATCH, PIN) },
    'indeterminate',
  ],
  ['a per-item error', MISMATCH, { index: 0, status: 'error', lookup: null }, 'indeterminate'],
  [
    'a skipped item',
    MISMATCH,
    { index: 0, status: 'skipped_discogs_unavailable', lookup: { results: [] } },
    'indeterminate',
  ],
  ['a match with a null lookup', MISMATCH, match(null), 'indeterminate'],
  ['a match with no results', MISMATCH, match({ search_type: 'direct', results: [] }), 'indeterminate'],
  ...DEGRADED_REASONS.map((reason): Row => [
    `a ${reason} answer that names the pin in full`,
    MISMATCH,
    match(degrade(reason, answer(MISMATCH, PIN))),
    'indeterminate',
  ]),
  ...DEGRADED_REASONS.map((reason): Row => [
    `a ${reason} answer that names the expected release in full`,
    REMOVED_TIER_1,
    match(degrade(reason, answer(REMOVED_TIER_1, EXPECTED))),
    'indeterminate',
  ]),
  [
    'a degraded no_match on a tier-2a removed row (never a clear)',
    REMOVED_TIER_2A,
    noMatch(degrade('upstream_unavailable', { search_type: 'none', results: [] })),
    'indeterminate',
  ],
  [
    'a degraded release_id 0 shape on a tier-2a removed row (never a clear)',
    REMOVED_TIER_2A,
    match(degrade('deadline_exceeded', synthetic(REMOVED_TIER_2A))),
    'indeterminate',
  ],
  [
    'a degraded match on another card',
    MISMATCH,
    match(degrade('cache_only', { ...answer(MISMATCH, PIN), results: [{ library_item: { id: 9999 } }] })),
    'indeterminate',
  ],

  // Settled non-writes.
  ['no_match on a pinned row', MISMATCH, noMatch(), 'no_match'],
  ['a fallback search type', MISMATCH, match(answer(MISMATCH, PIN, {}, { search_type: 'alternative' })), 'untrusted'],
  ['an absent search type', MISMATCH, match(answer(MISMATCH, PIN, {}, { search_type: undefined })), 'untrusted'],
  [
    'another catalog card',
    MISMATCH,
    match({ ...answer(MISMATCH, PIN), results: [{ library_item: { id: 9999 }, artwork: { release_id: PIN } }] }),
    'card_mismatch',
  ],
  ['a pinned row answered with another release', MISMATCH, match(answer(MISMATCH, OTHER)), 'pin_not_bound'],
  ['a pinned row answered with its stored release', MISMATCH, match(answer(MISMATCH, STORED)), 'pin_not_bound'],
  ['the pin with no release_url', MISMATCH, match(answer(MISMATCH, PIN, { release_url: '' })), 'incomplete'],
  ['the release_id 0 shape on a pinned row', MISMATCH, match(synthetic(MISMATCH)), 'incomplete'],
  ['a pinned row with no artwork at all', MISMATCH, match(answer(MISMATCH, PIN, null)), 'incomplete'],
  [
    'a removed row answered with the removed release',
    REMOVED_TIER_1,
    match(answer(REMOVED_TIER_1, STORED)),
    'matcher_agrees_with_removed',
  ],
  [
    'a tier-2a row answered with the removed release',
    REMOVED_TIER_2A,
    match(answer(REMOVED_TIER_2A, STORED)),
    'matcher_agrees_with_removed',
  ],
  [
    'a tier-1 row answered with another release',
    REMOVED_TIER_1,
    match(answer(REMOVED_TIER_1, OTHER)),
    'unpinned_drifted',
  ],
  [
    'a tier-2a row answered with any release',
    REMOVED_TIER_2A,
    match(answer(REMOVED_TIER_2A, OTHER)),
    'unpinned_drifted',
  ],
  ['a tier-1 row answered with no_match', REMOVED_TIER_1, noMatch(), 'unpinned_drifted'],
  [
    'a tier-1 row answered with the release_id 0 shape',
    REMOVED_TIER_1,
    match(synthetic(REMOVED_TIER_1)),
    'unpinned_drifted',
  ],
  [
    'the expected release with no release_url',
    REMOVED_TIER_1,
    match(answer(REMOVED_TIER_1, EXPECTED, { release_url: '' })),
    'incomplete',
  ],
  ['a removed row with no artwork at all', REMOVED_TIER_2A, match(answer(REMOVED_TIER_2A, OTHER, null)), 'incomplete'],

  // The three writes.
  ['a pinned row answered with the pin', MISMATCH, match(answer(MISMATCH, PIN)), 'rebind'],
  [
    'a tier-1 row answered with its expected release',
    REMOVED_TIER_1,
    match(answer(REMOVED_TIER_1, EXPECTED)),
    'rebind_unpinned',
  ],
  ['a tier-2a row answered with no_match', REMOVED_TIER_2A, noMatch(), 'clear'],
  ['a tier-2a row answered with the release_id 0 shape', REMOVED_TIER_2A, match(synthetic(REMOVED_TIER_2A)), 'clear'],
];

describe('decideReask', () => {
  it.each(ROWS)('%s -> %s', (_label, candidate, item, kind, position = 0) => {
    expect(decideReask(candidate, item as never, position).kind).toBe(kind);
  });

  it.each([
    ['a pinned row', MISMATCH, answer(MISMATCH, PIN)],
    // A degraded answer out of order is still a contract break first.
    ['a degraded answer', REMOVED_TIER_1, degrade('cache_only', answer(REMOVED_TIER_1, EXPECTED))],
  ])('flags an out-of-order index on %s (BS#1088 pin)', (_label, candidate, body) => {
    expect(decideReask(candidate, match(body, 3) as never, 0)).toEqual({
      kind: 'indeterminate',
      unexpectedIndex: true,
    });
  });

  it('carries the payload of the answered release on a rebind', () => {
    const verdict = decideReask(
      MISMATCH,
      match(answer(MISMATCH, PIN, { artist_bio: 'Argentine singer from [a=Buenos Aires].' })) as never,
      0
    );

    expect(verdict).toMatchObject({
      kind: 'rebind',
      release_id: PIN,
      payload: {
        release: { discogs_url: `https://www.discogs.com/release/${PIN}`, release_year: 2017 },
        artist: { artist_bio: 'Argentine singer from Buenos Aires.' },
      },
    });
  });

  it('carries the all-NULL release group on a clear, and no artist group', () => {
    expect(decideReask(REMOVED_TIER_2A, noMatch() as never, 0)).toEqual({
      kind: 'clear',
      payload: {
        release: {
          discogs_url: null,
          artwork_url: null,
          release_year: null,
          label: null,
          full_release_date: null,
          genres: null,
          styles: null,
          tracklist: null,
        },
        artist: null,
      },
    });
  });
});
