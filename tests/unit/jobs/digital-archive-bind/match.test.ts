import {
  matchLibrary,
  matchRotation,
  type LibraryCandidateRow,
  type RotationCandidateRow,
} from '../../../../jobs/digital-archive-bind/match';
import { artistFoldKey } from '../../../../jobs/digital-archive-bind/normalize';
import { normalizeAlbumTitle } from '@wxyc/database';
import type { CandidateAlbum } from '../../../../jobs/digital-archive-bind/types';

const candidateOf = (
  artist: string,
  album: string,
  contentKind: CandidateAlbum['contentKind'] = 'freeform'
): CandidateAlbum => ({
  contentKind,
  artistFoldKey: artistFoldKey(artist),
  albumNormKey: normalizeAlbumTitle(album),
  discNumber: 1,
  displayArtist: artist,
  displayAlbum: album,
  files: [],
});

describe('digital-archive-bind match', () => {
  describe('matchRotation', () => {
    const rows: RotationCandidateRow[] = [
      { libraryId: 101, artistName: 'Chuquimamani-Condori', albumTitle: 'Edits' },
      { libraryId: 202, artistName: 'Duke Ellington & John Coltrane', albumTitle: 'Duke Ellington & John Coltrane' },
    ];

    it('resolves an exact normalized match', () => {
      const result = matchRotation(candidateOf('chuquimamani-condori', 'EDITS'), rows);
      expect(result).toEqual({ kind: 'matched', libraryId: 101, tier: 'exact', note: 'exact' });
    });

    it('resolves a fuzzy match on punctuation the exact tier misses', () => {
      const punctuated: RotationCandidateRow[] = [
        { libraryId: 303, artistName: 'An Artist', albumTitle: 'Nerve Bumps (A Queer Divine Satisfaction)' },
      ];
      const result = matchRotation(candidateOf('An Artist', 'Nerve Bumps: A Queer Divine Satisfaction'), punctuated);
      expect(result.kind).toBe('matched');
      if (result.kind === 'matched') {
        expect(result.libraryId).toBe(303);
        expect(result.tier).toBe('fuzzy');
      }
    });

    it('reports no match as unmatched', () => {
      expect(matchRotation(candidateOf('Nobody', 'Nothing'), rows)).toEqual({ kind: 'unmatched' });
    });

    it('reports >1 distinct album at the exact tier as ambiguous, without falling through to fuzzy', () => {
      const dup: RotationCandidateRow[] = [
        { libraryId: 1, artistName: 'Same Artist', albumTitle: 'Same Album' },
        { libraryId: 2, artistName: 'Same Artist', albumTitle: 'Same Album' },
      ];
      const result = matchRotation(candidateOf('Same Artist', 'Same Album'), dup);
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') expect(result.libraryIds.sort()).toEqual([1, 2]);
    });

    it('does not collapse a sequel title onto its base title at the fuzzy tier', () => {
      const rowsWithSequel: RotationCandidateRow[] = [
        { libraryId: 9, artistName: 'An Artist', albumTitle: 'Black Metal' },
      ];
      expect(matchRotation(candidateOf('An Artist', 'Black Metal 2'), rowsWithSequel)).toEqual({ kind: 'unmatched' });
    });

    it('collapses duplicate rotation rows pointing at the same album_id to a single exact match', () => {
      const reAdded: RotationCandidateRow[] = [
        { libraryId: 55, artistName: 'Repeat Artist', albumTitle: 'Repeat Album' },
        { libraryId: 55, artistName: 'Repeat Artist', albumTitle: 'Repeat Album' },
      ];
      const result = matchRotation(candidateOf('Repeat Artist', 'Repeat Album'), reAdded);
      expect(result).toEqual({ kind: 'matched', libraryId: 55, tier: 'exact', note: 'exact' });
    });
  });

  describe('matchLibrary', () => {
    it('matches on artist_name', () => {
      const rows: LibraryCandidateRow[] = [
        {
          libraryId: 1,
          artistName: 'Jessica Pratt',
          albumArtist: null,
          alternateArtistName: null,
          albumTitle: 'On Your Own Love Again',
        },
      ];
      const result = matchLibrary(candidateOf('Jessica Pratt', 'On Your Own Love Again'), rows);
      expect(result).toEqual({ kind: 'matched', libraryId: 1, tier: 'exact', note: 'exact' });
    });

    it('matches on album_artist when artist_name differs (compilation filing convention)', () => {
      const rows: LibraryCandidateRow[] = [
        {
          libraryId: 2,
          artistName: 'Thom Yorke',
          albumArtist: 'The Smile',
          alternateArtistName: null,
          albumTitle: 'Wall of Eyes',
        },
      ];
      const result = matchLibrary(candidateOf('The Smile', 'Wall of Eyes'), rows);
      expect(result).toEqual({ kind: 'matched', libraryId: 2, tier: 'exact', note: 'exact' });
    });

    it('widens to alternate_artist_name only at the fuzzy tier', () => {
      const rows: LibraryCandidateRow[] = [
        {
          libraryId: 3,
          artistName: 'Filed Under This Name',
          albumArtist: null,
          alternateArtistName: 'Also Known As',
          albumTitle: 'Some Album',
        },
      ];
      expect(matchLibrary(candidateOf('Also Known As', 'Some Album'), rows)).toEqual({
        kind: 'matched',
        libraryId: 3,
        tier: 'fuzzy',
        note: expect.stringContaining('fuzzy'),
      });
    });

    it('reports zero matches as unmatched', () => {
      expect(matchLibrary(candidateOf('Nobody', 'Nothing'), [])).toEqual({ kind: 'unmatched' });
    });
  });
});
