/**
 * DB-free grammar for support-act lists ("w/ A, B, and C", "A / B", "& more"),
 * shared by `jobs/venue-events-scraper/parse.ts`, `jobs/triangle-shows-etl/`
 * (`map.ts`, `headliner.ts`) and `apps/backend/services/concerts.service.ts`
 * (BS#3669). A subpath export (`@wxyc/database/support-list`) so jobs can use
 * it without the root barrel, whose `client.ts` throws at import without
 * `DB_*` env. Each caller keeps its own delimiter set and gating.
 *
 * Regexes stay literals (`security/detect-non-literal-regexp` forbids building
 * them from `.source`); callers that must embed a fragment mid-pattern
 * (`headliner.ts`'s `SUPPORT_TAIL` / `TAIL_SPLIT`, `parse.ts`'s
 * `SUBHEADER_SPLIT`) keep a literal copy that
 * `tests/unit/shared/database/support-list.test.ts` pins to this one.
 */
export { CO_BILL_DELIMITER, normalizeFreetextArtist } from './freetext-norm.js';

/** A leading `w/` joiner; `w/o` / `w/out` ("without") are not joiners. */
export const W_JOINER = /^w\/(?!o(?:ut)?\b)\s*/i;

/**
 * Entries that name no act ("special guests", "& More", "TBA"). Case-insensitive,
 * so it takes either the raw name or an already-normalized (lowercased) key.
 */
export const SUPPORT_PLACEHOLDER = /^(?:(?:and|&)\s+)?(?:(?:very\s+)?special\s+guests?|guests?|friends|more|tba|tbd)$/i;

/** Comma plus an optional Oxford `and` / `&`, which belongs to the list. */
export const COMMA_SPLIT = /\s*,\s*(?:(?:and|&)\s+)?/;

/**
 * A slash with whitespace on both sides; a bare `/` (`AC/DC`) is part of a name.
 * Not the same rule as `CO_BILL_DELIMITER`'s slash (`\s\/\s`, which `map.ts`
 * splits on through `BILLING_DELIMITER_PATTERNS.slash`): both detect the same
 * co-bills, but this one consumes all surrounding whitespace, so a doubled
 * ` /  / ` splits differently. Unifying them is BS#3682.
 */
export const SPACED_SLASH = /\s+\/\s+/;
