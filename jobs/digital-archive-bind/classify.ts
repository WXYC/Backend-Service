/**
 * Read-only classification of a Space object key (BS#2319 §"Where"): which
 * objects are library content worth inventorying, and which are noise the
 * job must skip. Pure and side-effect-free so the skip rules are unit
 * testable without touching S3.
 *
 * Content prefixes (issue body): `library/freeform/` (full albums,
 * `Artist/Album/NN track.ext`), `library/recently_rotated/` (flat,
 * `artist_-_album_-_NN_title.ext`), `rotation/{Heavy,Medium,Light,Singles}/`
 * (flat, inconsistent). Everything else — named skip prefixes, directory
 * markers, non-audio extensions, or simply outside those prefixes — is
 * skipped and reported, never silently dropped (the run summary counts each
 * skip reason).
 *
 * codec allowlist is `[mp3, aac, flac, m4a, wav]` (wxyc-shared 1.50.0 /
 * `digital_asset_file.codec`, pinned by issue comment 4 — m4a and wav are IN
 * SCOPE, not skipped, despite an earlier draft of the skip list).
 */

export type SkipReason = 'directory-marker' | 'skip-prefix' | 'non-audio-extension' | 'not-content-prefix';

export type ContentKind = 'freeform' | 'recently_rotated' | 'rotation_bin';

export type ClassifiedObject =
  { kind: 'skip'; reason: SkipReason } | { kind: 'content'; contentKind: ContentKind; codec: string };

/** `digital_asset_file.codec` vocabulary, keyed by lowercased file extension. */
export const AUDIO_EXTENSION_CODEC: Readonly<Record<string, string>> = {
  mp3: 'mp3',
  aac: 'aac',
  flac: 'flac',
  m4a: 'm4a',
  wav: 'wav',
};

/** Non-library-content prefixes named explicitly in the issue body. */
const SKIP_PREFIXES: readonly string[] = ['.albumart/', '.covers/', '.waveforms/', 'station IDs/', 'test/', 'shows/'];

const ROTATION_BINS: readonly string[] = ['Heavy', 'Medium', 'Light', 'Singles'];

const FREEFORM_PREFIX = 'library/freeform/';
const RECENTLY_ROTATED_PREFIX = 'library/recently_rotated/';

export const classifyObjectKey = (objectKey: string): ClassifiedObject => {
  if (objectKey.endsWith('/')) return { kind: 'skip', reason: 'directory-marker' };
  if (SKIP_PREFIXES.some((prefix) => objectKey.startsWith(prefix))) {
    return { kind: 'skip', reason: 'skip-prefix' };
  }

  const extensionMatch = /\.([a-zA-Z0-9]+)$/.exec(objectKey);
  const extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
  const codec = AUDIO_EXTENSION_CODEC[extension];
  if (!codec) return { kind: 'skip', reason: 'non-audio-extension' };

  if (objectKey.startsWith(FREEFORM_PREFIX)) return { kind: 'content', contentKind: 'freeform', codec };
  if (objectKey.startsWith(RECENTLY_ROTATED_PREFIX)) return { kind: 'content', contentKind: 'recently_rotated', codec };
  for (const bin of ROTATION_BINS) {
    if (objectKey.startsWith(`rotation/${bin}/`)) return { kind: 'content', contentKind: 'rotation_bin', codec };
  }

  return { kind: 'skip', reason: 'not-content-prefix' };
};

/**
 * Match precedence (issue step 4): rotation-derived prefixes
 * (`recently_rotated/`, `rotation/{bin}/`) match against `rotation` first;
 * `freeform/` matches against `library`.
 */
export const isRotationDerived = (contentKind: ContentKind): boolean =>
  contentKind === 'recently_rotated' || contentKind === 'rotation_bin';
