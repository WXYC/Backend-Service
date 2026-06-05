/**
 * Static configuration for the Rockhouse Partners (RHP) venue scrapers.
 *
 * RHP is the WordPress plugin (and ticketing-platform partner) that
 * powers a cluster of Triangle-area venue sites including Cat's Cradle
 * and Local 506. Every event page on these sites carries a schema.org
 * `Event` JSON-LD block via the plugin's "Event Markup for Official
 * Venue Sites" feature — so the same parser handles them all.
 *
 * To add a new RHP-powered venue: confirm it ships the JSON-LD block
 * (curl the events index, fetch one event page, grep for
 * "Event Markup for Official Venue Sites"), then append its base URL and
 * a stable slug here. Slugs are stable IDs we control — they become the
 * `venues.slug` value the writer uses to attach `venue_id` to each
 * concert row.
 *
 * The `venue_name_to_slug` map handles RHP sites that host multiple
 * physical rooms under one calendar (Cat's Cradle's site lists events
 * for Cat's Cradle main, Back Room, Haw River Ballroom, and Motorco
 * Music Hall under one /events/ index, with the room name appearing in
 * each event's JSON-LD `location.name`). When we encounter a name not in
 * the map, the parser slugifies it generically and the writer creates a
 * venues row on first sight — so adding a venue silently is safe, just
 * less curated.
 */

export type RhpVenueConfig = {
  /** Stable kebab-case identifier for the site we crawl. */
  site_slug: string;
  base_url: string;
  /** Default venue slug if JSON-LD `location.name` is missing. */
  default_venue_slug: string;
  /**
   * Mapping from JSON-LD `location.name` (after HTML decode) to the
   * `venues.slug` we want to use. Names not in this map get a generic
   * slugify pass.
   */
  venue_name_to_slug: Record<string, string>;
};

export const RHP_SITES: RhpVenueConfig[] = [
  {
    site_slug: 'cats-cradle',
    base_url: 'https://catscradle.com',
    default_venue_slug: 'cats-cradle',
    venue_name_to_slug: {
      "Cat's Cradle": 'cats-cradle',
      'Cat’s Cradle': 'cats-cradle',
      "Cat's Cradle Back Room": 'cats-cradle-back-room',
      'Cat’s Cradle Back Room': 'cats-cradle-back-room',
      'Haw River Ballroom': 'haw-river-ballroom',
      'Motorco Music Hall': 'motorco-music-hall',
    },
  },
  {
    site_slug: 'local-506',
    base_url: 'https://local506.com',
    default_venue_slug: 'local-506',
    venue_name_to_slug: {
      'Local 506': 'local-506',
    },
  },
];

/**
 * Static facts about each known venue, used to seed the `venues` table on
 * first sight. Keyed by the slug values that appear above. Unknown slugs
 * (a new room not yet in `RHP_SITES.venue_name_to_slug`) get a
 * placeholder row the writer fills from the JSON-LD `location` block.
 */
export type VenueSeed = {
  slug: string;
  name: string;
  city: string;
  state: string;
  address: string | null;
};

export const VENUE_SEEDS: VenueSeed[] = [
  {
    slug: 'cats-cradle',
    name: "Cat's Cradle",
    city: 'Carrboro',
    state: 'NC',
    address: '300 E Main St., Carrboro, NC 27510',
  },
  {
    slug: 'cats-cradle-back-room',
    name: "Cat's Cradle Back Room",
    city: 'Carrboro',
    state: 'NC',
    address: '300 E Main St., Carrboro, NC 27510',
  },
  {
    slug: 'haw-river-ballroom',
    name: 'Haw River Ballroom',
    city: 'Saxapahaw',
    state: 'NC',
    address: '1711 Saxapahaw-Bethlehem Church Rd, Saxapahaw, NC 27340',
  },
  {
    slug: 'motorco-music-hall',
    name: 'Motorco Music Hall',
    city: 'Durham',
    state: 'NC',
    address: '723 Rigsbee Ave, Durham, NC 27701',
  },
  {
    slug: 'local-506',
    name: 'Local 506',
    city: 'Chapel Hill',
    state: 'NC',
    address: '506 W Franklin St, Chapel Hill, NC 27516',
  },
];
