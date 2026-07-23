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

import { nyCalendarDate, nyWallClockToUtc, normalizeFreetextArtist, type NewConcert } from '@wxyc/database';
import { parseBilling } from './headliner.js';
import type { TsEvent } from './types.js';

// Clean-headliner extraction (BS#1604) + the BS#1614 clean-name LML gate +
// the BS#1758 billing-tail support parse live in headliner.ts — a
// deliberately DB-free module so the BS#1614 name-set export script can
// import them without tripping `@wxyc/database`'s import-time env guard.
// Re-exported here so ETL-side consumers keep one import surface.
export {
  extractHeadliner,
  parseBilling,
  isCleanHeadliner,
  HARD_BILLING_DELIMITERS,
  BILLING_DELIMITER_PATTERNS,
} from './headliner.js';

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

/** Normalize the source's support-artist field into the `text[]` shape
 *  `concerts.supporting_artists_raw` expects: trimmed, empties dropped.
 *  Accepts both the legacy single comma-joined string and the JSON array
 *  the source flips to (WXYC/triangle-shows#39) — the feed is untrusted, so
 *  a non-string array element is coerced away rather than crashing the ETL. */
export const splitSupportArtists = (raw: string | string[] | null): string[] =>
  (Array.isArray(raw) ? raw : (raw ?? '').split(','))
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0);

/** Generous upper bound on `supporting_artists_raw`'s length (BS#1758) —
 *  real billings carry a handful of names at most. Guards a pathological
 *  merge (a malformed feed, a runaway tail split) from writing an
 *  unbounded array rather than modeling any real co-bill size. */
const SUPPORT_MAX_COUNT = 32;

/**
 * Merge the billing-tail-derived support acts (`parseBilling`'s support
 * half, BS#1758) with the source's own sparse `support_artists` field into
 * the final `supporting_artists_raw` array. Billing-derived names are
 * listed FIRST — the richer signal, since `source.support_artists` is
 * often empty precisely because the names live in the tail this job used
 * to discard.
 *
 * Deduped normalize-insensitively via `normalizeFreetextArtist` (the
 * free-text match SSOT the resolver and flowsheet embed key on — using
 * anything else here would let capture dedup and match keys drift apart),
 * keeping the FIRST-SEEN surface form. The chosen headliner is dropped
 * from the result the same way — a performer is not its own support —
 * compared against the ALREADY-DECIDED `headliner` (upstream field or the
 * heuristic, whichever won), not the clamped storage form; the exclusion
 * is an identity check, not a column-width one.
 *
 * Each surviving name clamps to `max` code points (the caller passes
 * `HEADLINER_MAX`, mirroring the headliner's own clamp) and the array
 * caps at `SUPPORT_MAX_COUNT` — both generous vs. observed billings,
 * guarding a pathological one rather than a real co-bill.
 */
export const mergeSupportingArtists = (
  billingSupport: string[],
  structuredSupport: string[],
  headliner: string,
  max: number
): string[] => {
  const headlinerKey = normalizeFreetextArtist(headliner);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...billingSupport, ...structuredSupport]) {
    const key = normalizeFreetextArtist(name);
    if (key === '' || key === headlinerKey || seen.has(key)) continue;
    seen.add(key);
    merged.push(clampCodePoints(name, max));
  }
  return merged.slice(0, SUPPORT_MAX_COUNT);
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
  // BS#1758: parsed unconditionally, NOT inlined into the `||` below — the
  // billing tail's support acts (parsedBilling.support) are a property of
  // the raw billing string regardless of which headliner value wins, so
  // short-circuiting this call away whenever an upstream headliner is
  // present would silently stop capturing support the day
  // WXYC/triangle-shows#18 covers the corpus.
  const parsedBilling = parseBilling(billing);
  // BS#1604: prefer the upstream clean-performer field when present and
  // non-blank (WXYC/triangle-shows#18 emits it best-effort — nullable,
  // and absent entirely until it deploys); otherwise derive a clean
  // headliner from the billing string. Both routes hit the same clamp.
  const upstreamHeadliner = sanitized.headliner?.trim() ?? '';
  const headliner = upstreamHeadliner || parsedBilling.headliner;
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
      // BS#1758: billing-tail support (richer — often the ONLY signal,
      // since the source's own field is sparse) merged with the
      // structured field, deduped against the CHOSEN headliner (whichever
      // of upstreamHeadliner/parsedBilling.headliner won above).
      supporting_artists_raw: mergeSupportingArtists(
        parsedBilling.support,
        splitSupportArtists(sanitized.support_artists),
        headliner,
        HEADLINER_MAX
      ),
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
