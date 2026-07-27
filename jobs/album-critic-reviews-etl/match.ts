/**
 * Album matching for album-critic-reviews-etl (BS#1830).
 *
 * `matchItem` resolves a `CorpusItem`'s `(artist, album)` to a linked
 * `library.id` via the SAME `resolveLinkedAlbumId` the `/proxy/metadata/album`
 * serve path uses (`@wxyc/database`, extracted for exactly this job by
 * BS#1829) — exact match only, no fuzzy/pg_trgm, no matching against the
 * broader `library` catalog. That ceiling is deliberate (issue): it avoids
 * ever attaching a review to the wrong album.
 *
 * `stripAlbumDecoration` is a narrow, literal port of the issue's regex — a
 * trailing edition/format parenthetical. It is deliberately NOT
 * `normalizeAlbumTitle` (the broader free-text dedup normalizer in
 * `@wxyc/database`): that function also collapses self-titled records,
 * strips featuring clauses, and canonicalizes tokens, which would loosen
 * the exact-match ceiling this job is required to keep. The manifest
 * carries the raw, undecorated album title; this fallback exists only for
 * the case where the resolver's flowsheet-side key was entered WITH an
 * edition suffix a DJ typed (e.g. "Pet Sounds (Remastered)").
 */
import { resolveLinkedAlbumId } from '@wxyc/database';
import type { CorpusItem } from './manifest.js';

const DECORATION_SUFFIX = /\s*\((?:reissue|deluxe|remaster(?:ed)?|expanded|ep|deluxe edition)[^)]*\)\s*$/i;

export const stripAlbumDecoration = (album: string): string => album.replace(DECORATION_SUFFIX, '').trim();

/**
 * Resolve one item to a `library.id`, or `null` on a miss. Retries once
 * with the decoration-stripped title, but ONLY when stripping actually
 * changed the title — a no-op strip would otherwise cost a second,
 * identical DB round-trip for the common case of an undecorated title.
 */
export const matchItem = async (item: CorpusItem): Promise<number | null> => {
  const direct = await resolveLinkedAlbumId(item.artist, item.album);
  if (direct !== null) return direct;

  const stripped = stripAlbumDecoration(item.album);
  if (stripped === item.album) return null;

  return resolveLinkedAlbumId(item.artist, stripped);
};
