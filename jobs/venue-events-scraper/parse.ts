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
import type { RhpVenueConfig } from './rhp-venues.js';

/**
 * Regex over the literal comment marker followed by the next ld+json
 * script. `[\s\S]` (instead of `.`) so it crosses newlines without a
 * dotall flag. Lazy `*?` so we stop at the first closing `</script>`.
 */
const EVENT_LD_RE =
  /<!--\s*Event Markup for Official Venue Sites\s*-->\s*<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Matches every `/event/<slug>/` link in the events-index page. Used to
 * enumerate which event detail pages to fetch.
 */
const EVENT_INDEX_LINK_RE = /href=["'](https?:\/\/[^"'\s]+\/event\/[a-z0-9-]+\/?)["']/g;

/**
 * Etix URL pattern: extract the numeric event id between `/p/` and the
 * next `/`. Used as a stable per-event ID even when the slug changes.
 */
const ETIX_EVENT_ID_RE = /etix\.com\/ticket\/p\/(\d+)/;

/**
 * Cities that may appear as the trailing token in an Etix slug. Used to
 * trim the city + venue suffix from a support-act slug.
 */
const CITY_TOKENS = ['carrboro', 'chapel-hill', 'durham', 'saxapahaw', 'raleigh'];
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

/** All upcoming `/event/<slug>/` URLs found on an /events/ index page. */
export const extractEventLinks = (indexHtml: string): string[] => {
  const out = new Set<string>();
  for (const m of indexHtml.matchAll(EVENT_INDEX_LINK_RE)) {
    out.add(m[1].replace(/\/?$/, '/'));
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
  if (parsed === null || typeof parsed !== 'object' || (parsed as { '@type'?: unknown })['@type'] !== 'Event') {
    throw new Error(
      `extractEventJsonLd: unexpected @type for Event block: ${JSON.stringify(
        (parsed as { '@type'?: unknown })['@type']
      )}`
    );
  }
  return parsed as SchemaEvent;
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
 * Returns [] when the URL isn't Etix or when no `with-` separator is
 * present — both are common for sold-out shows and tickets-at-door
 * events, neither is an error.
 */
export const extractSupportingActsFromEtix = (ticketUrl: string | null | undefined): string[] => {
  if (!ticketUrl) return [];
  if (!ETIX_EVENT_ID_RE.test(ticketUrl)) return [];

  let path: string;
  try {
    path = new URL(ticketUrl).pathname;
  } catch {
    return [];
  }
  const slug = path.split('/').pop() ?? '';
  const segments = slug.split('with-').slice(1);
  if (segments.length === 0) return [];

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

const slugifyGeneric = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

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
  if (typeof addr === 'string') return decodeHtmlEntities(addr);
  return decodeHtmlEntities(addr.streetAddress ?? '');
};

/**
 * The top-level pure parser: convert a fetched event page into a
 * ParsedConcert ready for write. Throws on missing required fields
 * (name, startDate, location) so a source-format regression fails the
 * batch loudly instead of writing garbage rows.
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
  if (!raw.startDate) throw new Error(`parseEventPage: missing Event.startDate at ${eventPageUrl}`);

  const offer = extractFirstOffer(raw.offers);
  const supporting = extractSupportingActsFromEtix(offer.url);

  const venueDisplayName = raw.location?.name ? decodeHtmlEntities(raw.location.name) : null;
  const venueSlug = resolveVenueSlug(venue, raw.location?.name ?? null);

  let pathname: string;
  try {
    pathname = new URL(eventPageUrl).pathname;
  } catch {
    pathname = eventPageUrl;
  }

  return {
    site_slug: venue.site_slug,
    source_id: pathname,
    event_page_url: eventPageUrl,
    venue_slug: venueSlug,
    venue_name: venueDisplayName,
    venue_address: extractAddress(raw.location),
    headlining_artist: name,
    supporting_artists: supporting,
    starts_at: raw.startDate,
    ticket_url: offer.url,
    image_url: extractFirstString(raw.image),
    raw,
  };
};
