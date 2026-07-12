/**
 * Clean-headliner extraction (BS#1604) + the clean-name LML gate (BS#1614).
 *
 * Extracted from map.ts so this module stays free of `@wxyc/database`
 * (whose client throws at import time without DB_* env vars) — the
 * BS#1614 name-set export script filters text dumps anywhere, without DB
 * credentials. map.ts re-exports `extractHeadliner`, so ETL-side
 * consumers are unchanged.
 *
 * triangle-shows' `artist` field is byte-identical to the event `name`
 * in practice — the full marquee/billing string, not a clean performer —
 * which starves the exact-match `concerts-artist-resolver` (9/259
 * distinct billings resolved). Until the upstream `headliner` field
 * (WXYC/triangle-shows#18) covers the corpus, derive a clean headliner
 * here. TRIANGLE_SHOWS-SPECIFIC by design: RHP headliners are already
 * clean, and the shared resolver stays untouched.
 *
 * Conservative by contract: prefer under-stripping — a billing left
 * dirty just stays unresolved (today's behavior), while over-stripping
 * can mangle a legitimate name into a WRONG resolution. `&`/`and` are
 * never treated as support delimiters (Andy Frasco & The U.N), and a
 * leading single mixed-case parenthetical word is kept ((Sandy) Alex
 * G) — only tag-shaped parentheticals strip. Idempotent: every rule
 * removes its own trigger, and the empty-result fallback returns a
 * string none of the rules re-fire on.
 *
 * `isCleanHeadliner` (BS#1614) sits beside the extractor ON PURPOSE: the
 * gate that decides which stored names are LML-eligible must evolve in
 * the same file as the extraction rules it composes with, so the two
 * can't drift apart (the constraint recorded on WXYC/Backend-Service#1614).
 */

/** Leading `(...)`/`[...]` group plus trailing whitespace; content captured
 *  so `isStrippableLeadingTag` can rule on it. Anchored — only LEADING
 *  parentheticals are candidates; trailing ones (`!!! (Chk Chk Chk)`) are
 *  part of the name. */
const LEADING_TAG = /^[([]([^)\]]*)[)\]]\s*/;

/**
 * Ticketing/venue noise phrases that mark a mixed-case leading parenthetical
 * as strippable even when it isn't all-caps or digit-bearing (`(Sold Out)`,
 * `(Moved to the Ritz)`, `(Record Shop)`). Word-boundary anchored, not a
 * bare substring, so a band name that merely CONTAINS a noise word
 * (`(Free Energy)`, `(Moved by Music)`) stays attached — the conservative
 * contract prefers leaving an unknown parenthetical over guessing it's a
 * tag. Deliberately small and phrase-specific.
 */
const NOISE_PATTERNS = [
  /\bsold[\s-]?out\b/,
  /\blow tix\b/,
  /\brecord shop\b/,
  /\bmoved to\b/,
  /\bcancell?ed\b/,
  /\bpostponed\b/,
  /\brescheduled\b/,
];

/**
 * Venue tags look like `(Record Shop)`, `(LOW TIX)`, `(18+)`, `(SOLD
 * OUT)`, `[MOVED TO THE RITZ]` — all-caps, digit/age-gate-bearing, or a
 * recognizable ticketing/venue noise phrase. A leading parenthetical that
 * is merely multi-word is NOT enough: a real multi-word band name can lead
 * a billing (`(Free Energy) Truth Club`), and the conservative contract
 * prefers keeping it over guessing it's a tag. The `toLowerCase` half of
 * the all-caps test keeps caseless scripts from counting as "all caps".
 */
