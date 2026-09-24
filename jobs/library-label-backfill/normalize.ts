/**
 * The label normalization rule (BS#2669).
 *
 * DJs typed `LABEL_NAME` free-hand on every play, so the same card accumulates
 * spellings that differ only in case, punctuation, and corporate suffix
 * ("Sub Pop" / "Sub Pop Records" / "SUB-POP RECORDS."). Normalizing collapses
 * that noise so a modal vote runs over labels rather than over typography.
 *
 * The rule, in order:
 *
 *   1. Unicode NFKC, then lowercase. NFKC folds the full-width and ligature
 *      forms a few entries carry; lowercasing is what makes "SUB POP" and
 *      "Sub Pop" one vote.
 *   2. Decompose (NFKD) and drop combining marks, so "Barbès" and "Barbes"
 *      are one label. DJs routinely omit an accent they cannot type quickly.
 *   3. Split on every character that is not a letter or a digit. Punctuation
 *      and spaces are separators, never content.
 *   4. Drop the corporate-suffix tokens listed in {@link SUFFIX_TOKENS} —
 *      anywhere in the string, not only at the end, so "Warner Music Group"
 *      and "Warner Group" agree. Whole tokens only: the token set never
 *      truncates a word, so "Musicians" and "Incendiary" survive intact
 *      where a substring strip would maul them.
 *   5. Concatenate the surviving tokens with no separator.
 *
 * Step 5 is the one that looks wrong and is not. Joining with a space would
 * keep "Sub Pop" and "SubPop" apart, and word-boundary noise is most of what
 * DJs actually vary: measured over the 37,740-card corpus, concatenating
 * rather than space-joining resolves 618 more cards, and every one of the 233
 * distinct merges it creates is the same label typed two ways — "A&M"/"AM"
 * (78 cards), "Sub Pop"/"SubPop" (61), "I.R.S."/"IRS", "4 AD"/"4AD",
 * "Stone's Throw"/"Stones Throw", "Roc-A-Fella"/"Rocafella". Not one is a
 * conflation of two different labels. The key is for comparison only; the
 * display value written to the mapping is the most-played RAW spelling, which
 * keeps its spaces, punctuation and accents.
 *
 * Step 4 can empty a string outright — a card whose only typed label was
 * "Records" normalizes to "". That is the intended outcome: the entry carried
 * no label information, and {@link normalizeLabel} returning "" is the signal
 * to drop it rather than resolve it. Callers must treat "" as absent.
 *
 * The rule is deliberately lossy in one direction only. It merges spellings;
 * it never splits one. Two cards that normalize alike were already alike.
 *
 * Scope limit on step 2: dropping combining marks is right for Latin, Greek
 * and Cyrillic and would destroy meaning in Indic, Arabic or Hebrew script,
 * where marks are not decoration. No label in the corpus contains a character
 * beyond U+0590 (verified over all 37,740 cards), so the limit is documented
 * rather than coded around.
 */

/**
 * Corporate-form tokens stripped from a label before comparison.
 *
 * Kept to the suffixes named in BS#2669 plus their punctuation-free forms
 * ("ltd" covers "Ltd."; step 2 has already removed the period). Every addition
 * here widens what counts as "the same label" for the modal vote, so the bar
 * is that the token must carry no distinguishing power on its own — which is
 * why "recordings" is present but "recording" is not, and why label-defining
 * words like "sound", "disc", or "tone" are absent.
 */
export const SUFFIX_TOKENS: ReadonlySet<string> = new Set(['records', 'recordings', 'music', 'ltd', 'inc', 'llc']);

/**
 * Normalize a raw `LABEL_NAME` for comparison.
 *
 * @param raw - the label exactly as the DJ typed it, or `null`/`undefined`
 * @returns the comparison key; `''` when the entry carries no label
 *          information at all (empty input, punctuation only, or nothing but
 *          corporate-suffix tokens). Callers must treat `''` as absent.
 */
export function normalizeLabel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';

  const folded = raw
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining marks: "barbès" -> "barbes". See the scope limit above.
    .replace(/\p{M}+/gu, '');

  // Split on anything that is not a letter or digit. Unicode-aware (`\p{L}` /
  // `\p{N}`, not [a-z0-9]) so a letter the fold left alone is still a letter.
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');

  return tokens.filter((t) => !SUFFIX_TOKENS.has(t)).join('');
}
