/**
 * Pure-function parsers for RHP venue HTML. All IO is in `rhp-fetch.ts`;
 * everything here is synchronous and operates on strings the orchestrator
 * already has in memory — which keeps the unit tests fast and offline.
 *
 * The core observation: every event page on an RHP site contains exactly
 * one block of the form
 *
 *   <!-- Event Markup for Official Venue Sites -->
 *   <script type="application/ld+json">{ ... schema.org Event ... }</script>
 *
 * with the venue-level schema.org markup (Place/Organization/WebSite)
 * appearing in a *separate* `rank-math-schema` script earlier in the page.
 * We scope to the marked block so a future "Article" or other addition
 * doesn't drift into our parse.
 */

import type { ParsedConcert, SchemaEvent } from './rhp-types.js';
import { VENUE_SEEDS, type RhpVenueConfig } from './rhp-venues.js';

/**
 * Regex over the literal comment marker followed by the next ld+json
 * script. `[\s\S]` (instead of `.`) so it crosses newlines without a
 * dotall flag. Lazy `*?` so we stop at the first closing `</script>`.
 */
const EVENT_LD_RE =
  /<!--\s*Event Markup for Official Venue Sites\s*-->\s*<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Captures the bare `href=` attribute (the negative lookbehind rejects
 * `data-href=` / `aria-href=` / any `*-href=` variant that RHP themes
 * use for hover-preview SPA links, which otherwise produce duplicate /
 * staging-URL link candidates). The value can carry `?query` /
 * `#fragment`; `extractEventLinks` URL-parses it to canonical
 * `…/event/<slug>/`.
 */
const EVENT_INDEX_LINK_RE = /(?<![a-z-])href=["']([^"']+\/event\/[^"']+)["']/gi;

/**
 * Etix URL pattern: extract the numeric event id between `/p/` and the
 * next `/`. Used as a stable per-event ID even when the slug changes.
 */
const ETIX_EVENT_ID_RE = /etix\.com\/ticket\/p\/(\d+)/;

/**
 * Slugify (city-style): the cheap lowercase + non-alphanum-to-`-` collapse
 * used to match city tokens in the Etix slug. Intentionally separate from
 * the headliner slugifier (which adds NFKD + diacritic strip +
 * transliteration) — city names are ASCII NC town names and don't need
 * the extra passes.
 */
const citySlug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Cities that may appear as the trailing token in an Etix slug. We take
 * the UNION of:
 *
 * - A baseline of Triangle-area cities that historically appear in
 *   RHP-promoted Etix URLs (including co-promoted shows at venues we
 *   don't host in `VENUE_SEEDS` ourselves — e.g. Raleigh). Without this
 *   floor, a Cat's Cradle Presents show at a Raleigh venue whose Etix
 *   slug ends `-raleigh-<venue>` would have its city/venue tail mis-
 *   parsed as a phantom supporting act.
 * - The cities of every venue currently in `VENUE_SEEDS`, so adding a
 *   new seeded venue automatically extends the list.
 */
const BASE_CITY_TOKENS = ['carrboro', 'chapel-hill', 'durham', 'saxapahaw', 'raleigh'];
const CITY_TOKENS = Array.from(new Set([...BASE_CITY_TOKENS, ...VENUE_SEEDS.map((v) => citySlug(v.city))]));
const CITY_TRAIL_RE = new RegExp(`-(${CITY_TOKENS.join('|')})-[a-z0-9-]+$`, 'i');

/**
 * HTML entities we actually see on RHP pages. Not a full decoder — we
 * deliberately keep this surface small because the entities we ship past
 * the parser go into the database, and a wrong decode is worse than a
 * literal `&#039;` (which the UI layer can decode at render time).
 */
const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
  '&#8217;': '’', // right single quotation mark
  '&#8216;': '‘',
  '&#8220;': '“',
  '&#8221;': '”',
  '&#8211;': '–', // en dash
  '&#8212;': '—',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

const ENTITY_RE = new RegExp(Object.keys(ENTITY_MAP).join('|'), 'g');

export const decodeHtmlEntities = (raw: string | null | undefined): string =>
  raw == null ? '' : raw.replace(ENTITY_RE, (m) => ENTITY_MAP[m] ?? m);

/**
 * All upcoming `/event/<slug>/` URLs found on an /events/ index page,
 * scoped to the site's own `baseUrl`. Cross-site cross-promo / sister-
 * venue links to other origins are dropped so they don't get pulled into
 * the wrong site's loop and mis-attributed.
 *
 * Query strings and fragments are stripped before the trailing slash is
 * normalized so e.g. `/event/the-band?ref=homepage` becomes
 * `/event/the-band/` rather than `/event/the-band?ref=homepage/` (which
 * would 404).
 */
export const extractEventLinks = (indexHtml: string, baseUrl: string): string[] => {
  const out = new Set<string>();
  const baseOrigin = ((): string | null => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return null;
    }
  })();
  for (const m of indexHtml.matchAll(EVENT_INDEX_LINK_RE)) {
    const href = m[1];
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (baseOrigin !== null && resolved.origin !== baseOrigin) continue;
    const segments = resolved.pathname.split('/').filter((s) => s.length > 0);
    if (segments[0] !== 'event' || segments.length < 2) continue;
    const slug = segments[1];
    if (!slug) continue;
    out.add(`${resolved.origin}/event/${slug}/`);
  }
  return Array.from(out);
};

