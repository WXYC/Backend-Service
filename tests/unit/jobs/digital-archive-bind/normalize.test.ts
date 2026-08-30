import { albumGroupKey, relaxedAlbumKey } from '../../../../jobs/digital-archive-bind/normalize';

describe('digital-archive-bind normalize', () => {
  describe('albumGroupKey', () => {
    it('prefers album_artist over artist when both are present and differ', () => {
      // A compilation track credited to a guest artist, banded under the
      // album's real band -- the group key must land on the band, not the
      // per-track credit, or every track scatters into its own "album".
      const trackCredit = albumGroupKey('The Smile', 'Thom Yorke', 'Wall of Eyes');
      const bandOnly = albumGroupKey(null, 'The Smile', 'Wall of Eyes');
      expect(trackCredit).toBe(bandOnly);
      expect(trackCredit).not.toBe(albumGroupKey(null, 'Thom Yorke', 'Wall of Eyes'));
    });

    it('falls back to artist when album_artist is absent', () => {
      expect(albumGroupKey(null, 'Roméo Poirier', 'Living Room Session')).toBe(
        albumGroupKey(undefined, 'Roméo Poirier', 'Living Room Session')
      );
    });

    it('is diacritic- and case-insensitive on the artist leg', () => {
      expect(albumGroupKey(null, 'Roméo Poirier', 'Off the Record')).toBe(
        albumGroupKey(null, 'ROMEO POIRIER', 'Off the Record')
      );
    });

    it('collapses edition cruft on the album leg', () => {
      expect(albumGroupKey(null, 'An Artist', 'Pet Sounds')).toBe(
        albumGroupKey(null, 'An Artist', 'Pet Sounds (Remastered)')
      );
    });

    it('produces different keys for different albums', () => {
      expect(albumGroupKey(null, 'An Artist', 'Album One')).not.toBe(albumGroupKey(null, 'An Artist', 'Album Two'));
    });
  });

  describe('relaxedAlbumKey', () => {
    it('collapses punctuation differences that normalizeAlbumTitle alone does not', () => {
      const a = relaxedAlbumKey('nerve bumps (a queer divine satisfaction)');
      const b = relaxedAlbumKey('nerve bumps: a queer divine satisfaction');
      expect(a).toBe(b);
    });

    it('does not collapse a sequel-numbered title onto its base title', () => {
      expect(relaxedAlbumKey('black metal 2')).not.toBe(relaxedAlbumKey('black metal'));
    });
  });
});
