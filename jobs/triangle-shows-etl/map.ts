/**
 * Pure `EventResponse` -> concerts-row mapping (the BS#1589 field table).
 * No DB, no network — everything contract-shaped lives here so the unit
 * suite can pin it without mocks.
 *
 * Keying: `source_id = '<venue_slug>:' + source_key`. NEVER bare
 * `source_key` — triangle-shows uniqueness is per-venue
 * `(venue_id, source_key)`. The ingested set contains several
 * same-platform groupings (a Ticketmaster quad, an rhp_events pair, and
 * three pairs whose `ext:`/`url:` tier keys are the collision-prone
 * kind: rubies+stancyks VenuePilot, neptunes-parlour+boom-club
 * Squarespace, shadowbox-studio+slims MEC) — the qualifier protects all
 * of them uniformly.
 */

import { nyCalendarDate, nyWallClockToUtc, type NewConcert } from '@wxyc/database';
import type { TsEvent } from './types.js';

/** Code-point-safe truncation (`String.prototype.slice` counts UTF-16 code
 *  units and can strand half a surrogate pair as U+FFFD in the DB). Lives
 *  here — the pure, DB-free module — so writer.ts's import of it points
 *  the same direction as its type import (writer -> map, no cycle). */
export const clampCodePoints = (value: string, max: number): string => [...value].slice(0, max).join('');

const HEADLINER_MAX = 256;

// Same shape ny-time enforces; validated here for BOTH branches so a
// source date-format drift on date-only events fails as a map_error (the
// documented contract-drift counter), not as an opaque upsert_error at
// the Drizzle date-column bind.
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the writer needs: the concert payload minus the run-scoped
 *  columns (`venue_id` resolves via the per-run slug cache; `scraped_at`
 *  is stamped per run). `venue_slug` is the one venue field that earns a
 *  place here — mapEvent validates it non-null; the orchestrator reads
 *  any other venue detail off the source event it already holds. */
export type MappedEvent = {
  venue_slug: string;
  concert: Omit<NewConcert, 'venue_id' | 'scraped_at'>;
};

/** Split the source's single comma-joined string into the `text[]` shape
 *  `concerts.supporting_artists_raw` expects: trimmed, empties dropped. */
export const splitSupportArtists = (raw: string | null): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/* ------------------------------------------------------------------ *
 * Clean-headliner extraction (BS#1604)                                *
 *                                                                     *
 * triangle-shows' `artist` field is byte-identical to the event       *
 * `name` in practice — the full marquee/billing string, not a clean   *
 * performer — which starves the exact-match `concerts-artist-resolver`*
 * (9/259 distinct billings resolved). Until the upstream `headliner`  *
 * field (WXYC/triangle-shows#18) covers the corpus, derive a clean    *
 * headliner here. TRIANGLE_SHOWS-SPECIFIC by design: RHP headliners   *
 * are already clean, and the shared resolver stays untouched.         *
 *                                                                     *
 * Conservative by contract: prefer under-stripping — a billing left   *
 * dirty just stays unresolved (today's behavior), while over-stripping*
 * can mangle a legitimate name into a WRONG resolution. `&`/`and` are *
 * never treated as support delimiters (Andy Frasco & The U.N), and a  *
 * leading single mixed-case parenthetical word is kept ((Sandy) Alex  *
 * G) — only tag-shaped parentheticals strip. Idempotent: every rule   *
 * removes its own trigger, and the empty-result fallback returns a    *
 * string none of the rules re-fire on.                                *
 * ------------------------------------------------------------------ */

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
 * Derive a clean headliner from a billing string. Exported for the unit
 * suite. Returns the trimmed input unchanged when no rule fires, and
 * falls back to the trimmed input when cleanup empties the string (a
 * pure-tag billing like `(SOLD OUT)` is still better stored verbatim
 * than dropped — it just stays unresolved, exactly like today).
 */