/**
 * Extract the Event JSON-LD object from an event detail page. Returns
 * the parsed object or null when the marker is missing (e.g. a 404 page
 * that the index links to but the source took down). Throws if the
 * block is present but malformed — that's a source-format change we
 * want loud, not silent.
 */
export const extractEventJsonLd = (eventPageHtml: string): SchemaEvent | null => {
  const m = eventPageHtml.match(EVENT_LD_RE);
  if (!m) return null;
  const parsed = JSON.parse(m[1].trim()) as unknown;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('extractEventJsonLd: top-level JSON-LD value is not an object');
  }
  const ty = (parsed as { '@type'?: unknown })['@type'];
  // schema.org permits `@type` to be either a single string or an array
  // of strings (multi-typing pattern); accept either as long as one of
  // the listed types is Event or MusicEvent.
  const typeStrings = Array.isArray(ty) ? ty : [ty];
  const ok = typeStrings.some((t) => t === 'Event' || t === 'MusicEvent');
  if (!ok) {
    throw new Error(`extractEventJsonLd: unexpected @type for Event block: ${JSON.stringify(ty)}`);
  }
  return parsed as SchemaEvent;
};

/**
 * Transliteration map for non-decomposable Latin letters — characters
 * NFKD treats as atomic (no `base + combining-mark` decomposition).
 * Without this, `Mø` would slugify to `m`, `Łódź` to `odz`, `Sigur Roß`
 * to `sigur-ro` — and the headliner-anchored prefix match in
 * `extractSupportingActsFromEtix` would silently fall back to the
 * legacy buggy split for these artists. Etix slugifies these to their
 * conventional romanizations (ø → o, ł → l, ß → ss, etc.), so we
 * mirror that here.
 */
const NON_DECOMPOSABLE_TRANSLIT: Record<string, string> = {
  ø: 'o',
  Ø: 'o',
  ł: 'l',
  Ł: 'l',
  ß: 'ss',
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  þ: 'th',
  Þ: 'th',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ı: 'i',
};

const NON_DECOMPOSABLE_RE = new RegExp(`[${Object.keys(NON_DECOMPOSABLE_TRANSLIT).join('')}]`, 'gu');

