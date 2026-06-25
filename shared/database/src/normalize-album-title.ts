/**
 * Canonical album-title normalization (BS#1491 / catalog-popularity Phase-2
 * Track 1). The album-leg twin of `normalize-artist-name.ts`.
 *
 * Why a separate function from `normalizeArtistName`: the free-text resolution
 * dedup key is `(normalizeArtistName(artist), normalizeAlbumTitle(album))`.
 * `normalizeArtistName` deliberately does NOT strip edition suffixes — for an
 * artist name that would be wrong ("The The" must not lose "The"). But for an
 * album title, "Pet Sounds" and "Pet Sounds (Remastered)" and "Pet Sounds -
 * 2011 Remaster" are the SAME logical album; if they don't collapse to one
 * normalized key the Phase-2 popularity signal double-counts the same record
 * across pressings. This function strips the edition/remaster/format cruft that
 * `normalizeArtistName` leaves intact.
 *
 * Unlike `normalizeArtistName`, this function has NO SQL twin. Track 2's
 * collapse reads the persisted `flowsheet_freetext_resolution.norm_album`
 * column; it never re-normalizes in SQL. So there's no cross-engine
 * byte-identity contract — only the dedup-key stability contract pinned by
 * `tests/unit/database/normalize-album-title.test.ts`. If the table of cases
 * there changes, the resolution cron must re-run to re-key existing rows.
 *
 * Transformation pipeline (order matters):
 *   1. Coalesce null/undefined to '' (total, like the artist twin).
 *   2. Lowercase.
 *   3. Drop featuring clauses (`feat.` / `featuring` / `ft.`, parenthesized or
 *      trailing).
 *   4. Strip edition/format parentheticals + bracketed + trailing-dash suffixes
 *      (remaster, deluxe/expanded/anniversary edition, mono/stereo, soundtrack).
 *   5. Collapse the self-titled family (`s/t`, `self titled`, `selftitled`, …)
 *      to the single token `self-titled`.
 *   6. Canonicalize `&` → `and` and expand common abbreviations (`vol.` →
 *      `volume`, `pt.` → `part`).
 *   7. Collapse internal whitespace and trim.
 *
 * The result is total over any input and idempotent on already-normalized
 * titles.
 */

/** Edition / format descriptors that mark a parenthetical (or trailing-dash)
 * clause as non-identifying pressing cruft to strip. Matched
 * case-insensitively as a whole word inside the clause. */
const EDITION_KEYWORDS = [
  'remaster',
  'remastered',
  'deluxe',
  'expanded',
  'anniversary',
  'edition',
  'mono',
  'stereo',
  'reissue',
  'bonus',
  'special edition',
  'collector',
  'original motion picture soundtrack',
  'motion picture soundtrack',
  'soundtrack',
  'ost',
].join('|');

// `\b` anchors so each keyword matches as a WHOLE WORD, not a substring:
// without them `ost`/`mono`/`stereo` match inside `lost`/`ghost`/`monologue`/
// `stereotype`, wrongly flagging non-edition clauses as cruft and collapsing
// distinct albums into one dedup key.
const EDITION_CLAUSE = new RegExp(`\\b(?:${EDITION_KEYWORDS})\\b`, 'i');

/** Self-titled sentinels the long tail of DJs typed for an eponymous record. */
const SELF_TITLED = /^(?:s\s*\/\s*t|self[\s-]*titled)$/i;

const stripFeaturing = (s: string): string =>
  s
    // Parenthesized/bracketed featuring clause: "(feat. X)", "[ft. Y]".
    .replace(/[([]\s*(?:feat\.?|featuring|ft\.?)\b[^)\]]*[)\]]/gi, ' ')
    // Trailing featuring clause with no brackets: "... featuring X" / "feat. X"
    // to end. The abbreviations require a trailing "." and every form requires
    // a following guest (`\s+\S`) so a bare content word like "Ft" in
    // "10 Ft Ganja Plant" or a trailing "Feat" is NOT treated as a marker.
    .replace(/\s+(?:featuring|feat\.|ft\.)\s+\S.*$/i, ' ');

const stripEditionSuffixes = (s: string): string => {
  let out = s;
  // Parenthesized or bracketed clauses whose contents look like an edition
  // descriptor (anywhere in the title, repeated). A non-edition parenthetical
  // like "(Live)" is preserved.
  out = out.replace(/[([][^)\]]*[)\]]/g, (clause) => (EDITION_CLAUSE.test(clause) ? ' ' : clause));
  // Trailing " - <edition>" dash clauses (Spotify/Apple style): "- Remastered",
  // "- 2011 Remaster". Only strip when the dash-clause is edition cruft.
  out = out.replace(/\s+-\s+[^-]*$/g, (clause) => (EDITION_CLAUSE.test(clause) ? ' ' : clause));
  return out;
};

const canonicalizeTokens = (s: string): string =>
  s
    .replace(/&/g, ' and ')
    .replace(/\bvol\b\.?/gi, 'volume')
    .replace(/\bpt\b\.?/gi, 'part');

export const normalizeAlbumTitle = (input: string | null | undefined): string => {
  const lowered = (input ?? '').toLowerCase();

  // Self-titled family collapses before any other rewrite so "S/T" doesn't get
  // mangled by the `&`/whitespace passes.
  if (SELF_TITLED.test(lowered.trim())) return 'self-titled';
  if (lowered.replace(/[\s-]/g, '') === 'selftitled') return 'self-titled';

  let out = lowered;
  out = stripFeaturing(out);
  out = stripEditionSuffixes(out);
  out = canonicalizeTokens(out);

  // Collapse all internal whitespace (POSIX class, matching the artist twin's
  // narrow separator philosophy) and trim.
  return out.replace(/[ \t\n\r\f\v]+/g, ' ').trim();
};
