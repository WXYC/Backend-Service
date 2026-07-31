/**
 * Unit tests for `foldArtistName` (BS#1897 / shared/database/src/fold-artist-name.ts).
 *
 * This TypeScript twin must produce byte-identical output to the SQL function
 * `wxyc_schema.fold_artist_name(text)` defined in migration 0134 — the catalog
 * write-boundary matcher (`artistIdFromName`) and the one-shot
 * `jobs/artist-unicode-dedup` job both compare on this fold, so any drift
 * between the JS twin and the SQL function surfaces as either a missed match
 * (duplicate artist inserted) or a mis-grouped dedup.
 *
 * The fold collapses THREE independent axes of the same name onto one key:
 *   1. Unicode composition form — NFC (`ü` = U+00FC) vs NFD (`u` + U+0308).
 *   2. Diacritics — `Nilüfer` vs the ASCII-fold `Nilufer`.
 *   3. Case — `NILÜFER` vs `nilüfer`.
 *
 * It does NOT strip a leading "The " (unlike `normalizeArtistName`): the fold
 * is a strict superset of the pre-existing `lower()` matcher, adding only
 * form/diacritic insensitivity, so it must not newly merge "The Notwist" with
 * "Notwist".
 *
 * WXYC-canonical diacritic-bearing names are used deliberately (see the org
 * CLAUDE.md example-data convention): Nilüfer Yanya, Csillagrablók, Hermanos
 * Gutiérrez.
 */

import { foldArtistName } from '../../../shared/database/src/fold-artist-name';

// Composed (NFC) and decomposed (NFD) spellings of the same three names, built
// from explicit codepoints so the byte distinction is unambiguous in-source.
const NILUFER_NFC = 'Nilüfer Yanya'; // ü = U+00FC
const NILUFER_NFD = 'Nilüfer Yanya'; // u + U+0308 (combining diaeresis)
const NILUFER_ASCII = 'Nilufer Yanya';

const CSILLAG_NFC = 'Csillagrablók'; // ó = U+00F3
const CSILLAG_NFD = 'Csillagrablók'; // o + U+0301 (combining acute)
const CSILLAG_ASCII = 'Csillagrablok';

const HERMANOS_NFC = 'Hermanos Gutiérrez'; // é = U+00E9
const HERMANOS_NFD = 'Hermanos Gutiérrez'; // e + U+0301
const HERMANOS_ASCII = 'Hermanos Gutierrez';

describe('foldArtistName', () => {
  describe('collapses NFC / NFD / ASCII-fold / case to a single key', () => {
    it('Nilüfer Yanya — all four variants fold equal', () => {
      const key = foldArtistName(NILUFER_NFC);
      expect(key).toBe('nilufer yanya');
      expect(foldArtistName(NILUFER_NFD)).toBe(key);
      expect(foldArtistName(NILUFER_ASCII)).toBe(key);
      expect(foldArtistName('NILÜFER YANYA')).toBe(key); // NFC uppercase
    });

    it('Csillagrablók — all three form variants fold equal', () => {
      const key = foldArtistName(CSILLAG_NFC);
      expect(key).toBe('csillagrablok');
      expect(foldArtistName(CSILLAG_NFD)).toBe(key);
      expect(foldArtistName(CSILLAG_ASCII)).toBe(key);
    });

    it('Hermanos Gutiérrez — all three form variants fold equal', () => {
      const key = foldArtistName(HERMANOS_NFC);
      expect(key).toBe('hermanos gutierrez');
      expect(foldArtistName(HERMANOS_NFD)).toBe(key);
      expect(foldArtistName(HERMANOS_ASCII)).toBe(key);
    });

    it('folds ñ (Sonido Dueñez) across forms', () => {
      const nfc = 'Sonido Dueñez'; // ñ = U+00F1
      const nfd = 'Sonido Dueñez'; // n + U+0303 (combining tilde)
      expect(foldArtistName(nfc)).toBe('sonido duenez');
      expect(foldArtistName(nfd)).toBe('sonido duenez');
    });
  });

  describe('does not over-fold genuinely distinct names', () => {
    it('keeps distinct artists distinct', () => {
      expect(foldArtistName('Stereolab')).not.toBe(foldArtistName('Cat Power'));
      expect(foldArtistName('Nilüfer Yanya')).not.toBe(foldArtistName('Jessica Pratt'));
    });

    it('does NOT strip a leading "The " (unlike normalizeArtistName)', () => {
      expect(foldArtistName('The Notwist')).toBe('the notwist');
      expect(foldArtistName('The Notwist')).not.toBe(foldArtistName('Notwist'));
    });

    it('preserves ASCII punctuation and separators', () => {
      expect(foldArtistName('Simon & Garfunkel')).toBe('simon & garfunkel');
      expect(foldArtistName('AC/DC')).toBe('ac/dc');
    });
  });

  describe('total over nullish input (mirrors SQL coalesce(input, ""))', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
    ])('%s → empty string', (_label, input) => {
      expect(foldArtistName(input)).toBe('');
    });
  });

  it('is idempotent — folding a folded key is a no-op', () => {
    const once = foldArtistName(NILUFER_NFC);
    expect(foldArtistName(once)).toBe(once);
  });
});
