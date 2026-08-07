/**
 * Unit tests for library-call-number-dedup's classify.ts.
 *
 * Every fixture here is a real collision measured in the production catalog.
 * That matters: the whole job turns on whether two rows in one call-number slot
 * are the same release entered twice (merge, no disc moves) or two different
 * releases (renumber, and someone has to relabel a disc). Classifying on title
 * equality alone gets that split wrong by better than 2x, and the pairs below
 * are the ones that expose it.
 */
import {
  SIMILARITY_THRESHOLD,
  classifySlot,
  hasTwinElsewhere,
  similarity,
  titleKey,
  type SlotMember,
} from '../../../../jobs/library-call-number-dedup/classify';

const member = (id: number, album_title: string, refs = 0): SlotMember => ({ id, album_title, refs });

describe('titleKey', () => {
  it.each([
    ['strips a format suffix', 'It\'s a Party 12"', "It's a Party cd-single"],
    ['strips a pressing variant', 'Straight Outta Comptom Dirty LP', 'Straight Outta Comptom Clean lyric'],
    ['spells out number words', 'Volume 1', 'Volume One'],
    ['ignores punctuation and case', 'water babies', 'Water Babies'],
    ['ignores a possessive apostrophe', 'Workin with Miles Davis Quintet', "Workin' with the Miles Davis Quintet"],
    ['strips a missing marker', 'Loaded', 'Loaded [missing]'],
    ['strips an EP marker', 'Woman King', 'Woman King [EP]'],
  ])('%s: folds both sides together', (_label, a, b) => {
    expect(titleKey(a)).toBe(titleKey(b));
  });

  it('keeps volume numbers distinct — they name different records', () => {
    expect(titleKey('Ethiopiques vol. 21')).not.toBe(titleKey('Ethiopiques vol. 22'));
    expect(titleKey('UP&down Club Sessions Vol. 1')).not.toBe(titleKey('UP&down Club Sessions Vol. 2'));
  });

  it('returns empty for a title that is nothing but decoration', () => {
    expect(titleKey('[EP]')).toBe('');
    expect(titleKey('the')).toBe('');
  });
});

describe('similarity', () => {
  it('scores a one-character typo above the merge threshold', () => {
    expect(similarity(titleKey('Starlight Walker'), titleKey('Starlite Walker'))).toBeGreaterThanOrEqual(
      SIMILARITY_THRESHOLD
    );
  });

  it('scores two different titles well below it', () => {
    expect(similarity(titleKey('Wrong Place'), titleKey('Event II'))).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('is 1 for identical input and 0 when either side is empty', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
  });
});

describe('classifySlot', () => {
  it('merges a slot holding one release entered twice', () => {
    const v = classifySlot([member(1, "People's Instinctive Travels"), member(2, "People's Instinctive Travels")]);
    expect(v).toEqual({ kind: 'merge', survivorId: 1, loserIds: [2] });
  });

  it('merges across a format difference — one record, two pressings', () => {
    const v = classifySlot([member(10, 'It\'s a Party 12"', 3), member(11, "It's a Party cd-single", 1)]);
    expect(v).toEqual({ kind: 'merge', survivorId: 10, loserIds: [11] });
  });

  it('renumbers a slot holding two genuinely different releases', () => {
    const v = classifySlot([member(20, 'Wrong Place', 5), member(21, 'Event II', 2)]);
    expect(v).toEqual({ kind: 'renumber', keepId: 20, moveId: 21 });
  });

  it('moves the least-referenced disc, not the lower id', () => {
    const v = classifySlot([member(30, 'Begin Here', 0), member(31, 'Odyssey and Oracle', 9)]);
    expect(v).toEqual({ kind: 'renumber', keepId: 31, moveId: 30 });
  });

  describe('survivor selection', () => {
    it('prefers the row carrying more references', () => {
      const v = classifySlot([member(40, 'Bee Thousand', 1), member(41, 'Bee Thousand', 7)]);
      expect(v).toMatchObject({ kind: 'merge', survivorId: 41 });
    });

    it('breaks a reference tie on the fuller title', () => {
      const v = classifySlot([member(50, 'Lady in Satin', 2), member(51, 'Lady in Satin (remastered)', 2)]);
      expect(v).toMatchObject({ kind: 'merge', survivorId: 51 });
    });

    it('breaks a full tie on the lower id, for determinism across runs', () => {
      const v = classifySlot([member(61, 'Cypress Hill', 2), member(60, 'Cypress Hill', 2)]);
      expect(v).toMatchObject({ kind: 'merge', survivorId: 60 });
    });
  });

  it('never merges a title that folds to nothing into a real one', () => {
    const v = classifySlot([member(70, 'Private Parts', 4), member(71, '[EP]', 0)]);
    expect(v.kind).toBe('renumber');
  });

  it('rejects a slot that does not actually collide', () => {
    expect(() => classifySlot([member(80, 'Solo')])).toThrow(/at least 2/);
  });
});

describe('hasTwinElsewhere', () => {
  const shelf = [
    { code_number: 1, album_title: 'Juju Music' },
    { code_number: 1, album_title: 'Gems from the Classic Years (1967-1974)' },
    { code_number: 2, album_title: 'Juju Music' },
    { code_number: 2, album_title: 'Synchro System' },
  ];

  it('holds back a disc whose title already sits at another number', () => {
    expect(hasTwinElsewhere('Juju Music', 1, shelf)).toBe(true);
  });

  it('allows a disc that is the only copy of its title on the shelf', () => {
    expect(hasTwinElsewhere('Synchro System', 2, shelf)).toBe(false);
  });

  it('does not treat a decoration-only title as a twin of anything', () => {
    expect(hasTwinElsewhere('[EP]', 1, shelf)).toBe(false);
  });
});
