/**
 * The album-reviews import's skip rule (BS#3132): which archive rows are importable and, for the rest, the one reason
 * each is counted under. The order is the contract: a row that fails two rules is reported under the first.
 */

import { AUTHOR_MAX } from '@wxyc/database';
import { skipReason } from '../../../../jobs/album-reviews-import/import';

const row = (overrides: Partial<Parameters<typeof skipReason>[0]> = {}) => ({
  id: 1,
  album_id: 7,
  review: 'A form review.',
  reviewer_raw: 'Test Reviewer',
  cited: false,
  imported: false,
  ...overrides,
});

describe('skipReason', () => {
  it('imports a linked row with a body', () => {
    expect(skipReason(row())).toBeNull();
  });

  it.each([
    ['no release', { album_id: null }, 'no_release'],
    ['a null review', { review: null }, 'blank_review'],
    ['a whitespace-only review', { review: ' \n\t ' }, 'blank_review'],
    ['a citing intake item', { cited: true }, 'cited_by_intake_item'],
    ['a prior import', { imported: true }, 'already_imported'],
  ])('skips a row with %s', (_name, overrides, reason) => {
    expect(skipReason(row(overrides))).toBe(reason);
  });

  it.each([
    ['no release before a blank review', { album_id: null, review: '' }, 'no_release'],
    ['a blank review before a citation', { review: '', cited: true }, 'blank_review'],
    ['a citation before a prior import', { cited: true, imported: true }, 'cited_by_intake_item'],
    [
      'a prior import before a long author',
      { imported: true, reviewer_raw: 'x'.repeat(AUTHOR_MAX + 1) },
      'already_imported',
    ],
  ])('reports %s', (_name, overrides, reason) => {
    expect(skipReason(row(overrides))).toBe(reason);
  });

  describe('author length', () => {
    it('counts code points, so AUTHOR_MAX astral characters fit and one more does not', () => {
      expect(skipReason(row({ reviewer_raw: '𝒜'.repeat(AUTHOR_MAX) }))).toBeNull();
      expect(skipReason(row({ reviewer_raw: '𝒜'.repeat(AUTHOR_MAX + 1) }))).toBe('author_too_long');
    });

    it('accepts exactly AUTHOR_MAX characters', () => {
      expect(skipReason(row({ reviewer_raw: 'x'.repeat(AUTHOR_MAX) }))).toBeNull();
    });

    it('measures the trimmed name, which is what is stored', () => {
      expect(skipReason(row({ reviewer_raw: `  ${'x'.repeat(AUTHOR_MAX)}  ` }))).toBeNull();
    });

    it('does not refuse a blank reviewer: the author is stored as null', () => {
      expect(skipReason(row({ reviewer_raw: '   ' }))).toBeNull();
      expect(skipReason(row({ reviewer_raw: null }))).toBeNull();
    });
  });
});
