/**
 * Comma splitter for the `wxyc_library_credit` alias source (BS#3554).
 *
 * `library.alternate_artist_name` often holds a multi-name credit — the
 * librarian files a member's solo or side-project record under the band's
 * card and names the member there (`Rhiannon Giddens, Our Native
 * Daughters` on the Carolina Chocolate Drops card). Catalog search scores
 * the whole joined string with trigram similarity, so a name inside a long
 * credit falls under the BS#2018 0.40 floor and cannot be found. Each name
 * becomes its own `wxyc_library_credit` row; the joined value keeps its
 * `wxyc_library_alt` row unchanged.
 *
 * The source is RELATIONAL (a member or collaborator credit, not a
 * spelling variant), so `jobs/concerts-artist-resolver/query.ts` lists it
 * in `RELATIONAL_ALIAS_SOURCES` and never resolves a headliner through it.
 *
 * Rules are deliberately conservative, from the BS#3554 survey of the
 * 2026-09-14 library.db snapshot (358 comma-bearing values):
 *   - Split on `,` only. `&`, ` and `, `/` join real names
 *     (`Duke Ellington & John Coltrane`), as BS#1344 warned.
 *   - A value with brackets or parentheses is a lineup
 *     (`… Quartet [with Don Cherry, …]`) and is left whole.
 *   - A name suffix after a comma (`Jr.`, `Sr.`, `Inc.`, `Ltd.`, `The`,
 *     `II`, `III`) rejoins the piece before it (`Josh White, Jr.`).
 *   - A leading `and ` on the last piece is stripped (`…, and Steve Stills`).
 *   - Fewer than two pieces: nothing to split.
 *   - Exactly two one-word pieces is an inverted personal name
 *     (`Frith, Fred`); splitting it would alias a bare given name. This
 *     costs one real case (Grouper's `Helen, Pumice`).
 *   - Drop `et al` / `etc`, the owning artist's own name (normalized via
 *     `normalizeArtistName`, so a leading "The" and case don't matter), and
 *     duplicates.
 */

import { normalizeArtistName } from '@wxyc/database';

const NAME_SUFFIX = /^(jr|sr|inc|ltd|the|ii|iii)\.?$/i;
const NOT_A_NAME = /^(et al|etc)\.?$/i;
const BRACKET = /[[\]()]/;

/**
 * Split one `alternate_artist_name` value into the single names it credits,
 * for the `wxyc_library_credit` source. Returns `[]` when the value is not a
 * multi-name credit under the rules above, so the caller writes no rows.
 *
 * @param value The raw `library.alternate_artist_name` text.
 * @param ownerName The `artists.artist_name` the value is filed under; a
 *   piece that normalizes to it is dropped because it adds nothing.
 */
export const splitLibraryCredit = (value: string, ownerName: string): string[] => {
  if (BRACKET.test(value)) {
    return [];
  }

  const pieces: string[] = [];
  for (const raw of value.split(',')) {
    const piece = raw.trim();
    if (piece.length === 0) {
      continue;
    }
    if (pieces.length > 0 && NAME_SUFFIX.test(piece)) {
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1]}, ${piece}`;
    } else {
      pieces.push(piece);
    }
  }
  if (pieces.length > 0) {
    pieces[pieces.length - 1] = pieces[pieces.length - 1].replace(/^and\s+/i, '');
  }

  if (pieces.length < 2) {
    return [];
  }
  if (pieces.length === 2 && pieces.every((p) => !/\s/.test(p))) {
    return [];
  }

  const owner = normalizeArtistName(ownerName);
  const names: string[] = [];
  for (const piece of pieces) {
    if (piece.length === 0 || NOT_A_NAME.test(piece) || normalizeArtistName(piece) === owner) {
      continue;
    }
    if (!names.includes(piece)) {
      names.push(piece);
    }
  }
  return names;
};
