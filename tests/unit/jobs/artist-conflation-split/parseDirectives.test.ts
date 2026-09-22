/**
 * Tests for the split job's directive parser (BS#2645).
 *
 * The directives file is produced by a different repo
 * (WXYC/catalog-audits `split-directives.tsv`), so the parser is the
 * contract seam: a silent column reorder or a half-written value there
 * must fail loudly here, before anything validates against the database —
 * the writes it feeds create artist rows and repoint releases.
 */

import { parseDirectives } from '../../../../jobs/artist-conflation-split/split';

const HEADER = 'artist_id\tartist_name\tkeep_genre_id\tsplit_genre_ids\tclear_identity';

const file = (...rows: string[]): string => [HEADER, ...rows].join('\n') + '\n';

describe('parseDirectives', () => {
  test('parses a single-genre split', () => {
    expect(parseDirectives(file('431\tIsis\t6\t11\tfalse'))).toEqual([
      { artistId: 431, keepGenreId: 6, splitGenreIds: [11], clearIdentity: false },
    ]);
  });

  test('parses a multi-genre split and clear_identity', () => {
    expect(parseDirectives(file('7771\tKing\t6\t11,9\ttrue'))).toEqual([
      { artistId: 7771, keepGenreId: 6, splitGenreIds: [11, 9], clearIdentity: true },
    ]);
  });

  test('rejects a reordered or renamed header', () => {
    const reordered = 'artist_id\tartist_name\tsplit_genre_ids\tkeep_genre_id\tclear_identity';
    expect(() => parseDirectives([reordered, '431\tIsis\t11\t6\tfalse'].join('\n'))).toThrow(
      /Unexpected directives header/
    );
  });

  test('rejects a row with the wrong column count', () => {
    expect(() => parseDirectives(file('431\tIsis\t6\t11'))).toThrow(/expected 5 columns/);
  });

  test('rejects a clear_identity value that is neither true nor false', () => {
    expect(() => parseDirectives(file('431\tIsis\t6\t11\tyes'))).toThrow(/clear_identity/);
  });

  test('rejects malformed split genre ids', () => {
    expect(() => parseDirectives(file('431\tIsis\t6\t11,x\tfalse'))).toThrow(/malformed split_genre_ids/);
    expect(() => parseDirectives(file('431\tIsis\t6\t\tfalse'))).toThrow(/malformed split_genre_ids/);
  });

  test('ignores blank lines', () => {
    expect(parseDirectives(file('431\tIsis\t6\t11\tfalse') + '\n\n')).toHaveLength(1);
  });
});
