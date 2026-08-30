import { groupIntoAlbums } from '../../../../jobs/digital-archive-bind/group';
import type { InventoryFile } from '../../../../jobs/digital-archive-bind/types';

const emptyTags = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  track: null,
  disc: null,
  durationMs: null,
};

const file = (overrides: Partial<InventoryFile> & { objectKey: string }): InventoryFile => ({
  contentKind: 'freeform',
  codec: 'mp3',
  bytes: 1000,
  md5: null,
  tags: { ...emptyTags },
  ...overrides,
});

describe('digital-archive-bind group', () => {
  it('groups files sharing normalized (album_artist ?? artist, album)', () => {
    const files: InventoryFile[] = [
      file({
        objectKey: 'library/freeform/A/01.mp3',
        tags: { ...emptyTags, artist: 'Jessica Pratt', album: 'On Your Own Love Again', track: 1 },
      }),
      file({
        objectKey: 'library/freeform/A/02.mp3',
        tags: { ...emptyTags, artist: 'jessica pratt', album: 'ON YOUR OWN LOVE AGAIN', track: 2 },
      }),
    ];

    const { albums, ungroupable } = groupIntoAlbums(files);
    expect(ungroupable).toHaveLength(0);
    expect(albums).toHaveLength(1);
    expect(albums[0].files.map((f) => f.objectKey).sort()).toEqual([
      'library/freeform/A/01.mp3',
      'library/freeform/A/02.mp3',
    ]);
  });

  it('splits by discNumber -- a multi-disc set is one candidate per disc', () => {
    const files: InventoryFile[] = [
      file({
        objectKey: 'library/freeform/B/d1-01.mp3',
        tags: { ...emptyTags, artist: 'Artist', album: 'Double Album', disc: 1 },
      }),
      file({
        objectKey: 'library/freeform/B/d2-01.mp3',
        tags: { ...emptyTags, artist: 'Artist', album: 'Double Album', disc: 2 },
      }),
    ];

    const { albums } = groupIntoAlbums(files);
    expect(albums).toHaveLength(2);
    expect(albums.map((a) => a.discNumber).sort()).toEqual([1, 2]);
  });

  it('defaults discNumber to 1 when TPOS is absent', () => {
    const files: InventoryFile[] = [
      file({ objectKey: 'library/freeform/C/01.mp3', tags: { ...emptyTags, artist: 'Artist', album: 'Album' } }),
    ];
    const { albums } = groupIntoAlbums(files);
    expect(albums[0].discNumber).toBe(1);
  });

  it('keeps groups from different content kinds separate even with identical tags', () => {
    const files: InventoryFile[] = [
      file({
        objectKey: 'library/freeform/D/01.mp3',
        contentKind: 'freeform',
        tags: { ...emptyTags, artist: 'Same Artist', album: 'Same Album' },
      }),
      file({
        objectKey: 'rotation/Heavy/01.mp3',
        contentKind: 'rotation_bin',
        tags: { ...emptyTags, artist: 'Same Artist', album: 'Same Album' },
      }),
    ];
    const { albums } = groupIntoAlbums(files);
    expect(albums).toHaveLength(2);
  });

  it('reports files with no usable artist+album as ungroupable rather than dropping them', () => {
    const files: InventoryFile[] = [file({ objectKey: 'library/freeform/E/untagged.mp3', tags: { ...emptyTags } })];
    const { albums, ungroupable } = groupIntoAlbums(files);
    expect(albums).toHaveLength(0);
    expect(ungroupable.map((f) => f.objectKey)).toEqual(['library/freeform/E/untagged.mp3']);
  });

  it("sorts a group's files by track number for deterministic display", () => {
    const files: InventoryFile[] = [
      file({
        objectKey: 'library/freeform/F/03.mp3',
        tags: { ...emptyTags, artist: 'Artist', album: 'Album', track: 3 },
      }),
      file({
        objectKey: 'library/freeform/F/01.mp3',
        tags: { ...emptyTags, artist: 'Artist', album: 'Album', track: 1 },
      }),
      file({
        objectKey: 'library/freeform/F/02.mp3',
        tags: { ...emptyTags, artist: 'Artist', album: 'Album', track: 2 },
      }),
    ];
    const { albums } = groupIntoAlbums(files);
    expect(albums[0].files.map((f) => f.tags.track)).toEqual([1, 2, 3]);
  });

  it('uses TPE2 (album artist) over TPE1 (artist) for the display artist', () => {
    const files: InventoryFile[] = [
      file({
        objectKey: 'library/freeform/G/01.mp3',
        tags: { ...emptyTags, artist: 'Thom Yorke', albumArtist: 'The Smile', album: 'Wall of Eyes' },
      }),
    ];
    const { albums } = groupIntoAlbums(files);
    expect(albums[0].displayArtist).toBe('The Smile');
  });
});
