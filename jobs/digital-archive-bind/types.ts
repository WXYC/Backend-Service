/**
 * Shared shapes threaded through the digital-archive-bind pipeline:
 * inventory (`store.ts` + `tags.ts`) -> grouping (`group.ts`) -> matching
 * (`match.ts`) -> writing (`write.ts`). Centralized so each stage's tests
 * can build fixtures against one contract instead of five ad-hoc ones.
 */

import type { ContentKind } from './classify.js';
import type { Id3Tags } from './id3.js';

/** One Space object the job decided is library content, tags resolved. */
export interface InventoryFile {
  objectKey: string;
  contentKind: ContentKind;
  codec: string;
  bytes: number;
  /** From the ETag, single-part uploads only (never set for a `-N` multipart ETag). */
  md5: string | null;
  tags: Id3Tags;
}

/**
 * One candidate album: files grouped on normalized `(album_artist ?? artist,
 * album)` (step 3) further split by `discNumber`, since `digital_asset`'s
 * unique key is `(library_id, provenance, disc_number)` -- a multi-disc set
 * is one candidate per disc, not one candidate for the whole set.
 */
export interface CandidateAlbum {
  contentKind: ContentKind;
  /** `foldArtistName(album_artist ?? artist)` -- the matcher's artist leg. */
  artistFoldKey: string;
  /** `normalizeAlbumTitle(album)` -- the matcher's exact-tier album leg. */
  albumNormKey: string;
  discNumber: number;
  /** Raw display values (first file's tags) for the CSV / report. */
  displayArtist: string;
  displayAlbum: string;
  files: InventoryFile[];
}

export type MatchTier = 'exact' | 'fuzzy';

export type MatchResult =
  | { kind: 'matched'; libraryId: number; tier: MatchTier; note: string }
  | { kind: 'ambiguous'; libraryIds: number[] }
  | { kind: 'unmatched' };

/** A candidate album the matcher resolved to exactly one `library.id`. */
export interface MatchedAlbum {
  candidate: CandidateAlbum;
  libraryId: number;
  tier: MatchTier;
  bindNote: string;
}
