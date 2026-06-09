/**
 * Unit tests for the venue-events-scraper orchestrator.
 *
 * Dependencies (fetch / parse / venue lookup / upsert / mapConcurrent)
 * are injected so these tests stay offline and instantaneous. The
 * production wiring lives in `job.ts`; here we exercise the loop's
 * counter math, error containment, and per-site isolation.
 */
import { runScraper } from '../../../../jobs/venue-events-scraper/orchestrate';
import type {
  FetchHtmlFn,
  ParseEventPageFn,
  ExtractEventLinksFn,
  ResolveVenueIdFn,
  UpsertConcertFn,
  MapConcurrentFn,
} from '../../../../jobs/venue-events-scraper/orchestrate';
import { initLogger, closeLogger } from '../../../../jobs/venue-events-scraper/logger';
import type { ParsedConcert } from '../../../../jobs/venue-events-scraper/rhp-types';
import type { RhpVenueConfig } from '../../../../jobs/venue-events-scraper/rhp-venues';

const TEST_VENUE: RhpVenueConfig = {
  site_slug: 'test-site',
  base_url: 'https://test.example',
  default_venue_slug: 'test-venue',
  venue_name_to_slug: {},
};

const TEST_VENUE_B: RhpVenueConfig = {
  site_slug: 'test-site-b',
  base_url: 'https://test-b.example',
  default_venue_slug: 'test-venue-b',
  venue_name_to_slug: {},
};

const fakeParsedConcert = (suffix: string): ParsedConcert => ({
  site_slug: 'test-site',
  source_id: `test-site:/event/${suffix}/`,
  event_page_url: `https://test.example/event/${suffix}/`,
  venue_slug: 'test-venue',
  venue_name: 'Test Venue',
  venue_address: null,
  headlining_artist: `Headliner ${suffix}`,
  supporting_artists: [],
  starts_at: '2026-12-01T20:00:00-0500',
  ticket_url: null,
  image_url: null,
  raw: { '@type': 'Event', name: `Headliner ${suffix}`, startDate: '2026-12-01T20:00:00-0500' },
});

// Real implementation copied — we exercise the orchestrator with a
// real concurrency runner so a parallelism bug surfaces in unit tests.
const realMapConcurrent: MapConcurrentFn = async (items, concurrency, fn) => {
  const out: Array<unknown> = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]);
      } catch {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out as Awaited<ReturnType<typeof fn>>[];
};

describe('runScraper — happy path', () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('fetches index, fans out per event, upserts each, totals match', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockImplementation(async (url) => {
      await Promise.resolve();
      if (url.endsWith('/events/')) return '<index>';
      return `<event ${url}>`;
    });
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue([
        'https://test.example/event/a/',
        'https://test.example/event/b/',
        'https://test.example/event/c/',
      ]);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockImplementation((_, url) => fakeParsedConcert(url.split('/event/')[1].replace('/', '')));
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValue({ concert_id: 7, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 2,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
      now: () => new Date('2026-06-05T00:00:00Z'),
    });

    expect(fetchHtml).toHaveBeenCalledWith('https://test.example/events/');
    expect(upsertConcert).toHaveBeenCalledTimes(3);
    expect(totals).toMatchObject({
      sites_attempted: 1,
      sites_succeeded: 1,
      index_errors: 0,
      events_seen: 3,
      fetch_errors: 0,
      parse_errors: 0,
      pages_without_event_block: 0,
      upserts_total: 3,
      upserts_inserted: 3,
      upserts_updated: 0,
      venue_resolve_errors: 0,
      upsert_errors: 0,
    });
  });

  it('site_done log line reports per-site counters, not cumulative totals', async () => {
    // Two sites with disjoint event counts. The second site's site_done
    // log line must NOT include the first site's events_seen / upserts_total.
    const writes: string[] = [];
    // Replace the beforeEach's no-op stdout spy with a capture spy.
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    initLogger({ repo: 'Backend-Service', tool: 'venue-events-scraper-test' });
    try {
      const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockResolvedValue('html');
      const extractEventLinks = jest
        .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
        // Three events on the first site, one on the second.
        .mockReturnValueOnce([
          'https://test.example/event/a/',
          'https://test.example/event/b/',
          'https://test.example/event/c/',
        ])
        .mockReturnValueOnce(['https://test-b.example/event/x/']);
      const parseEventPage = jest
        .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
        .mockImplementation((_, url) => fakeParsedConcert(url));
      const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
      const upsertConcert = jest
        .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
        .mockResolvedValue({ concert_id: 7, inserted: true });

      await runScraper({
        sites: [TEST_VENUE, TEST_VENUE_B],
        concurrency: 1,
        fetchHtml,
        extractEventLinks,
        parseEventPage,
        resolveVenueId,
        upsertConcert,
        mapConcurrent: realMapConcurrent,
      });

      const siteDoneLines = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((obj) => obj.step === 'site_done');

      expect(siteDoneLines).toHaveLength(2);
      expect(siteDoneLines[0]).toMatchObject({ site_slug: 'test-site', events_seen: 3, upserts_total: 3 });
      // Second site reports just its own one event, NOT cumulative four.
      expect(siteDoneLines[1]).toMatchObject({ site_slug: 'test-site-b', events_seen: 1, upserts_total: 1 });
    } finally {
      await closeLogger();
    }
  });

  it('distinguishes inserted vs updated rows', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockResolvedValue('html');
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue(['https://test.example/event/a/', 'https://test.example/event/b/']);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockImplementation((_, url) => fakeParsedConcert(url));
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValueOnce({ concert_id: 1, inserted: true })
      .mockResolvedValueOnce({ concert_id: 2, inserted: false });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals.upserts_inserted).toBe(1);
    expect(totals.upserts_updated).toBe(1);
  });
});

