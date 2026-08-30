import { classifyObjectKey, isRotationDerived } from '../../../../jobs/digital-archive-bind/classify';

describe('digital-archive-bind classify', () => {
  describe('directory markers', () => {
    it('skips a key ending in / as a directory marker', () => {
      expect(classifyObjectKey('library/freeform/Artist/Album/')).toEqual({
        kind: 'skip',
        reason: 'directory-marker',
      });
    });
  });

  describe('named skip prefixes', () => {
    it.each([
      '.albumart/Artist/Album.jpg',
      '.covers/Artist/Album.jpg',
      '.waveforms/Artist/Album.json',
      'station IDs/legal-id-01.mp3',
      'test/fixture.mp3',
      'shows/2026-08-01.mp3',
    ])('skips %s under a named skip prefix', (key) => {
      expect(classifyObjectKey(key)).toEqual({ kind: 'skip', reason: 'skip-prefix' });
    });
  });

  describe('non-audio extensions', () => {
    it.each([
      'library/freeform/Artist/Album/liner.pdf',
      'library/freeform/Artist/Album/promo.mp4',
      'library/freeform/station.ini',
      'library/freeform/.DS_Store',
      'rotation/Heavy/session.atf',
    ])('skips %s as a non-audio extension', (key) => {
      expect(classifyObjectKey(key)).toEqual({ kind: 'skip', reason: 'non-audio-extension' });
    });
  });

  describe('objects outside the content prefixes', () => {
    it.each(['random-top-level-folder/track.mp3', 'library/other-subdir/track.mp3', 'rotation/Unknown/track.mp3'])(
      'skips %s as outside the content prefixes',
      (key) => {
        expect(classifyObjectKey(key)).toEqual({ kind: 'skip', reason: 'not-content-prefix' });
      }
    );
  });

  describe('library content, in scope', () => {
    it('classifies a freeform mp3', () => {
      expect(classifyObjectKey('library/freeform/Roméo Poirier/Living Room Session/03_track.mp3')).toEqual({
        kind: 'content',
        contentKind: 'freeform',
        codec: 'mp3',
      });
    });

    it('classifies a recently_rotated flat file', () => {
      expect(classifyObjectKey('library/recently_rotated/artist_-_album_-_01_title.flac')).toEqual({
        kind: 'content',
        contentKind: 'recently_rotated',
        codec: 'flac',
      });
    });

    it.each(['Heavy', 'Medium', 'Light', 'Singles'])('classifies a rotation/%s file', (bin) => {
      expect(classifyObjectKey(`rotation/${bin}/01_take_a_number.mp3`)).toEqual({
        kind: 'content',
        contentKind: 'rotation_bin',
        codec: 'mp3',
      });
    });

    // BS#2319 comment 4: m4a and wav are IN SCOPE, not skipped.
    it.each([
      ['library/freeform/Artist/Album/01.m4a', 'm4a'],
      ['library/freeform/Artist/Album/01.wav', 'wav'],
      ['library/freeform/Artist/Album/01.aac', 'aac'],
      ['library/freeform/Artist/Album/01.MP3', 'mp3'],
    ])('classifies %s as codec %s (case-insensitive extension)', (key, codec) => {
      expect(classifyObjectKey(key)).toEqual({ kind: 'content', contentKind: 'freeform', codec });
    });
  });

  describe('isRotationDerived', () => {
    it('is true for recently_rotated and rotation_bin', () => {
      expect(isRotationDerived('recently_rotated')).toBe(true);
      expect(isRotationDerived('rotation_bin')).toBe(true);
    });

    it('is false for freeform', () => {
      expect(isRotationDerived('freeform')).toBe(false);
    });
  });
});
