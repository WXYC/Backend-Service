/**
 * Pins the free-text `(norm_artist, norm_album)` dedup-key composition shared
 * by catalog-popularity Phase-2 Track 1 (`jobs/catalog-popularity-freetext-resolve/`,
 * which WRITES the keys) and Track 2 (`album-popularity-refresh.service.ts`,
 * which RE-DERIVES them). Drift here = free-text plays silently fail to join
 * their resolution and drop out of the popularity signal, so the contract is
 * pinned by an explicit case table.
 */
import { describe, test, expect } from '@jest/globals';
import {
  CO_BILL_DELIMITER,
  freetextPairKey,
  normalizeFreetextArtist,
} from '../../../shared/database/src/freetext-norm';
import { BILLING_DELIMITER_PATTERNS } from '../../../jobs/triangle-shows-etl/headliner';

describe('normalizeFreetextArtist', () => {
  // The artist leg = normalizeArtistName (lowercase + strip leading "The ")
  // THEN collapse internal whitespace + trim. The whitespace pass is the bit
  // normalizeArtistName itself omits — pinned here because it's the whole
  // reason this wrapper exists.
  test.each([
    ['Stereolab', 'stereolab'],
    ['The Beatles', 'beatles'],
    ['  J  Dilla  ', 'j dilla'],
    ['J Dilla ', 'j dilla'],
    ['J  Dilla', 'j dilla'],
    ['Chuquimamani-Condori', 'chuquimamani-condori'],
    ['', ''],
  ])('normalizeFreetextArtist(%j) -> %j', (input, expected) => {
    expect(normalizeFreetextArtist(input)).toBe(expected);
  });

  test('is total over null / undefined', () => {
    expect(normalizeFreetextArtist(null)).toBe('');
    expect(normalizeFreetextArtist(undefined)).toBe('');
  });
});

describe('freetextPairKey', () => {
  test('whitespace variants of the same artist collapse to one key (the double-count this fold prevents)', () => {
    const a = freetextPairKey('J Dilla ', 'Donuts');
    const b = freetextPairKey('J  Dilla', 'Donuts');
    const c = freetextPairKey('J Dilla', 'Donuts');
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual({ norm_artist: 'j dilla', norm_album: 'donuts' });
  });

  test('album leg strips edition cruft so pressings share a key', () => {
    const plain = freetextPairKey('Beach Boys', 'Pet Sounds');
    const remaster = freetextPairKey('Beach Boys', 'Pet Sounds (Remastered)');
    const dash = freetextPairKey('Beach Boys', 'Pet Sounds - 2011 Remaster');
    expect(plain.norm_album).toBe('pet sounds');
    expect(remaster).toEqual(plain);
    expect(dash).toEqual(plain);
  });

  test('self-titled family collapses on the album leg', () => {
    expect(freetextPairKey('Stereolab', 'S/T').norm_album).toBe('self-titled');
    expect(freetextPairKey('Stereolab', 'self titled').norm_album).toBe('self-titled');
  });

  test('is total over null / undefined on both legs', () => {
    expect(freetextPairKey(null, null)).toEqual({ norm_artist: '', norm_album: '' });
    expect(freetextPairKey(undefined, undefined)).toEqual({ norm_artist: '', norm_album: '' });
  });
});

/**
 * BS#3635 — the co-bill delimiter the `upcoming_show` read path splits a
 * headliner billing on. Only ` + ` and ` / ` (whitespace on both sides): a
 * comma or ` with ` would split single acts, and a bare `/` or `&` is part of
 * many band names.
 */
const coBillCases: Array<[string, boolean]> = [
  ['The Onlies + Tatiana Hargreaves', true],
  ['Wednesday 13 / Dead on a Sunday / Above Snakes', true],
  ['Tobacco Road / Wim Tapley & The Cannons', true],
  ['AC/DC', false],
  ['AJ Lee & Blue Summit', false],
  ['Circle Jerks, Municipal Waste', false],
  ['Juana Molina with Stereolab', false],
  ['Kendrick+Friends', false],
  ['Stereolab', false],
];

describe('CO_BILL_DELIMITER', () => {
  test.each(coBillCases)('CO_BILL_DELIMITER.test(%j) -> %j', (input, expected) => {
    expect(CO_BILL_DELIMITER.test(input)).toBe(expected);
  });

  test('splits a co-bill into its acts', () => {
    expect('Wednesday 13 / Dead on a Sunday / Above Snakes'.split(CO_BILL_DELIMITER)).toEqual([
      'Wednesday 13',
      'Dead on a Sunday',
      'Above Snakes',
    ]);
  });

  // headliner.ts can't import @wxyc/database (its client throws at import
  // time without DB env vars), so it keeps its own plus/slash patterns. Pin
  // the two to agree on one shared table.
  test.each(coBillCases)('agrees with the ETL plus/slash patterns on %j', (input) => {
    const etl = BILLING_DELIMITER_PATTERNS.plus.test(input) || BILLING_DELIMITER_PATTERNS.slash.test(input);
    expect(CO_BILL_DELIMITER.test(input)).toBe(etl);
  });

  // The table above can't catch every drift, so also pin the sources.
  test('is exactly the ETL plus and slash patterns joined', () => {
    expect(CO_BILL_DELIMITER.source).toBe(
      `${BILLING_DELIMITER_PATTERNS.plus.source}|${BILLING_DELIMITER_PATTERNS.slash.source}`
    );
    expect(CO_BILL_DELIMITER.flags).toBe('');
  });
});
