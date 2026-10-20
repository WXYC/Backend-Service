/**
 * Comma splitter for the `wxyc_library_credit` alias source (BS#3554).
 *
 * The librarian files a member's solo or side-project record under the
 * band's card and names the member in `library.alternate_artist_name`, often
 * as a multi-name credit (`Rhiannon Giddens, Our Native Daughters` on the
 * Carolina Chocolate Drops card). Catalog search scores the whole joined
 * `wxyc_library_alt` string with trigram similarity, so a name inside a long
 * credit falls under the BS#2018 0.40 floor. Each name becomes its own
 * `wxyc_library_credit` row. The source is RELATIONAL (a member or
 * collaborator credit, not a spelling variant), so the concerts resolver
 * never resolves a headliner through it.
 *
 * The rules are conservative, from the BS#3554 survey of the 2026-09-14
 * library.db snapshot and the PR #3560 review. The job README lists them.
 */

import { normalizeArtistName } from '@wxyc/database';

const NAME_SUFFIX = /^(jr|sr|iv|ii|iii|inc|ltd|llc|co|bros|esq|the)\.?$/i;
const NOT_A_NAME = /^(et al|etc)\.?$/i;
const BRACKET = /[[\]()]/;
const LEADING_JOINER = /^(and|&)\s+/i;
const INNER_JOINER = /&|\sand\s/i;

/**
 * The distinct names in one comma-joined credit, keyed by their normalized
 * form, or an empty map when the value is not a multi-name credit.
 */
const namesInCredit = (value: string): Map<string, string> => {
  const none = new Map<string, string>();
  // Commas inside brackets are a lineup (`… Quartet [with Don Cherry, …]`).
  if (BRACKET.test(value)) {
    return none;
  }

  const pieces: string[] = [];
  for (const raw of value.split(',')) {
    const piece = raw.trim();
    if (piece.length === 0) {
      continue;
    }
    // `Josh White, Jr.` and `Spizzles, The` are one name each.
    if (pieces.length > 0 && NAME_SUFFIX.test(piece)) {
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1]}, ${piece}`;
    } else {
      pieces.push(piece);
    }
  }
  if (pieces.length < 2) {
    return none;
  }

  // `…, and Steve Stills` loses its joiner. A joiner left INSIDE the last
  // piece marks a comma band name (`Earth, Wind & Fire`): leave it whole.
  const last = pieces[pieces.length - 1].replace(LEADING_JOINER, '');
  if (INNER_JOINER.test(last)) {
    return none;
  }
  pieces[pieces.length - 1] = last;

  const byKey = new Map<string, string>();
  for (const piece of pieces) {
    const key = normalizeArtistName(piece);
    if (!NOT_A_NAME.test(piece) && !byKey.has(key)) {
      byKey.set(key, piece);
    }
  }
  // Two distinct names (the owner counts) make a multi-name credit.
  return byKey.size < 2 ? none : byKey;
};

/**
 * The names to write as `wxyc_library_credit` rows for one artist.
 *
 * A name is written only when it has at least two words (a bare `Miller` from
 * `Sauter, Dietrich, Miller` would match a whole discography at similarity
 * 1.0), is not the owner's own name, and is not already one of the artist's
 * `wxyc_library_alt` values (a tied duplicate would flap the reported
 * `matched_source`). Names compare through `normalizeArtistName`, the key the
 * writer and the resolver use, and each is written once.
 *
 * @param alts The artist's distinct `library.alternate_artist_name` values
 *   (each is also written as a `wxyc_library_alt` row).
 * @param ownerName The `artists.artist_name` the values are filed under.
 * @returns The names in first-seen order; `[]` when there are none.
 */
export const splitLibraryCredits = (alts: string[], ownerName: string): string[] => {
  const taken = new Set([ownerName, ...alts].map(normalizeArtistName));
  const names: string[] = [];
  for (const alt of alts) {
    for (const [key, name] of namesInCredit(alt)) {
      if (/\s/.test(name) && !taken.has(key)) {
        taken.add(key);
        names.push(name);
      }
    }
  }
  return names;
};