/**
 * NFKD-normalize, strip diacritic combining marks, apply the explicit
 * transliteration map, then ASCII-collapse — so accented or non-Latin
 * Latin-extended headliners ('Sigur Rós', 'Mø', 'Sigur Roß') slugify to
 * the conventional romanized form ('sigur-ros', 'mo', 'sigur-ross')
 * that Etix's own slugifier produces. Without this normalization, the
 * headliner-anchored prefix check in `extractSupportingActsFromEtix`
 * silently misses for those artists and degrades to the legacy buggy
 * split.
 */
const slugifyGeneric = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // strip combining marks (covers all Unicode Mark blocks, not just U+0300–U+036F)
    .replace(NON_DECOMPOSABLE_RE, (m) => NON_DECOMPOSABLE_TRANSLIT[m] ?? m)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const humanizeEtixSegments = (segments: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const cleaned = i === segments.length - 1 ? segments[i].replace(CITY_TRAIL_RE, '') : segments[i];
    const humanized = cleaned
      .split('-')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .trim();
    if (humanized) out.push(humanized);
  }
  return out;
};

/**
 * Recover the supporting-act names from the Etix ticket URL.
 *
 * RHP's `name` field gives a clean headliner ("Aaron Lee Tasjan"), but
 * the Etix slug encodes the full bill: `aaron-lee-tasjanwith-madeleine-
 * kelson-carrboro-cats-cradle-back-room`. Each `with-` segment marks a
 * support act; the trailing `-<city>-<venue>` chunk is location. We
 * trim the city/venue tail from the last segment, then humanize.
 *
 * `headlinerName` (when supplied) anchors the split: we strip the
 * slugified headliner prefix BEFORE splitting on `with-`, so a headliner
 * whose name contains "with" as a word (e.g. "Out With My Friends")
 * doesn't produce phantom support acts.
 *
 * Returns [] when the URL isn't Etix or when no `with-` separator is
 * present — both are common for sold-out shows and tickets-at-door
 * events, neither is an error.
 */
export const extractSupportingActsFromEtix = (
  ticketUrl: string | null | undefined,
  headlinerName?: string
): string[] => {
  if (!ticketUrl) return [];
  if (!ETIX_EVENT_ID_RE.test(ticketUrl)) return [];

  let path: string;
  try {
    path = new URL(ticketUrl).pathname;
  } catch {
    return [];
  }
  const slug = path.split('/').pop() ?? '';

  if (headlinerName) {
    const headlinerSlug = slugifyGeneric(headlinerName);
    if (headlinerSlug && slug.startsWith(headlinerSlug + 'with-')) {
      // Multi-act bill with the canonical Etix shape
      // `<headliner>with-<support1>(with-<support2>…)-<city>-<venue>`.
      const remainder = slug.slice(headlinerSlug.length);
      const segments = remainder.split('with-').filter((s) => s.length > 0);
      return segments.length === 0 ? [] : humanizeEtixSegments(segments);
    }
    if (headlinerSlug && slug.length > headlinerSlug.length) {
      // Single-act bill: slug is `<headliner>-<city>-<venue>`. We
      // explicitly require the headliner to be followed by `-<city>-`
      // before returning the no-support answer; otherwise a short
      // common-word headliner like 'Big' would falsely match the start
      // of a longer slug like `big-thiefwith-…` and silently drop the
      // real support. Mismatched-headliner cases fall through to the
      // legacy split below.
      const tail = slug.slice(headlinerSlug.length);
      for (const city of CITY_TOKENS) {
        if (tail.startsWith(`-${city}-`)) return [];
      }
    }
  }
  // Fall back to the legacy split when we don't have (or can't match)
  // the headliner name. Still buggy when the headliner contains "with"
  // as a word, but parseEventPage always passes the headliner so the
  // primary code path is the headliner-anchored branch above.
  const segs = slug.split('with-').slice(1);
  return segs.length === 0 ? [] : humanizeEtixSegments(segs);
};

/** Resolve a venue display-name to a stable slug, falling back to generic. */
export const resolveVenueSlug = (venue: RhpVenueConfig, displayName: string | null): string => {
  if (!displayName) return venue.default_venue_slug;
  const decoded = decodeHtmlEntities(displayName);
  const mapped = venue.venue_name_to_slug[decoded];
  if (mapped) return mapped;
  return slugifyGeneric(decoded);
};

