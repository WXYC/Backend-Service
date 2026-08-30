/**
 * Album grouping (BS#2319 step 3): files sharing normalized
 * `(album_artist ?? artist, album)` become one candidate album, further
 * split by disc number since `digital_asset`'s unique key is
 * `(library_id, provenance, disc_number)`.
 *
 * Content kind is part of the grouping key too, even though the issue's
 * grouping step doesn't name it: `contentKind` decides which table the
 * matcher tries (`rotation` vs `library`, step 4), and two objects that
 * happen to share tags but live under different content prefixes are
 * physically different uploads, not the same album split across
 * directories in practice.
 */

import { albumGroupKey, artistFoldKey } from './normalize.js';
import type { CandidateAlbum, InventoryFile } from './types.js';
import { normalizeAlbumTitle } from '@wxyc/database';

export interface GroupResult {
  albums: CandidateAlbum[];
  /** Files whose tags carry no usable artist AND album -- can't be grouped. */
  ungroupable: InventoryFile[];
}

const isBlank = (s: string | null | undefined): boolean => !s || s.trim().length === 0;

export const groupIntoAlbums = (files: readonly InventoryFile[]): GroupResult => {
  const groups = new Map<string, CandidateAlbum>();
  const ungroupable: InventoryFile[] = [];

  for (const file of files) {
    const { tags } = file;
    const artist = tags.albumArtist ?? tags.artist;
    if (isBlank(artist) || isBlank(tags.album)) {
      ungroupable.push(file);
      continue;
    }

    const discNumber = tags.disc ?? 1;
    const key = `${file.contentKind}::${albumGroupKey(tags.albumArtist, tags.artist, tags.album)}::disc${discNumber}`;

    const existing = groups.get(key);
    if (existing) {
      existing.files.push(file);
      continue;
    }

    groups.set(key, {
      contentKind: file.contentKind,
      artistFoldKey: artistFoldKey(artist),
      albumNormKey: normalizeAlbumTitle(tags.album),
      discNumber,
      displayArtist: artist as string,
      displayAlbum: tags.album as string,
      files: [file],
    });
  }

  const albums = [...groups.values()];
  for (const album of albums) {
    album.files.sort((a, b) => (a.tags.track ?? 0) - (b.tags.track ?? 0) || a.objectKey.localeCompare(b.objectKey));
  }

  return { albums, ungroupable };
};
