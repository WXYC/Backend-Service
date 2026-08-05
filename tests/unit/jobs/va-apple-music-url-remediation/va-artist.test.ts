/**
 * BS#2000 V/A arbiter — the predicate that decides which rows get their
 * `apple_music_url` re-adjudicated.
 *
 * The matrix mirrors `wxyc-etl/src/text/compilation.rs`'s own test cases,
 * because this job must select exactly the rows LML#1139's guard would have
 * struck. Two pins below assert DISAGREEMENT with predicates already in this
 * repo — that divergence is the reason the file exists, so a future "let's
 * unify these" edit should fail loudly here.
 */

import { isVariousArtistsCredit } from '../../../../jobs/va-apple-music-url-remediation/va-artist';
import { isCompilationArtist } from '../../../../jobs/artist-search-alias-consumer/compilation';

describe('isVariousArtistsCredit', () => {
  describe('compilation credits (wxyc-etl parity)', () => {
    it.each([
      'Various Artists',
      'Various',
      'various',
      'VARIOUS',
      'Various Artists-Rock-Y', // the WXYC filing convention
      'Various Artists - Blues',
      'Various Artists & Pan Ron',
      'V/A',
      'V.A.',
      'V.A', // dotless — the form LML's donor purge regex missed
      'V.A - Jazz',
      'Soundtrack',
      'Soundtracks',
      'Compilation',
    ])('treats %p as a V/A credit', (name) => {
      expect(isVariousArtistsCredit(name)).toBe(true);
    });
  });

  describe('real artists the leading anchor protects', () => {
    it.each([
      'The Soundtrack of Our Lives',
      'Soundtrack of Our Lives',
      'The Various',
      'Various Production',
      'Stereolab',
      'Juana Molina',
      'Cat Power',
      'Chuquimamani-Condori',
    ])('does not treat %p as a V/A credit', (name) => {
      expect(isVariousArtistsCredit(name)).toBe(false);
    });

    it('leaves a TRAILING V/A credit alone', () => {
      // `CAGAYANO VARIOUS ARTISTS` is a real measured pair that LML#1139
      // documents as an out-of-scope residual: its guard is leading-anchored
      // and does not strike it either. Matching here would null a URL the
      // guard never touched.
      expect(isVariousArtistsCredit('CAGAYANO VARIOUS ARTISTS')).toBe(false);
    });
  });

  describe('empty and nullish', () => {
    it.each([['', false] as const, [null, false] as const, [undefined, false] as const])(
      'treats %p as not-V/A',
      (name, expected) => {
        expect(isVariousArtistsCredit(name)).toBe(expected);
      }
    );

    it('treats a whitespace-only credit as not-V/A', () => {
      expect(isVariousArtistsCredit('   ')).toBe(false);
    });
  });

  describe('fold contract', () => {
    // These are the variants that motivated folding rather than raw matching:
    // LML#1139's guard keys on `to_match_form(artist)`, so an arbiter over the
    // raw column would disagree with it on exactly these.
    it.each(['  Various Artists', 'Various  Artists - Blues', 'Vàrious Artists', 'VÀRIOUS ARTISTS'])(
      'folds %p onto a V/A credit',
      (name) => {
        expect(isVariousArtistsCredit(name)).toBe(true);
      }
    );

    it('strips diacritics via NFD decomposition, not NFKC composition', () => {
      // Regression pin for the bug this arbiter shipped with twice in draft:
      // NFC/NFKC are COMPOSING forms, so a combining-mark strip finds nothing
      // to remove and `Vàrious` never matches the `various artists` prefix.
      expect('Vàrious Artists'.normalize('NFKC').replace(/\p{M}/gu, '').toLowerCase()).not.toContain('various artists');
      expect(isVariousArtistsCredit('Vàrious Artists')).toBe(true);
    });
  });

  describe('deliberate divergence from this repo’s other V/A predicates', () => {
    it('disagrees with the substring copy on a real artist', () => {
      // `jobs/artist-search-alias-consumer/compilation.ts` does a bare
      // substring scan, which is the convention wxyc-etl 0.5.0 tightened away
      // from. Selecting by it here would null correct URLs on real artists.
      expect(isCompilationArtist('Various Production')).toBe(true);
      expect(isVariousArtistsCredit('Various Production')).toBe(false);
    });

    it('disagrees with library-etl on the WXYC shelf-genre filing convention', () => {
      // `jobs/library-etl/job.ts` special-cases /^various\s*artists\s*-rock\s*-[a-z]$/i
      // to isVarious:false — the opposite of wxyc-etl's own pinned case, and
      // the opposite of what LML#1139's guard does.
      const libraryEtlRule = /^various\s*artists\s*-rock\s*-[a-z]$/i;
      expect(libraryEtlRule.test('Various Artists-Rock-Y')).toBe(true); // => isVarious:false there
      expect(isVariousArtistsCredit('Various Artists-Rock-Y')).toBe(true);
    });
  });
});
