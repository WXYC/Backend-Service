/**
 * Various-Artists credit detection for the BS#2000 remediation net.
 *
 * TypeScript mirror of `wxyc_etl.text.is_compilation_artist` — the org's
 * canonical V/A detector, and specifically the predicate LML#1139's Apple
 * track guard keys on. This job exists to re-adjudicate exactly the rows that
 * guard would have struck, so selecting by any other rule would either miss
 * polluted rows or null correct URLs on rows the guard never touched.
 *
 * WHY A THIRD FILE, when two `compilation.ts` copies already exist here.
 * Because all three of this repo's existing V/A predicates disagree with
 * wxyc-etl, and this one must not:
 *
 *   1. `jobs/artist-search-alias-consumer/compilation.ts` and
 *      `apps/backend/services/requestLine/matching/compilation.ts` do a bare
 *      SUBSTRING scan (`artistLower.includes('various')`). That is the
 *      convention wxyc-etl 0.5.0 deliberately tightened away from: it sweeps
 *      up real WXYC artists — `Various Production`, `The Various`, `The
 *      Soundtrack of Our Lives`.
 *   2. `jobs/library-etl/job.ts` (the writer of the `artists`/`library` V/A
 *      credits these values are copied from) special-cases
 *      `/^various\s*artists\s*-rock\s*-[a-z]$/i` to `isVarious: false` — the
 *      exact opposite of wxyc-etl's own pinned case
 *      (`("Various Artists-Rock-Y", true)`).
 *
 * Both of those `compilation.ts` files carry an explicit "keep in lockstep —
 * both files must agree on the keyword set" contract in their headers. Adding
 * a third same-named, same-signature `isCompilationArtist` whose whole purpose
 * is to DISAGREE with them would invite precisely the lockstep-reconciliation
 * edit this job must never receive, and would leave a future reader vendoring
 * "the" `compilation.ts` with a 2-in-3 chance of grabbing a substring version.
 * Hence a distinct filename and a distinct export name. Reconciling the
 * existing three is out of scope — separate blast radius, separate ticket.
 *
 * THE FOLD IS IMPORTED, NOT REIMPLEMENTED. `foldArtistName` (`@wxyc/database`,
 * migration 0134's `wxyc_schema.fold_artist_name(text)` twin, BS#1897) is the
 * same fold the SQL candidate net applies, so the net and this arbiter agree
 * by construction rather than by assertion. Earlier drafts hand-rolled an
 * NFKC/NFKD pass; NFKC is a *composing* form so the combining-mark strip found
 * nothing to remove (`'Vàrious Artists'` stayed `'vàrious artists'`), and NFKD
 * was strictly broader than the SQL fold, which would have reopened the same
 * net/arbiter gap from the other side.
 *
 * The fold does not collapse whitespace, so that is done here — a doubled or
 * leading space would otherwise defeat the leading-anchored prefix test, and
 * `to_match_form` (which LML#1139's guard sees) does collapse it.
 */

import { foldArtistName } from '@wxyc/database';

/**
 * Prefixes that mark a credit as a compilation when they lead the string.
 *
 * Verbatim from `wxyc-etl/src/text/compilation.rs`. The leading anchor plus a
 * non-alphanumeric boundary is what excludes real artists whose names merely
 * begin with one of these words.
 */
export const LEADING_COMPILATION_PREFIXES = ['various artists', 'v/a', 'v.a', 'soundtracks'] as const;

/**
 * Strings that signal a compilation ONLY as the entire credit.
 *
 * Kept exact-only so real bands ("The Various", "Various Production",
 * "Soundtrack of Our Lives", "Compilation Hits") aren't swept up.
 */
export const EXACT_COMPILATION_NAMES = ['various', 'soundtrack', 'compilation'] as const;

/**
 * True when `artist` is a Various-Artists credit under wxyc-etl's rule.
 *
 * Folds the input (NFD + combining-mark strip + lowercase, via the shared
 * `foldArtistName`), collapses ASCII whitespace, then returns true when the
 * result either equals an entry in {@link EXACT_COMPILATION_NAMES} or starts
 * with an entry in {@link LEADING_COMPILATION_PREFIXES} followed by
 * end-of-string or a non-alphanumeric character.
 *
 * The trailing-credit case (`CAGAYANO VARIOUS ARTISTS`) is deliberately FALSE:
 * the rule is leading-anchored, and LML#1139 documents that shape as an
 * out-of-scope residual its guard also does not strike. Matching it here would
 * null URLs the guard never touched.
 */
export function isVariousArtistsCredit(artist: string | null | undefined): boolean {
  if (!artist) return false;
  const folded = foldArtistName(artist).replace(/\s+/g, ' ').trim();
  if (!folded) return false;
  if ((EXACT_COMPILATION_NAMES as readonly string[]).includes(folded)) return true;
  return (LEADING_COMPILATION_PREFIXES as readonly string[]).some((prefix) => {
    if (!folded.startsWith(prefix)) return false;
    const next = folded.charAt(prefix.length);
    // End-of-string, or a boundary character. `[a-z0-9]` suffices because the
    // fold has already lowercased and stripped combining marks.
    return next === '' || !/[a-z0-9]/.test(next);
  });
}
