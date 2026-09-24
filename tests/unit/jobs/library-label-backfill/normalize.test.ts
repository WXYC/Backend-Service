/**
 * The BS#2669 label-normalization rule.
 *
 * This is the rule the whole ticket turns on: it decides which typed spellings
 * count as one label, and therefore which cards resolve and which are held
 * back as conflicts. It is stated in prose in the report, so these cases are
 * what keeps the prose honest.
 *
 * The two properties worth stating outright, because a "harmless" tweak breaks
 * them silently:
 *
 *   - Word boundaries are NOT part of the key. `Sub Pop` and `SubPop` are one
 *     label; measured over the corpus that is worth 618 cards, and every merge
 *     it creates is the same label typed two ways.
 *   - Suffix stripping is WHOLE-TOKEN. A substring strip would turn
 *     `Musicians` into `ians` and quietly merge unrelated cards.
 */

import { normalizeLabel, SUFFIX_TOKENS } from '../../../../jobs/library-label-backfill/normalize';

describe('normalizeLabel', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    [null, ''],
    [undefined, ''],
  ])('treats %p as carrying no label information', (input, expected) => {
    expect(normalizeLabel(input)).toBe(expected);
  });

  describe('case and whitespace', () => {
    it.each([
      ['Sub Pop', 'subpop'],
      ['SUB POP', 'subpop'],
      ['sub pop', 'subpop'],
      ['  Sub   Pop  ', 'subpop'],
      ['SubPop', 'subpop'],
    ])('folds %p to %p', (raw, expected) => {
      expect(normalizeLabel(raw)).toBe(expected);
    });
  });

  describe('punctuation and spacing are separators, not content', () => {
    it.each([
      ['Sub-Pop', 'subpop'],
      ['Sub.Pop.', 'subpop'],
      ['Sub_Pop', 'subpop'],
      ['Sub/Pop', 'subpop'],
      ['(Sub Pop)', 'subpop'],
      ['Sub Pop!!!', 'subpop'],
      ["HONEST JON'S", 'honestjons'],
      ['I.R.S.', 'irs'],
      ['4 AD', '4ad'],
      ["Stone's Throw", 'stonesthrow'],
      ['Roc-A-Fella', 'rocafella'],
    ])('%p -> %p', (raw, expected) => {
      expect(normalizeLabel(raw)).toBe(expected);
    });

    it('unifies A&M with AM, the single biggest real-world merge', () => {
      // 78 cards in the corpus carry both spellings of the same label.
      expect(normalizeLabel('A&M')).toBe('am');
      expect(normalizeLabel('A & M')).toBe('am');
      expect(normalizeLabel('AM')).toBe('am');
    });
  });

  describe('corporate-suffix tokens are dropped', () => {
    it.each([
      ['Sub Pop Records', 'subpop'],
      ['Sub Pop Recordings', 'subpop'],
      ['Sub Pop Records.', 'subpop'],
      ['SUB POP RECORDS', 'subpop'],
      ['Warner Music', 'warner'],
      ['Domino Ltd.', 'domino'],
      ['Matador Inc', 'matador'],
      ['Ghostly LLC', 'ghostly'],
    ])('%p -> %p', (raw, expected) => {
      expect(normalizeLabel(raw)).toBe(expected);
    });

    it('drops the token wherever it appears, not only at the end', () => {
      expect(normalizeLabel('Warner Music Group')).toBe('warnergroup');
      expect(normalizeLabel('Warner Group')).toBe('warnergroup');
    });

    it.each([...SUFFIX_TOKENS])('normalizes the bare token %p to the empty string', (token) => {
      expect(normalizeLabel(token)).toBe('');
    });

    it('strips whole tokens only, never substrings', () => {
      // `records` is a suffix token; `recorded` and `Musicians` merely contain
      // a prefix of one. A substring strip would maul both.
      expect(normalizeLabel('Recorded Sound')).toBe('recordedsound');
      expect(normalizeLabel('Musicians Union')).toBe('musiciansunion');
      expect(normalizeLabel('Incendiary')).toBe('incendiary');
    });

    it('empties a label made only of suffix tokens and punctuation', () => {
      // This is what takes the measured card count from 37,741 to 37,740.
      expect(normalizeLabel('Records')).toBe('');
      expect(normalizeLabel('- Records -')).toBe('');
      expect(normalizeLabel('Music, Inc.')).toBe('');
    });
  });

  describe('Unicode', () => {
    it('folds diacritics, because DJs omit accents they cannot type quickly', () => {
      // Every accent merge measured in the corpus is one label typed two ways:
      // Barbès/Barbes, Cómeme/Comeme, Naïve/Naive, Crónica/Cronica, Häpna/Hapna.
      expect(normalizeLabel('Barbès')).toBe('barbes');
      expect(normalizeLabel('Barbes')).toBe('barbes');
      expect(normalizeLabel('Crónica')).toBe(normalizeLabel('Cronica'));
      expect(normalizeLabel('Naïve')).toBe(normalizeLabel('Naive'));
      expect(normalizeLabel('Csillagrablók')).toBe('csillagrablok');
      expect(normalizeLabel('Hermanos Gutiérrez')).toBe('hermanosgutierrez');
      expect(normalizeLabel('Nilüfer Yanya Records')).toBe('niluferyanya');
    });

    it('applies NFKC, so compatibility forms fold together', () => {
      expect(normalizeLabel('ＳＵＢ ＰＯＰ')).toBe('subpop');
      // Decomposed (combining acute) and precomposed must agree.
      expect(normalizeLabel('Motte\u0301')).toBe(normalizeLabel('Mott\u00e9'));
    });

    it('keeps digits', () => {
      expect(normalizeLabel('4AD')).toBe('4ad');
      expect(normalizeLabel('Thrill Jockey 500')).toBe('thrilljockey500');
    });
  });

  it('is idempotent', () => {
    for (const raw of ['Sub Pop Records', "HONEST JON'S", 'A&M', 'Warner Music Group', '4AD']) {
      expect(normalizeLabel(normalizeLabel(raw))).toBe(normalizeLabel(raw));
    }
  });

  it('merges spellings but never splits one', () => {
    // Every spelling of the same label must land on the same key.
    const spellings = [
      'Sub Pop',
      'sub pop',
      'SUB POP',
      'SubPop',
      'Sub Pop Records',
      'Sub-Pop Recordings',
      '  Sub Pop.  ',
    ];
    const keys = new Set(spellings.map(normalizeLabel));
    expect([...keys]).toEqual(['subpop']);
  });
});