export const extractHeadliner = (billing: string): string => {
  const original = billing.trim();
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
  cleaned = cleaned.trim();
  return cleaned === '' ? original : cleaned;
};

/** numeric(8,2) tops out at 999999.99, and PG errors rather than
 *  truncates. Judged on the ROUNDED value — toFixed carries 999999.996
 *  to '1000000.00'. */
const PRICE_MAX = 999_999.99;

/**
 * Dollars as the 2-decimal string Drizzle's numeric(8,2) column binds.
 * Un-storable values (past the column cap, negative, or non-finite) drop
 * to NULL instead of failing the whole event's upsert every night: the
 * source's floats are unbounded and its scrapers' price regexes can
 * misparse prose digit runs — a phone number in a Squarespace
 * description qualifies — and the same misparse family can capture a
 * leading hyphen from a prose range as a negative.
 */
const toPrice = (value: number | null): string | null => {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const formatted = value.toFixed(2);
  return Number(formatted) > PRICE_MAX ? null : formatted;
};

/**
 * Map the source EventStatus onto `concert_status_enum`. Complete against
 * the source enum (on_sale / sold_out / cancelled / free); an unknown
 * value throws so upstream enum drift fails loudly per-event instead of
 * mislabeling rows. BS's `rescheduled` has no producer on this path.
 * `free` collapses to on_sale + a zero floor price — "free" is an
 * availability fact plus a price fact, and price is where we model it.
 */
const mapStatus = (event: TsEvent): { status: 'on_sale' | 'sold_out' | 'cancelled'; priceMin: string | null } => {
  switch (event.status) {
    case 'on_sale':
    case 'sold_out':
    case 'cancelled':
      return { status: event.status, priceMin: toPrice(event.price_min) };
    case 'free':
      return { status: 'on_sale', priceMin: toPrice(event.price_min ?? 0) };
    default:
      throw new Error(`mapEvent: unknown source status '${event.status}' (event id ${event.id})`);
  }
};

const NUL = '\u0000';

const eventContainsNul = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(eventContainsNul);
  if (value !== null && typeof value === 'object') return Object.values(value).some(eventContainsNul);
  return false;
};

const stripNulDeep = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replaceAll(NUL, '');
  if (Array.isArray(value)) return value.map(stripNulDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNulDeep(v)]));
  }
  return value;
};