const isStrippableLeadingTag = (content: string): boolean => {
  const tag = content.trim();
  if (tag === '') return true; // pure noise, e.g. '()'
  if (/\d/.test(tag)) return true; // digit / age-gate: (18+)
  const letters = tag.replace(/[^\p{L}]+/gu, '');
  if (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return true;
  const lower = tag.toLowerCase();
  return NOISE_PATTERNS.some((pattern) => pattern.test(lower));
};

/** `An Evening With: X` / `An Evening With X` — the framing is never the
 *  performer. Requires a colon or whitespace after `with` so a band name
 *  merely STARTING with the phrase (`An Evening Withering`) is untouched. */
const AN_EVENING_WITH = /^an evening with[:\s]+/i;

/** `<Promoter> Presents: X` — colon REQUIRED: `X Presents Y` without one
 *  is too weak a signal (plausibly a name), and `[^:]*` keeps the strip
 *  from eating past other colon structure in the billing. */
const PRESENTS_PREFIX = /^[^:]*\bpresents\s*:\s*/i;

/**
 * Support-act tails: ` w/ X`, ` // X // Y`, ` feat. X`, ` ft. X`,
 * ` featuring X`. Every delimiter requires LEADING whitespace so
 * slash-bearing names (`AC/DC`) never split; `w/`+`//` allow a missing
 * space after the token (`w/Magick Potion` occurs in the wild) while the
 * word-shaped forms require one so a name merely containing the letters
 * (`Featherweight`) is safe. Plain ` with `, `&`, `and`, `+` are NOT
 * delimiters — far too common inside legitimate names. The `w/(?!o(?:ut)?\b)`
 * negative lookahead keeps `w/` from firing on the abbreviations `w/o` and
 * `w/out` — those mean "without" and belong to the name (`Angel w/o Wings`),
 * not a support delimiter.
 */
const SUPPORT_TAIL = /\s+(?:w\/(?!o(?:ut)?\b)|\/\/)\s*\S.*$|\s+(?:feat\.|ft\.|featuring)\s+\S.*$/i;

/** Punctuation a tail/prefix strip can leave dangling (`Foo -` after
 *  `Foo - w/ Bar`). Terminal `!`/`?`/`.` are kept — they end real names. */
const TRAILING_DANGLE = /[\s,;:\-–—]+$/;

/**
 * The full cleanup pass over a trimmed billing. May return `''` when the
 * billing was pure tag/framing noise — `extractHeadliner` maps that back
 * to the verbatim input (better stored than dropped), while
 * `isCleanHeadliner` uses the raw `''` to reject the residue outright.
 */
const cleanBilling = (original: string): string => {
  let cleaned = original;
  let stripped = false;
  // Strip the support-act tail FIRST. `PRESENTS_PREFIX` (below) is greedy
  // to the last colon, so running it before the tail strip lets a promoter
  // clause buried in a support tail eat the real headliner
  // (`Deerhoof w/ Hopscotch Presents: Late Night Set` -> `Late Night Set`).
  // Removing the tail up front leaves the leading fixpoint only the
  // headliner + its framing to work on.
  const afterTail = cleaned.replace(SUPPORT_TAIL, '');
  if (afterTail !== cleaned) {
    cleaned = afterTail;
    stripped = true;
  }
  // Leading structures repeat and stack — `(LOW TIX) (18+) An Evening
  // With: X` — so strip to a fixpoint. Terminates: every pass that
  // doesn't break strictly shortens the string.
  for (;;) {
    const before = cleaned;
    const tag = LEADING_TAG.exec(cleaned);
    if (tag && isStrippableLeadingTag(tag[1])) {
      cleaned = cleaned.slice(tag[0].length).trimStart();
    }
    cleaned = cleaned.replace(AN_EVENING_WITH, '').replace(PRESENTS_PREFIX, '').trimStart();
    if (cleaned === before) break;
    stripped = true;
  }
  // Only clean a dangling separator when a strip actually fired — otherwise
  // a verbatim name that legitimately ends in punctuation (`Sleep Token —`)
  // would be silently altered.
  if (stripped) cleaned = cleaned.replace(TRAILING_DANGLE, '');
  return cleaned.trim();
};

/**
 * Derive a clean headliner from a billing string. Exported for the unit
 * suite. Returns the trimmed input unchanged when no rule fires, and
 * falls back to the trimmed input when cleanup empties the string (a
 * pure-tag billing like `(SOLD OUT)` is still better stored verbatim
 * than dropped — it just stays unresolved, exactly like today).
 */
export const extractHeadliner = (billing: string): string => {
  const original = billing.trim();
  const cleaned = cleanBilling(original);
  return cleaned === '' ? original : cleaned;
};

/**
 * Multi-act billing markers the extractor deliberately leaves in place
 * (BS#1614). Keyed by reason so the export script's measurement can
 * report a per-delimiter breakdown; `HARD_BILLING_DELIMITERS` is the
 * derived union the gate tests.
 *
 * Spacing is load-bearing: ` / ` and ` + ` require whitespace on both
 * sides so `AC/DC` / `DIIV/Horsegirl` never gate; ` with ` requires
 * surrounding whitespace so `With Honor` / `Withered Hand` never gate.
 * `&`/`and` are deliberately ABSENT: the BS#1613 prod-sample analysis
 * found that bucket dominated by real single acts (`AJ Lee & Blue
 * Summit`, `Nick Cave and the Bad Seeds`), and under LML#759's
 * verify-before-mint model a genuine `&` co-bill can't exact-form-match
 * a Discogs artist — it just returns not_found. Excluding the bucket
 * would trade real recall for one saved API call.
 */
export const BILLING_DELIMITER_PATTERNS = {
  comma: /,/,
  plus: /\s\+\s/,
  slash: /\s\/\s/,
  with: /\swith\s/i,
} as const;

/**
 * Literal union of `BILLING_DELIMITER_PATTERNS` (a derived `new RegExp`
 * would trip security/detect-non-literal-regexp for no safety gain on a
 * compile-time const tuple). The unit suite pins this literal to the
 * per-reason record so the two cannot drift.
 */
export const HARD_BILLING_DELIMITERS = /,|\s\+\s|\s\/\s|\swith\s/i;

/**
 * Is a stored headliner name eligible for the LML#759 bare-name resolve
 * pass (BS#1614)?
 *
 * Clean means: extraction has nothing left to do on it (`cleanBilling`
 * fixpoint — which also rejects pure-tag billings whose cleanup empties
 * to `''`, the case `extractHeadliner`'s verbatim fallback would hide),
 * and it carries no hard multi-act delimiter.
 *
 * This is an API-BUDGET gate, not a correctness gate: under
 * verify-before-mint a dirty name that slips through wastes one Discogs
 * call and lands `not_found`, while a clean name wrongly gated just
 * stays unresolved (status quo). Both failure modes are cheap, so the
 * gate stays simpler than the extractor.
 */
export const isCleanHeadliner = (name: string): boolean => {
  const trimmed = name.trim();
  if (trimmed === '') return false;
  if (cleanBilling(trimmed) !== trimmed) return false;
  return !HARD_BILLING_DELIMITERS.test(trimmed);
};