const extractFirstString = (value: string | string[] | undefined): string | null => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
  return null;
};

const extractFirstOffer = (offers: SchemaEvent['offers']): { url: string | null } => {
  const first = Array.isArray(offers) ? offers[0] : offers;
  return { url: first?.url ?? null };
};

const extractAddress = (location: SchemaEvent['location']): string | null => {
  if (!location) return null;
  const addr = location.address;
  if (!addr) return null;
  if (typeof addr === 'string') return decodeHtmlEntities(addr) || null;
  // PostalAddress with no streetAddress — return null (not '') so callers
  // querying `venues.address IS NULL` can find venues that need manual
  // address backfill rather than scanning for empty-string sentinel.
  return addr.streetAddress ? decodeHtmlEntities(addr.streetAddress) || null : null;
};

/** The longest `headlining_artist_raw` we'll send to a varchar(256). */
const MAX_HEADLINING_ARTIST_LEN = 256;
/** Matches the schema's `concerts.source_id varchar(256)` ceiling. */
const MAX_SOURCE_ID_LEN = 256;
/** Matches the schema's `venues.name varchar(128)` ceiling. */
const MAX_VENUE_NAME_LEN = 128;
/** Matches the schema's `venues.slug varchar(64)` ceiling. */
const MAX_VENUE_SLUG_LEN = 64;
/** Matches the schema's `venues.address varchar(256)` ceiling. */
const MAX_VENUE_ADDRESS_LEN = 256;
/**
 * Strict ISO-8601 datetime: required for startDate. JS Date is too
 * liberal — `new Date('August 15')` returns a valid Date pinned to the
 * current year via V8's legacy fallback, silently letting format-drift
 * junk through.
 *
 * The timezone is REQUIRED. Without it, `new Date('2026-11-06T20:00:00')`
 * is interpreted as LOCAL time per the ES spec — on a UTC-4 server that
 * yields `2026-11-07T00:00:00.000Z`. Postgres then stores the wrong
 * wall-clock time with no signal. Mandate `Z`, `+HH:MM`, or `+HHMM`
 * (RHP currently emits the colonless variant).
 */
const ISO_8601_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * The top-level pure parser: convert a fetched event page into a
 * ParsedConcert ready for write. Throws on missing required fields
 * (name, startDate, location with a name, valid event-page URL) and on
 * a startDate that isn't strict ISO-8601 — so a source-format regression
 * fails the batch loudly instead of writing garbage rows downstream.
 */
