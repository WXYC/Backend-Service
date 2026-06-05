/**
 * Unit tests for the RHP venue HTML parser.
 *
 * Strategy: use saved real-world fixture HTML from Cat's Cradle. The
 * fixtures contain the actual schema.org Event JSON-LD block emitted by
 * the Rockhouse Partners WordPress plugin (verified via curl on
 * 2026-06-04). When RHP changes their HTML, these tests fail loudly so we
 * notice before the cron silently stops producing rows.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  decodeHtmlEntities,
  extractEventJsonLd,
  extractEventLinks,
  extractSupportingActsFromEtix,
  parseEventPage,
  resolveVenueSlug,
} from '../../../../jobs/venue-events-scraper/parse';
import { RHP_SITES } from '../../../../jobs/venue-events-scraper/rhp-venues';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/venue-events-scraper');
const readFixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

const CATS_CRADLE = RHP_SITES.find((s) => s.site_slug === 'cats-cradle');
if (!CATS_CRADLE) throw new Error('test setup: cats-cradle venue config missing from RHP_SITES');

describe('decodeHtmlEntities', () => {
  it.each([
    ['Cat&#039;s Cradle', "Cat's Cradle"],
    ['Cat&#8217;s Cradle', 'Cat’s Cradle'],
    ['Earth, Wind &amp; Fire', 'Earth, Wind & Fire'],
    ['Sinéad O&apos;Connor', "Sinéad O'Connor"],
    ['quotes &quot;in&quot; text', 'quotes "in" text'],
    ['no entities here', 'no entities here'],
    ['', ''],
  ])('decodes %p → %p', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('returns empty string for null/undefined (defensive)', () => {
    expect(decodeHtmlEntities(null)).toBe('');
    expect(decodeHtmlEntities(undefined)).toBe('');
  });

  it('leaves unknown entities literally rather than mangling', () => {
    // Conservative decoder: we'd rather ship "&#x2603;" than guess wrong.
    expect(decodeHtmlEntities('snowman: &#x2603; here')).toBe('snowman: &#x2603; here');
  });
});

describe('extractEventLinks', () => {
  it('finds all /event/<slug>/ URLs in the events index', () => {
    const html = readFixture('cats-cradle-events-index.html');
    const links = extractEventLinks(html);
    expect(links).toContain('https://catscradle.com/event/aaron-lee-tasjan-2/');
    expect(links).toContain('https://catscradle.com/event/sleater-kinney/');
    expect(links).toContain('https://catscradle.com/event/the-headliner/');
  });

  it('deduplicates repeat links (same event shown in featured + list)', () => {
    const html = readFixture('cats-cradle-events-index.html');
    const links = extractEventLinks(html);
    const aaron = links.filter((u) => u.includes('aaron-lee-tasjan-2'));
    expect(aaron).toHaveLength(1);
  });

  it('ignores non-event links (/about/, /contact/)', () => {
    const html = readFixture('cats-cradle-events-index.html');
    const links = extractEventLinks(html);
    expect(links.every((u) => u.includes('/event/'))).toBe(true);
  });

  it('returns empty array when the index has no event links', () => {
    expect(extractEventLinks('<html><body>nothing here</body></html>')).toEqual([]);
  });
});

describe('extractEventJsonLd', () => {
  it('parses the Event block from a Cat’s Cradle event page', () => {
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const event = extractEventJsonLd(html);
    if (event === null) throw new Error('expected Event JSON-LD to parse');
    expect(event.name).toBe('Aaron Lee Tasjan');
    expect(event.startDate).toBe('2026-11-06T20:00:00-0500');
    expect(event.location?.name).toBe('Cat&#8217;s Cradle Back Room');
  });

  it('returns null when the Event-marker comment is absent (likely 404 page)', () => {
    const html = readFixture('cats-cradle-no-event-block.html');
    expect(extractEventJsonLd(html)).toBeNull();
  });

  it('does NOT pick up the venue-level rank-math schema as the event', () => {
    // The fixture contains both a rank-math Place schema AND the Event
    // block — make sure we get the Event, not the Place.
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const event = extractEventJsonLd(html);
    if (event === null) throw new Error('expected Event JSON-LD to parse');
    expect(event['@type']).toBe('Event');
  });

  it('throws on a malformed JSON-LD block (loud failure for source drift)', () => {
    const html = '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{not json}</script>';
    expect(() => extractEventJsonLd(html)).toThrow();
  });

  it('throws when the parsed block is not an Event (@type drift)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Article","name":"oops"}</script>';
    expect(() => extractEventJsonLd(html)).toThrow(/unexpected @type/);
  });
});

describe('extractSupportingActsFromEtix', () => {
  it("recovers a single support act from Cat's Cradle's Etix slug", () => {
    const url =
      'https://www.etix.com/ticket/p/79604526/aaron-lee-tasjanwith-madeleine-kelson-carrboro-cats-cradle-back-room?partner_id=100';
    expect(extractSupportingActsFromEtix(url)).toEqual(['Madeleine Kelson']);
  });

  it('recovers multiple support acts', () => {
    const url =
      'https://www.etix.com/ticket/p/99999/the-headlinerwith-first-supportwith-second-support-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url)).toEqual(['First Support', 'Second Support']);
  });

  it('returns [] for a headliner-only Etix slug (no with- separator)', () => {
    const url = 'https://www.etix.com/ticket/p/12345678/sleater-kinney-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url)).toEqual([]);
  });

  it('returns [] for a non-Etix ticket URL', () => {
    expect(extractSupportingActsFromEtix('https://www.ticketmaster.com/event/abc')).toEqual([]);
  });

  it('returns [] for null/undefined/empty input', () => {
    expect(extractSupportingActsFromEtix(null)).toEqual([]);
    expect(extractSupportingActsFromEtix(undefined)).toEqual([]);
    expect(extractSupportingActsFromEtix('')).toEqual([]);
  });

  it('returns [] for a malformed URL', () => {
    expect(extractSupportingActsFromEtix('not a url at all')).toEqual([]);
  });
});

describe('resolveVenueSlug', () => {
  it('maps known venue display names to their canonical slug', () => {
    expect(resolveVenueSlug(CATS_CRADLE, "Cat's Cradle")).toBe('cats-cradle');
    expect(resolveVenueSlug(CATS_CRADLE, "Cat's Cradle Back Room")).toBe('cats-cradle-back-room');
    expect(resolveVenueSlug(CATS_CRADLE, 'Haw River Ballroom')).toBe('haw-river-ballroom');
    expect(resolveVenueSlug(CATS_CRADLE, 'Motorco Music Hall')).toBe('motorco-music-hall');
  });

  it("handles curly-quote variants of the venue name (Cat's vs Cat’s)", () => {
    expect(resolveVenueSlug(CATS_CRADLE, 'Cat’s Cradle Back Room')).toBe('cats-cradle-back-room');
  });

  it('falls back to the site default slug when display name is null', () => {
    expect(resolveVenueSlug(CATS_CRADLE, null)).toBe('cats-cradle');
  });

  it('generically slugifies unknown venue names', () => {
    expect(resolveVenueSlug(CATS_CRADLE, 'New Venue 506')).toBe('new-venue-506');
  });
});

describe('parseEventPage', () => {
  it('returns a fully-populated ParsedConcert for the canonical Cat’s Cradle fixture', () => {
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const url = 'https://catscradle.com/event/aaron-lee-tasjan-2/';
    const parsed = parseEventPage(CATS_CRADLE, url, html);
    if (parsed === null) throw new Error('expected canonical fixture to parse');

    expect(parsed).toMatchObject({
      site_slug: 'cats-cradle',
      source_id: '/event/aaron-lee-tasjan-2/',
      event_page_url: url,
      venue_slug: 'cats-cradle-back-room',
      venue_name: 'Cat’s Cradle Back Room',
      venue_address: '300 E Main St., Carrboro, North Carolina',
      headlining_artist: 'Aaron Lee Tasjan',
      supporting_artists: ['Madeleine Kelson'],
      starts_at: '2026-11-06T20:00:00-0500',
      ticket_url:
        'https://www.etix.com/ticket/p/79604526/aaron-lee-tasjanwith-madeleine-kelson-carrboro-cats-cradle-back-room?partner_id=100',
      image_url: 'https://catscradle.com/wp-content/uploads/2026/04/aaron-lee-tasjan.jfif',
    });
    expect(parsed.raw['@type']).toBe('Event');
  });

  it('returns null when the page has no Event block (likely a past/404 page)', () => {
    const html = readFixture('cats-cradle-no-event-block.html');
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/old/', html);
    expect(parsed).toBeNull();
  });

  it('handles a headliner-only show (no support acts) without throwing', () => {
    const html = readFixture('cats-cradle-headliner-only.html');
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/sleater-kinney/', html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.headlining_artist).toBe('Sleater-Kinney');
    expect(parsed.supporting_artists).toEqual([]);
    expect(parsed.venue_slug).toBe('cats-cradle');
  });

  it('handles multi-support bills correctly', () => {
    const html = readFixture('cats-cradle-multi-support.html');
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/the-headliner/', html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.headlining_artist).toBe('The Headliner');
    expect(parsed.supporting_artists).toEqual(['First Support', 'Second Support']);
  });

  it('throws if Event.name is empty (source drift, fail loudly)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"","startDate":"2026-01-01T20:00:00-0500"}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/empty Event\.name/);
  });

  it('throws if Event.startDate is missing (source drift, fail loudly)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X"}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/missing Event\.startDate/);
  });

  it('uses the URL pathname as source_id (stable across reformats of the host)', () => {
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const url = 'https://catscradle.com/event/aaron-lee-tasjan-2/';
    const parsed = parseEventPage(CATS_CRADLE, url, html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.source_id).toBe('/event/aaron-lee-tasjan-2/');
  });
});
