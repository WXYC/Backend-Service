import { normalizeArtistName } from './normalize-artist-name.js';
import { normalizeAlbumTitle } from './normalize-album-title.js';

/**
 * SINGLE SOURCE OF TRUTH for the free-text `(norm_artist, norm_album)` dedup
 * key used by the catalog-popularity Phase-2 pipeline (BS#1486). Shared by:
 *
 *   - Track 1 — `jobs/catalog-popularity-freetext-resolve/` (#1491) — which
 *     WRITES this pair as the composite PK of `flowsheet_freetext_resolution`.
 *   - Track 2 — `apps/backend/services/album-popularity-refresh.service.ts`
 *     (#1492) — which RE-DERIVES the same pair from raw `flowsheet` text to
 *     attribute free-text plays back to their resolution row.
 *
 * If those two derivations diverge by even one byte, free-text plays silently
 * fail to join their resolution and drop out of the popularity signal — the
 * exact under-count this pipeline exists to fix. Both consumers call this one
 * function so drift is impossible; pinned by
 * `tests/unit/database/freetext-norm.test.ts`.
 *
 * The artist leg is `normalizeArtistName` (lowercase + strip a leading "The ")
 * THEN collapse internal whitespace + trim — `normalizeArtistName` itself
 * deliberately does NOT collapse internal whitespace (a deliberate choice for
 * its SQL-twin contract), so without this extra pass 'J Dilla ' / 'J  Dilla' /
 * 'J Dilla' would split into distinct keys. The album leg is
 * `normalizeAlbumTitle`, which already collapses + trims and strips edition
 * cruft (no SQL twin).
 */
export const normalizeFreetextArtist = (artist: string | null | undefined): string =>
  normalizeArtistName(artist)
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim();

export const freetextPairKey = (
  artist: string | null | undefined,
  album: string | null | undefined
): { norm_artist: string; norm_album: string } => ({
  norm_artist: normalizeFreetextArtist(artist),
  norm_album: normalizeAlbumTitle(album),
});