export const parseEventPage = (
  venue: RhpVenueConfig,
  eventPageUrl: string,
  eventPageHtml: string
): ParsedConcert | null => {
  const raw = extractEventJsonLd(eventPageHtml);
  if (raw === null) return null;

  const name = decodeHtmlEntities(raw.name).trim();
  if (!name) throw new Error(`parseEventPage: empty Event.name at ${eventPageUrl}`);
  if (name.length > MAX_HEADLINING_ARTIST_LEN) {
    throw new Error(
      `parseEventPage: Event.name exceeds ${MAX_HEADLINING_ARTIST_LEN} chars (got ${name.length}) at ${eventPageUrl}`
    );
  }
  if (!raw.startDate) throw new Error(`parseEventPage: missing Event.startDate at ${eventPageUrl}`);
  // Reject anything that isn't strict ISO-8601 at the parse layer so the
  // writer doesn't later hand postgres a coerced-to-current-year Date
  // (`new Date('August 15')`) or an `Invalid Date` that surfaces as a
  // cryptic upsert_error.
  if (!ISO_8601_DATETIME_RE.test(raw.startDate)) {
    throw new Error(`parseEventPage: non-ISO-8601 Event.startDate '${raw.startDate}' at ${eventPageUrl}`);
  }
  if (Number.isNaN(new Date(raw.startDate).getTime())) {
    throw new Error(`parseEventPage: unparseable Event.startDate '${raw.startDate}' at ${eventPageUrl}`);
  }
  if (!raw.location) {
    throw new Error(`parseEventPage: missing Event.location at ${eventPageUrl}`);
  }
  // The `name` field is what the writer attributes events to. If it's
  // missing, resolveVenueSlug falls through to `default_venue_slug` and
  // silently attributes off-site / sister-room events to the home venue —
  // exactly the bug a missing `location` would cause. Treat missing name
  // the same way.
  if (!raw.location.name) {
    throw new Error(`parseEventPage: missing Event.location.name at ${eventPageUrl}`);
  }

  const offer = extractFirstOffer(raw.offers);
  const supporting = extractSupportingActsFromEtix(offer.url, name);

  const venueDisplayName = decodeHtmlEntities(raw.location.name).trim();
  if (!venueDisplayName) {
    // `&nbsp;` decodes to U+00A0 / ' ' which is truthy but visually
    // empty; treat as missing so we don't write a blank-named venue row.
    throw new Error(`parseEventPage: Event.location.name decodes to empty/whitespace at ${eventPageUrl}`);
  }
  if (venueDisplayName.length > MAX_VENUE_NAME_LEN) {
    throw new Error(
      `parseEventPage: Event.location.name exceeds ${MAX_VENUE_NAME_LEN} chars (got ${venueDisplayName.length}) at ${eventPageUrl}`
    );
  }
  // Pass the already-trimmed/decoded display name to resolveVenueSlug
  // so the venue_name_to_slug lookup sees the same string the rest of
  // the parser uses. Without this, JSON-LD like '&nbsp;Cat's Cradle'
  // decodes to ' Cat's Cradle' inside resolveVenueSlug, the
  // venue_name_to_slug['Cat's Cradle'] lookup misses, slugifyGeneric
  // produces 'cat-s-cradle', and the event is silently attributed to a
  // brand-new unseeded venue instead of the canonical seeded row.
  const venueSlug = resolveVenueSlug(venue, venueDisplayName);
  if (venueSlug.length > MAX_VENUE_SLUG_LEN) {
    throw new Error(
      `parseEventPage: derived venue slug exceeds ${MAX_VENUE_SLUG_LEN} chars (got ${venueSlug.length}) at ${eventPageUrl}`
    );
  }

  // Event-page URL MUST parse — every code path that constructs source_id
  // assumes a real URL. Anything else is a programming error upstream
  // (we shouldn't be calling parseEventPage with a junk URL).
  const pageUrl = new URL(eventPageUrl);
  const sourceId = `${venue.site_slug}:${pageUrl.pathname}`;
  if (sourceId.length > MAX_SOURCE_ID_LEN) {
    throw new Error(
      `parseEventPage: derived source_id exceeds ${MAX_SOURCE_ID_LEN} chars (got ${sourceId.length}) at ${eventPageUrl}`
    );
  }

  const venueAddress = extractAddress(raw.location);
  if (venueAddress !== null && venueAddress.length > MAX_VENUE_ADDRESS_LEN) {
    throw new Error(
      `parseEventPage: derived venue_address exceeds ${MAX_VENUE_ADDRESS_LEN} chars (got ${venueAddress.length}) at ${eventPageUrl}`
    );
  }

  return {
    site_slug: venue.site_slug,
    // source_id includes the site_slug so two RHP sites sharing the same
    // /event/<slug>/ pathname don't collide on the (source, source_id)
    // unique key and silently overwrite each other on UPSERT.
    source_id: sourceId,
    event_page_url: eventPageUrl,
    venue_slug: venueSlug,
    venue_name: venueDisplayName,
    venue_address: venueAddress,
    headlining_artist: name,
    supporting_artists: supporting,
    starts_at: raw.startDate,
    ticket_url: offer.url,
    image_url: extractFirstString(raw.image),
    raw,
  };
};
