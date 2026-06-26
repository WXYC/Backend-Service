/**
 * Pins the free-text `(norm_artist, norm_album)` dedup-key composition shared
 * by catalog-popularity Phase-2 Track 1 (`jobs/catalog-popularity-freetext-resolve/`,
 * which WRITES the keys) and Track 2 (`album-popularity-refresh.service.ts`,
 * which RE-DERIVES them). Drift here = free-text plays silently fail to join
 * their resolution and drop out of the popularity signal, so the contract is
 * pinned by an explicit case table.
 */
import { describe, test, expect } from '@jest/globals';
import { freetextPairKey, normalizeFreetextArtist } from '../../../shared/database/src/freetext-norm';

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