export const mapEvent = (event: TsEvent): MappedEvent => {
  if (!event.venue_slug) {
    throw new Error(`mapEvent: event id ${event.id} has no venue_slug; cannot compose the venue-qualified source_id`);
  }
  if (!ISO_DATE_SHAPE.test(event.date)) {
    throw new Error(`mapEvent: event id ${event.id} has non-ISO date '${event.date}' (want YYYY-MM-DD)`);
  }
  // PG rejects U+0000 in EVERY text-typed bind (varchar/text and jsonb
  // alike) — one NUL in scraped free text would permanently fail the
  // event's upsert every night. Sanitize the whole payload up front (deep
  // string walk, exact — no escaped-JSON surgery that could corrupt a
  // literal backslash-u0000 text sequence) so every mapped column AND
  // raw_data derive from clean strings. Clean payloads (the norm) pass
  // through by reference.
  const sanitized = eventContainsNul(event) ? (stripNulDeep(event) as TsEvent) : event;

  const { status, priceMin } = mapStatus(sanitized);
  // `||` on the trimmed artist, not `??`: heterogeneous scrapers can emit
  // '' where they mean "unknown", and an empty headliner defeats both the
  // resolver and any display. `name` is NOT NULL at the source but can be
  // whitespace — trim BEFORE the truthiness check so it can't slip through
  // as a blank headliner; when everything is blank the event is
  // unresolvable garbage, thrown as a countable map_error rather than
  // written.
  const artist = sanitized.artist?.trim() ?? '';
  const name = sanitized.name.trim();
  const billing = artist || name;
  // BS#1604: prefer the upstream clean-performer field when present and
  // non-blank (WXYC/triangle-shows#18 emits it best-effort — nullable,
  // and absent entirely until it deploys); otherwise derive a clean
  // headliner from the billing string. Both routes hit the same clamp.
  const upstreamHeadliner = sanitized.headliner?.trim() ?? '';
  const headliner = upstreamHeadliner || extractHeadliner(billing);
  if (headliner === '') {
    throw new Error(
      `mapEvent: event id ${event.id} has a blank headliner, artist AND name — refusing a headliner-less row`
    );
  }
  const clampedHeadliner = clampCodePoints(headliner, HEADLINER_MAX);

  // Validated here so a source serialization change fails as an
  // attributed map_error — an Invalid Date would otherwise surface at the
  // Drizzle timestamp bind as a context-free 'RangeError: Invalid time
  // value' counted as an upsert_error.
  const removedAt = sanitized.removed_at ? new Date(sanitized.removed_at) : null;
  if (removedAt !== null && Number.isNaN(removedAt.getTime())) {
    throw new Error(`mapEvent: event id ${event.id} has unparseable removed_at '${sanitized.removed_at}'`);
  }

  return {
    venue_slug: event.venue_slug,
    concert: {
      source: 'triangle_shows',
      source_id: `${event.venue_slug}:${event.source_key}`,
      starts_on: event.date,
      // Date-only events keep starts_at NULL — never a fabricated time.
      starts_at: sanitized.show_time ? nyWallClockToUtc(sanitized.date, sanitized.show_time) : null,
      doors_at: sanitized.doors_time ? nyWallClockToUtc(sanitized.date, sanitized.doors_time) : null,
      // Truncated to the column width (source String(500) vs varchar(256));
      // code-point-safe so an astral char at the boundary can't strand a
      // lone surrogate as U+FFFD in the DB.
      headlining_artist_raw: clampedHeadliner,
      // Schema contract (schema.ts): 'Event name as the source displays
      // it, when distinct from the artist' — rhp_scrape rows leave it
      // NULL. When the headliner already IS the name (artist absent or
      // identical, and no cleanup fired), writing it again would render
      // 'Juana Molina — Juana Molina' in any feed using the
      // headliner—title shape. When BS#1604 cleanup (or the upstream
      // field) DID change the headliner, this same rule now preserves
      // the full display billing here — the clean headliner is for the
      // resolver, not a display replacement. Compared
      // against the CLAMPED headliner so a >256-code-point name keeps its
      // full text here exactly when truncation amputated the raw column;
      // the `name &&` guard keeps a blank name (with a valid artist) from
      // storing a whitespace title.
      title: name && name !== clampedHeadliner ? sanitized.name : null,
      supporting_artists_raw: splitSupportArtists(sanitized.support_artists),
      ticket_url: sanitized.ticket_url,
      image_url: sanitized.image_url,
      // The venue's own event-detail page (BS#1609). The conflict-update that
      // refreshes it lives in writer.ts, not here (this file is INSERT-half only).
      event_url: sanitized.source_url,
      price_min: priceMin,
      price_max: toPrice(sanitized.price_max),
      age_restriction: sanitized.age_restriction,
      status,
      // Mirrors the source's tombstone in BOTH directions (the writer's
      // set clause clears it when a delisted event reappears).
      removed_at: removedAt,
      // genre/subgenre/description live only here (BS#1570 Decision 2).
      raw_data: sanitized,
    },
  };
};

/**
 * The `start` param for the events pull: 8 days before `now` on the NY
 * calendar. Contract-required back-dating — the source's default
 * start=today window hides a tombstone stamped on the event's own show
 * date, and source rows hard-delete 7 days past their date.
 */
export const backdatedStart = (now: Date): string => {
  const today = nyCalendarDate(now);
  const backdated = new Date(`${today}T00:00:00Z`);
  backdated.setUTCDate(backdated.getUTCDate() - 8);
  return backdated.toISOString().slice(0, 10);
};