describe('runScraper — error containment', () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('one site failing its index fetch does not stop the next site', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockImplementation(async (url) => {
      await Promise.resolve();
      if (url === 'https://test.example/events/') throw new Error('index down');
      if (url === 'https://test-b.example/events/') return '<index>';
      return '<event>';
    });
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue(['https://test-b.example/event/x/']);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockReturnValue(fakeParsedConcert('x'));
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(2);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValue({ concert_id: 99, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE, TEST_VENUE_B],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals).toMatchObject({
      sites_attempted: 2,
      sites_succeeded: 1,
      index_errors: 1,
      upserts_total: 1,
    });
  });

  it('one event page fetch failing does not skip the others', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockImplementation(async (url) => {
      await Promise.resolve();
      if (url.endsWith('/events/')) return '<index>';
      if (url.endsWith('/event/b/')) throw new Error('404');
      return '<event>';
    });
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue([
        'https://test.example/event/a/',
        'https://test.example/event/b/',
        'https://test.example/event/c/',
      ]);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockImplementation((_, url) => fakeParsedConcert(url));
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValue({ concert_id: 7, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals).toMatchObject({
      events_seen: 3,
      fetch_errors: 1,
      upserts_total: 2,
    });
    expect(upsertConcert).toHaveBeenCalledTimes(2);
  });

  it('parse-step errors are counted and do not abort the run', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockResolvedValue('<event>');
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue(['https://test.example/event/a/', 'https://test.example/event/b/']);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockImplementationOnce(() => {
        throw new Error('malformed JSON-LD');
      })
      .mockImplementationOnce((_, url) => fakeParsedConcert(url));
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValue({ concert_id: 7, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals.parse_errors).toBe(1);
    expect(totals.upserts_total).toBe(1);
  });

  it('counts pages whose Event block is missing (parser returns null) separately from parse errors', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockResolvedValue('<page>');
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue(['https://test.example/event/gone/']);
    const parseEventPage = jest.fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>().mockReturnValue(null);
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValue({ concert_id: 7, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals.pages_without_event_block).toBe(1);
    expect(totals.parse_errors).toBe(0);
    expect(totals.upserts_total).toBe(0);
    expect(resolveVenueId).not.toHaveBeenCalled();
  });

  it('upsert-step errors are counted as upsert_errors (not venue_resolve_errors) and do not abort the run', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockResolvedValue('<event>');
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue(['https://test.example/event/a/', 'https://test.example/event/b/']);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockImplementation((_, url) => fakeParsedConcert(url));
    const resolveVenueId = jest.fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>().mockResolvedValue(1);
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ concert_id: 7, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals.upsert_errors).toBe(1);
    expect(totals.venue_resolve_errors).toBe(0);
    expect(totals.upserts_total).toBe(1);
  });

  it('venue-resolve errors are counted as venue_resolve_errors (not upsert_errors) so dashboards can distinguish DB-down from enum-drift', async () => {
    const fetchHtml = jest.fn<ReturnType<FetchHtmlFn>, Parameters<FetchHtmlFn>>().mockResolvedValue('<event>');
    const extractEventLinks = jest
      .fn<ReturnType<ExtractEventLinksFn>, Parameters<ExtractEventLinksFn>>()
      .mockReturnValue(['https://test.example/event/a/']);
    const parseEventPage = jest
      .fn<ReturnType<ParseEventPageFn>, Parameters<ParseEventPageFn>>()
      .mockImplementation((_, url) => fakeParsedConcert(url));
    const resolveVenueId = jest
      .fn<ReturnType<ResolveVenueIdFn>, Parameters<ResolveVenueIdFn>>()
      .mockRejectedValueOnce(new Error('pool exhausted'));
    const upsertConcert = jest
      .fn<ReturnType<UpsertConcertFn>, Parameters<UpsertConcertFn>>()
      .mockResolvedValue({ concert_id: 7, inserted: true });

    const totals = await runScraper({
      sites: [TEST_VENUE],
      concurrency: 1,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId,
      upsertConcert,
      mapConcurrent: realMapConcurrent,
    });

    expect(totals.venue_resolve_errors).toBe(1);
    expect(totals.upsert_errors).toBe(0);
    expect(totals.upserts_total).toBe(0);
    expect(upsertConcert).not.toHaveBeenCalled();
  });
});
