import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';
import {
  mockCatalogTiers,
  catalogTierCallLog,
  lastCatalogQuerySql,
  mockAliasTierRows,
  resetCatalogTierRows,
} from '../../utils/catalog-search-sql-mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
const mockGetRelease = jest.fn<(releaseId: number) => Promise<unknown>>();

class MockLmlClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LmlClientError';
    this.statusCode = statusCode;
  }
}

jest.mock('@wxyc/lml-client', () => {
  // BS#2765: `library.service.ts`'s track-search path now also imports
  // `isCallerRelativeDegradation` + `shedReasonOf` from this module. Load
  // them from the REAL module (same rationale as
  // `tests/unit/services/lml/lookup-coordinator.test.ts`'s BS#2528 review
  // comment) rather than omitting them — an omitted named export resolves to
  // `undefined` here, and calling it throws inside
  // `searchLibraryByTrackUncachedOrThrow`, silently degrading every Track 2
  // result in this suite to the caught-error empty-array path.
  const actual = jest.requireActual<typeof import('@wxyc/lml-client')>('@wxyc/lml-client');
  return {
    lookupMetadata: mockLookupMetadata,
    lookupBySong: mockLookupBySong,
    isLmlConfigured: mockIsLmlConfigured,
    getRelease: mockGetRelease,
    envInt: (_name: string, fallback: number) => fallback,
    LmlClientError: MockLmlClientError,
    isCallerRelativeDegradation: actual.isCallerRelativeDegradation,
    shedReasonOf: actual.shedReasonOf,
  };
});

const mockSpanSetAttribute = jest.fn();
const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttribute: typeof mockSpanSetAttribute; setAttributes: typeof mockSpanSetAttributes };
const spanInstance: SpanLike = { setAttribute: mockSpanSetAttribute, setAttributes: mockSpanSetAttributes };
const mockStartSpan = jest.fn(
  <T>(_opts: { name: string; op: string }, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance))
);
const mockGetActiveSpan = jest.fn(() => spanInstance);
jest.mock('@sentry/node', () => ({
  startSpan: <T>(opts: { name: string; op: string }, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    mockStartSpan(opts, callback),
  getActiveSpan: () => mockGetActiveSpan(),
}));

import {
  searchLibrary,
  searchByArtist,
  fuzzySearchLibrary,
  __resetTrackSearchCacheForTests,
} from '../../../apps/backend/services/library.service';
import {
  searchLibrary as searchCatalogQuery,
  type CatalogSort,
  type CatalogOrder,
} from '../../../apps/backend/services/library-search.service';
import { resetConfig as resetCatalogSearchAliasConfig } from '../../../apps/backend/config/catalogSearchAlias';
import { resetConfig as resetCatalogTrackSearchConfig } from '../../../apps/backend/config/catalogTrackSearch';

const baseViewRow = {
  id: 42,
  code_letters: 'OH',
  code_artist_number: 7,
  code_number: 1,
  artist_name: 'OHSEES',
  alphabetical_name: 'OHSEES',
  album_title: 'A Weird Exits',
  format_name: 'CD',
  genre_name: 'Rock',
  rotation_bin: null,
  add_date: new Date('2024-01-15'),
  label: 'Castle Face',
  label_id: null,
  on_streaming: true,
  album_artist: null,
  plays: 7,
  artwork_url: null,
  artist_id: 9001,
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  wikidata_qid: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
};

/**
 * Flatten the `tests/__mocks__/drizzle-orm.ts` stand-in for a Drizzle `SQL`
 * object into readable text with its interpolated values inlined, so an
 * assertion can read like the SQL it pins (`similarity(asa.variant, monolake)
 * >= 0.4`) instead of like a JSON blob.
 *
 * The mocked `sql` tag returns `{ sql: TemplateStringsArray, values }`, and a
 * nested `sql` fragment shows up as one of those `values` — so rendering is
 * "interleave the literals with the recursively-rendered values". Columns come
 * from the mocked `@wxyc/database`, whose tables are plain string maps, so an
 * unmapped column renders as `undefined`; that's harmless here because every
 * assertion below targets literal SQL text or an unqualified sort alias.
 */
function renderSqlWithParams(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  const literals = (node as { sql?: unknown }).sql;
  if (Array.isArray(literals)) {
    const values = (node as { values?: unknown[] }).values ?? [];
    return literals
      .map((text, i) => `${String(text)}${i < values.length ? renderSqlWithParams(values[i]) : ''}`)
      .join('');
  }
  const raw = (node as { raw?: unknown }).raw;
  if (typeof raw === 'string') return raw;
  return JSON.stringify(node) ?? '';
}

describe('catalog search — alias-aware LATERAL JOIN (PR 5)', () => {
  const originalFlag = process.env.CATALOG_SEARCH_ALIAS_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCatalogTierRows();
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    resetCatalogSearchAliasConfig();
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    else process.env.CATALOG_SEARCH_ALIAS_ENABLED = originalFlag;
    resetCatalogSearchAliasConfig();
  });

  describe('searchLibrary (Both-mode trigram path)', () => {
    it('flag off: trigram row without alias fields → matched_via_alias absent (raw alias SQL never fires)', async () => {
      // Every tier issues raw `db.execute` now, selected by SQL content — the
      // flag-off trigram shape is `trigram`, the flag-on one is `alias`.
      mockCatalogTiers(db.execute, { tsvector: [], trigram: [baseViewRow] });
      db.select.mockReset();

      const results = await searchLibrary('Thee Oh Sees');

      // The alias CTE never ran, which is the load-bearing claim here.
      expect(catalogTierCallLog(db.execute)).not.toContain('alias');
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('id', 42);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
    });

    it('flag on: alias_hit fields present → matched_via_alias attached with matched_variant + source', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      const aliasRow = {
        ...baseViewRow,
        alias_max_sim: 0.78,
        alias_matched_variant: 'Thee Oh Sees',
        alias_matched_source: 'discogs_name_variation',
      };
      mockCatalogTiers(db.execute, { tsvector: [], alias: [aliasRow] });
      db.select.mockReset();

      const results = await searchLibrary('Thee Oh Sees');

      expect(catalogTierCallLog(db.execute)).toContain('alias');
      expect(results).toHaveLength(1);
      const hit = results[0] as { matched_via_alias?: Array<{ matched_variant: string; source: string }> };
      expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' }]);
    });

    it('flag on: alias_hit fields null → matched_via_alias remains absent', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      db.select.mockReset();

      const trigramOnlyRow = {
        ...baseViewRow,
        alias_max_sim: null,
        alias_matched_variant: null,
        alias_matched_source: null,
      };
      mockAliasTierRows(db.execute, [trigramOnlyRow]);

      const results = await searchLibrary('OHSEES');

      expect(results).toHaveLength(1);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
    });

    it('flag on: tsvector hit short-circuits — alias raw SQL never runs', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      mockCatalogTiers(db.execute, { tsvector: [baseViewRow] });
      db.select.mockReset();

      const results = await searchLibrary('Autechre');

      expect(results).toHaveLength(1);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
      // The tsvector tier now goes through `db.execute` too, so "the alias SQL
      // never ran" is asserted by naming the tiers rather than by no call at all.
      expect(catalogTierCallLog(db.execute)).toEqual(['tsvector']);
    });
  });

  // -----------------------------------------------------------------------
  // BS#3552 — a stage-1 tsvector hit hid every alias match on `GET /library/`.
  //
  // `searchLibraryBothMode` returned as soon as the tsvector tier found
  // anything, and only the trigram tier (stage 2) consults the alias
  // substrate. So `Giddens` matched Jerry Giddens in stage 1 and the
  // Carolina Chocolate Drops card, filed with the alternate name
  // "Rhiannon Giddens", never surfaced. The fix appends the alias-only rows
  // after the stage-1 rows on the catalog route (`fuzzySearchLibrary` with
  // the same string in both fields), and only there: the request-line
  // `searchLibrary` keeps returning stage 1 alone (pinned above by
  // "flag on: tsvector hit short-circuits").
  // -----------------------------------------------------------------------
  describe('fuzzySearchLibrary Both-mode — alias hits after a stage-1 tsvector hit (BS#3552)', () => {
    const directRow = {
      ...baseViewRow,
      id: 1301,
      artist_id: 1301,
      code_letters: 'GI',
      code_artist_number: 13,
      artist_name: 'Jerry Giddens',
      alphabetical_name: 'Giddens, Jerry',
      album_title: "Livin' Ain't Easy",
    };
    const aliasFields = {
      alias_max_sim: 0.47,
      alias_matched_variant: 'Rhiannon Giddens',
      alias_matched_source: 'wxyc_library_alt',
    };
    const aliasRows = [
      {
        ...baseViewRow,
        id: 4908,
        artist_id: 4900,
        code_letters: 'CA',
        code_artist_number: 49,
        code_number: 8,
        artist_name: 'Carolina Chocolate Drops',
        alphabetical_name: 'Carolina Chocolate Drops',
        album_title: 'Songs of our Native Daughters',
        ...aliasFields,
      },
      {
        ...baseViewRow,
        id: 4904,
        artist_id: 4900,
        code_letters: 'CA',
        code_artist_number: 49,
        code_number: 4,
        artist_name: 'Carolina Chocolate Drops',
        alphabetical_name: 'Carolina Chocolate Drops',
        album_title: 'Genuine Negro Jig',
        ...aliasFields,
      },
    ];
    const aliasHint = [{ matched_variant: 'Rhiannon Giddens', source: 'wxyc_library_alt' }];

    function setAliasFlag(enabled: boolean): void {
      if (enabled) {
        process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      } else {
        delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
      }
      resetCatalogSearchAliasConfig();
    }

    // A release in several active rotation bins fans out to rows that share
    // one id. `albumScopedQuery`'s `DISTINCT ON (id)` collapses them today,
    // but `n` counts albums, so the probe's room and the page must be counted
    // in distinct ids and never cut an album's rows (PR #3558 review).
    const secondDirect = { ...directRow, id: 1302, album_title: 'Giddens Blues' };
    const fanOutRotationRow = { ...directRow, rotation_bin: 'H' };
    const fanOutAliasRow = { ...aliasRows[0], rotation_bin: 'M' };

    // BS#3578: when stage 1 fills (or nearly fills) the page, `floor(n / 10)`
    // albums are held for alias hits. Generated albums keep a 50-album page
    // readable as counts. Stage-1 order is rank order, so the last albums are
    // the weakest, and those are the ones that give way.
    const stage1Albums = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...directRow,
        id: 2001 + i,
        code_number: i + 1,
        album_title: `Giddens Session ${i + 1}`,
      }));
    const aliasAlbums = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...aliasRows[0], id: 5001 + i, code_number: i + 1 }));
    const idsOf = (rows: Array<{ id: number }>) => rows.map((r) => r.id);
    // A full n=10 page whose 9th album (kept) and 10th album (dropped) each
    // fan out to two rows, against an alias album that fans out too.
    const fullTen = stage1Albums(10);
    const fullTenWithFanOut = [
      ...fullTen.slice(0, 9),
      { ...fullTen[8], rotation_bin: 'H' },
      fullTen[9],
      { ...fullTen[9], rotation_bin: 'M' },
    ];
    const reserveAlias = aliasAlbums(2);
    const reserveAliasWithFanOut = [reserveAlias[0], { ...reserveAlias[0], rotation_bin: 'M' }, reserveAlias[1]];

    it.each([
      {
        label: 'surname query, stage 1 hits a different artist: alias rows follow the direct row',
        flag: true,
        query: 'Giddens',
        n: 50,
        tiers: { tsvector: [directRow], aliasAppend: aliasRows },
        expectedIds: [1301, 4908, 4904],
        expectedTiers: ['tsvector', 'aliasAppend'],
      },
      {
        label: 'full-name query falls through to stage 2 (existing alias-aware trigram path, unchanged)',
        flag: true,
        query: 'Rhiannon Giddens',
        n: 50,
        tiers: { tsvector: [], alias: aliasRows },
        expectedIds: [4908, 4904],
        expectedTiers: ['tsvector', 'alias'],
      },
      {
        label: 'flag off: stage 1 returns alone and the alias probe never runs',
        flag: false,
        query: 'Giddens',
        n: 50,
        tiers: { tsvector: [directRow], aliasAppend: aliasRows },
        expectedIds: [1301],
        expectedTiers: ['tsvector'],
      },
      {
        label: 'rotation fan-out: 2 stage-1 albums as 3 rows leave room for 2 alias albums, all rows kept',
        flag: true,
        query: 'Giddens',
        n: 4,
        tiers: {
          tsvector: [directRow, fanOutRotationRow, secondDirect],
          aliasAppend: [aliasRows[0], fanOutAliasRow, aliasRows[1]],
        },
        expectedIds: [1301, 1301, 1302, 4908, 4908, 4904],
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 2,
      },
      {
        label: 'full page n=50, 3 alias albums: the 3 weakest stage-1 albums give way (47 + 3)',
        flag: true,
        query: 'Giddens',
        n: 50,
        tiers: { tsvector: stage1Albums(50), aliasAppend: aliasAlbums(3) },
        expectedIds: [...idsOf(stage1Albums(47)), ...idsOf(aliasAlbums(3))],
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 5,
        expectedAlbums: { stage1: 47, alias: 3 },
      },
      {
        label: 'full page n=50, 8 alias albums: the probe asks for the reserve only (45 + 5)',
        flag: true,
        query: 'Giddens',
        n: 50,
        tiers: { tsvector: stage1Albums(50), aliasAppend: aliasAlbums(8) },
        expectedIds: [...idsOf(stage1Albums(45)), ...idsOf(aliasAlbums(5))],
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 5,
        expectedAlbums: { stage1: 45, alias: 5 },
      },
      {
        label: 'room 10 on n=50, 4 alias albums: every stage-1 album stays (40 + 4)',
        flag: true,
        query: 'Giddens',
        n: 50,
        tiers: { tsvector: stage1Albums(40), aliasAppend: aliasAlbums(4) },
        expectedIds: [...idsOf(stage1Albums(40)), ...idsOf(aliasAlbums(4))],
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 10,
        expectedAlbums: { stage1: 40, alias: 4 },
      },
      {
        label: 'full page n=5: a page under 10 reserves nothing, so the probe is skipped',
        flag: true,
        query: 'Giddens',
        n: 5,
        tiers: { tsvector: stage1Albums(5), aliasAppend: aliasAlbums(3) },
        expectedIds: idsOf(stage1Albums(5)),
        expectedTiers: ['tsvector'],
        expectedAlbums: { stage1: 5, alias: 0 },
      },
      {
        label: 'full page n=50, no alias hits: stage 1 is returned unchanged',
        flag: true,
        query: 'Giddens',
        n: 50,
        tiers: { tsvector: stage1Albums(50), aliasAppend: [] },
        expectedIds: idsOf(stage1Albums(50)),
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 5,
        expectedAlbums: { stage1: 50, alias: 0 },
      },
      {
        label: 'full page n=10 with fan-out: albums are trimmed whole, never mid-album (9 + 1)',
        flag: true,
        query: 'Giddens',
        n: 10,
        tiers: { tsvector: fullTenWithFanOut, aliasAppend: reserveAliasWithFanOut },
        expectedIds: [...idsOf(fullTen.slice(0, 9)), fullTen[8].id, reserveAlias[0].id, reserveAlias[0].id],
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 1,
        expectedAlbums: { stage1: 9, alias: 1 },
      },
      {
        // Real SQL caps the probe at `album_rank <= 1`; this probe ignores it.
        label: 'probe returns more alias albums than n (cannot happen today): the page still holds n (9 + 1)',
        flag: true,
        query: 'Giddens',
        n: 10,
        tiers: { tsvector: fullTen, aliasAppend: aliasAlbums(12) },
        uncappedProbe: true,
        expectedIds: [...idsOf(fullTen.slice(0, 9)), aliasAlbums(1)[0].id],
        expectedTiers: ['tsvector', 'aliasAppend'],
        expectedProbeLimit: 1,
        expectedAlbums: { stage1: 9, alias: 1 },
      },
      {
        label: 'n = NaN: no page size to reserve from, so the probe is skipped and stage 1 is unchanged',
        flag: true,
        query: 'Giddens',
        n: NaN,
        tiers: { tsvector: stage1Albums(3), aliasAppend: aliasAlbums(3) },
        expectedIds: idsOf(stage1Albums(3)),
        expectedTiers: ['tsvector'],
        expectedAlbums: { stage1: 3, alias: 0 },
      },
    ])(
      '$label',
      async ({
        flag,
        query,
        n,
        tiers,
        uncappedProbe,
        expectedIds,
        expectedTiers,
        expectedProbeLimit,
        expectedAlbums,
      }) => {
        setAliasFlag(flag);
        // Cut the probe's rows at its own `album_rank <= N`, as Postgres would.
        mockCatalogTiers(db.execute, tiers, { capAliasAppend: !uncappedProbe });

        const results = await fuzzySearchLibrary(query, query, n);

        expect(catalogTierCallLog(db.execute)).toEqual(expectedTiers);
        expect(results.map((r) => r.id)).toEqual(expectedIds);
        // `n` counts albums: the page never holds more than n distinct ids.
        if (Number.isFinite(n)) {
          expect(new Set(results.map((r) => r.id)).size).toBeLessThanOrEqual(n);
        }
        if (expectedProbeLimit !== undefined) {
          expect(lastCatalogQuerySql(db.execute, 'aliasAppend').replace(/\s+/g, ' ')).toContain(
            `album_rank <= ${expectedProbeLimit}`
          );
        }
        if (expectedAlbums !== undefined) {
          const distinct = (rows: typeof results) => new Set(rows.map((r) => r.id)).size;
          expect({
            stage1: distinct(results.filter((r) => !r.matched_via_alias)),
            alias: distinct(results.filter((r) => r.matched_via_alias)),
          }).toEqual(expectedAlbums);
        }
        // BS#2020: every alias row comes after every stage-1 row.
        const lastDirect = results.reduce((last, r, i) => (r.matched_via_alias ? last : i), -1);
        const firstAlias = results.findIndex((r) => r.matched_via_alias);
        if (firstAlias >= 0) {
          expect(lastDirect).toBeLessThan(firstAlias);
        }
        const aliasIds = new Set([...(tiers.aliasAppend ?? []), ...(tiers.alias ?? [])].map((r) => r.id));
        for (const row of results) {
          if (aliasIds.has(row.id)) {
            expect(row.matched_via_alias).toEqual(aliasHint);
          } else {
            expect(row.matched_via_alias).toBeUndefined();
          }
          // The CTE's helper columns never reach the wire shape.
          expect(row).not.toHaveProperty('alias_max_sim');
        }
      }
    );

    it('flag off: the stage-1 result is returned as-is (byte-identical to before)', async () => {
      setAliasFlag(false);
      mockCatalogTiers(db.execute, { tsvector: [directRow] });

      const results = await fuzzySearchLibrary('Giddens', 'Giddens', 50);

      expect(results).toEqual([directRow]);
    });

    it('BS#2020: an exact-variant alias row still never outranks a stage-1 row', async () => {
      // The trigram tier exempts exact variants (`alias_max_sim = 1`) from the
      // fuzzy-alias tier and lets them rank on score. Appending is structural,
      // so even a perfect alias hit stays behind every stage-1 row.
      setAliasFlag(true);
      const exactAlias = { ...aliasRows[0], alias_max_sim: 1, alias_matched_variant: 'Giddens' };
      mockCatalogTiers(db.execute, { tsvector: [directRow, secondDirect], aliasAppend: [exactAlias] });

      const results = await fuzzySearchLibrary('Giddens', 'Giddens', 50);

      expect(results.map((r) => r.id)).toEqual([1301, 1302, 4908]);
    });

    it('stage 1 already filled the page: the probe is skipped', async () => {
      setAliasFlag(true);
      mockCatalogTiers(db.execute, { tsvector: [directRow], aliasAppend: aliasRows });

      const results = await fuzzySearchLibrary('Giddens', 'Giddens', 1);

      expect(catalogTierCallLog(db.execute)).toEqual(['tsvector']);
      expect(results.map((r) => r.id)).toEqual([1301]);
    });

    it('asks the probe for only the albums left under n, and dedupes by id', async () => {
      setAliasFlag(true);
      // The probe's SQL excludes stage-1 rows itself; the id dedupe is the
      // belt to that brace, so feed it a duplicate to prove it holds.
      const duplicate = { ...directRow, ...aliasFields };
      mockCatalogTiers(db.execute, { tsvector: [directRow], aliasAppend: [duplicate, ...aliasRows] });

      const results = await fuzzySearchLibrary('Giddens', 'Giddens', 3);

      expect(results.map((r) => r.id)).toEqual([1301, 4908, 4904]);
      expect(new Set(results.map((r) => r.id)).size).toBeLessThanOrEqual(3);
      expect(results[0].matched_via_alias).toBeUndefined();
      expect(lastCatalogQuerySql(db.execute, 'aliasAppend').replace(/\s+/g, ' ')).toContain('album_rank <= 2');
    });

    it('the probe reuses the shared alias definition and excludes every stage-1 match in SQL', async () => {
      setAliasFlag(true);
      mockCatalogTiers(db.execute, { tsvector: [directRow] });

      await fuzzySearchLibrary('Giddens', 'Giddens', 50, true);

      const rendered = lastCatalogQuerySql(db.execute, 'aliasAppend').replace(/\s+/g, ' ');
      // `buildAliasHitsCte`, floor included: one definition of an alias match.
      expect(rendered).toContain('WITH alias_hits AS');
      expect(rendered).toContain('similarity(asa.variant, Giddens) >= 0.4');
      expect(rendered).toContain('INNER JOIN alias_hits ON alias_hits.artist_id = library.artist_id');
      // Rows the tsvector tier matched are direct hits, whether or not they
      // made stage 1's page, so they must never come back tagged as alias
      // rows. NULL-safe for the same reason as BS#2031.
      expect(rendered).toMatch(/\(library\.search_doc @@ .*\) IS NOT TRUE/);
      expect(rendered).toContain('library.on_streaming = true');
      // Same relevance ordering as the stage-2 alias path.
      expect(rendered).toContain('ORDER BY (alias_max_sim IS NOT NULL AND alias_max_sim < 1) ASC, GREATEST(');
      expect(rendered).not.toContain('UNION ALL');
    });

    it('a one-character query never runs the probe (mirrors the stage-2 length gate)', async () => {
      setAliasFlag(true);
      mockCatalogTiers(db.execute, { tsvector: [directRow], aliasAppend: aliasRows });

      const results = await fuzzySearchLibrary('G', 'G', 50);

      expect(catalogTierCallLog(db.execute)).toEqual(['tsvector']);
      expect(results.map((r) => r.id)).toEqual([1301]);
    });
  });

  describe('searchLibrary (Both-mode) — alias-only trigram hits no longer suppress the cascade (BS#1885)', () => {
    const originalCta = process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
    const originalDiscogs = process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;

    beforeEach(() => {
      delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      resetCatalogTrackSearchConfig();
      __resetTrackSearchCacheForTests();
    });

    afterAll(() => {
      if (originalCta === undefined) delete process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED;
      else process.env.CATALOG_TRACK_SEARCH_CTA_ENABLED = originalCta;
      if (originalDiscogs === undefined) delete process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED;
      else process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = originalDiscogs;
      resetCatalogTrackSearchConfig();
    });

    it('a genuine (non-alias) trigram row present — early return, cascade never runs', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      db.select.mockReset();

      mockAliasTierRows(db.execute, [
        { ...baseViewRow, alias_max_sim: null, alias_matched_variant: null, alias_matched_source: null },
        {
          ...baseViewRow,
          id: 43,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      const results = await searchLibrary('OHSEES');

      expect(mockLookupBySong).not.toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('all trigram rows alias-tagged, cascade flags off — rows returned unchanged', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      db.select.mockReset();

      mockAliasTierRows(db.execute, [
        {
          ...baseViewRow,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      const results = await searchLibrary('Thee Oh Sees');

      // Cascade flags default off, so runCatalogTrackSearchCascade no-ops
      // without touching LML or the DB — proving the alias-only rows aren't
      // silently swapped for an empty cascade result.
      expect(mockLookupBySong).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('all trigram rows alias-tagged, Track 2 (LML) resolves — merged cascade-first', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // Jessica Pratt / "On Your Own Love Again" — WXYC canonical fixture
      // (matches the Track 2 case in library.service.test.ts).
      const trackRow = {
        id: 101,
        code_letters: 'PR',
        code_artist_number: 1,
        code_number: 2,
        artist_name: 'Jessica Pratt',
        alphabetical_name: 'Pratt, Jessica',
        album_title: 'On Your Own Love Again',
        format_name: 'CD',
        genre_name: 'Rock',
        rotation_bin: null,
        add_date: new Date('2024-02-01'),
        label: 'Drag City',
        label_id: null,
        on_streaming: true,
        album_artist: null,
        plays: 12,
        artwork_url: null,
        legacy_release_id: 555,
        artist_id: 9002,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };

      const libraryChain = createMockQueryChain([trackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([trackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      // CTA/Track 1 stays off (only CATALOG_TRACK_SEARCH_DISCOGS_ENABLED is
      // set above), so `db.select` is now called only for the Track 2 library
      // bridge query and the CTA-exclusion query. The tsvector tier no longer
      // takes the first slot — it, and both trigram shapes, read via raw
      // `db.execute` SQL, which `mockCatalogTiers` dispatches on content.
      const chains = [libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });

      mockAliasTierRows(db.execute, [
        {
          ...baseViewRow,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      mockLookupBySong.mockReset();
      mockLookupBySong.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 555,
              title: 'On Your Own Love Again',
              artist: 'Jessica Pratt',
              call_number: 'Rock CD PR 1/2',
              library_url: 'https://library.wxyc.org/release/555',
            },
            matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await searchLibrary('Back, Baby');

      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
      // Cascade-first ordering.
      expect(results[0].id).toBe(101);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'discogs_release' });
      const aliasHit = results.find((r) => r.id === 42);
      expect(aliasHit?.matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('BS#1886: Track 2 resolves a non-streaming row under on_streaming=true — cascade row is scoped out, never leaks', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // The Track 2 bridge row is NOT on streaming. `searchLibraryByTrackRaw`
      // does not honor `on_streaming`, so without the shared-cascade scope it
      // would leak into an `on_streaming=true` result (Both-mode has no
      // in-memory re-filter of its own, unlike `/library/query`).
      const nonStreamingTrackRow = {
        id: 101,
        code_letters: 'PR',
        code_artist_number: 1,
        code_number: 2,
        artist_name: 'Jessica Pratt',
        alphabetical_name: 'Pratt, Jessica',
        album_title: 'On Your Own Love Again',
        format_name: 'CD',
        genre_name: 'Rock',
        rotation_bin: null,
        add_date: new Date('2024-02-01'),
        label: 'Drag City',
        label_id: null,
        on_streaming: false,
        album_artist: null,
        plays: 12,
        artwork_url: null,
        legacy_release_id: 555,
        artist_id: 9002,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const libraryChain = createMockQueryChain([nonStreamingTrackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([nonStreamingTrackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      const chains = [libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });

      mockAliasTierRows(db.execute, [
        {
          ...baseViewRow,
          on_streaming: true,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      mockLookupBySong.mockReset();
      mockLookupBySong.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 555,
              title: 'On Your Own Love Again',
              artist: 'Jessica Pratt',
              call_number: 'Rock CD PR 1/2',
              library_url: 'https://library.wxyc.org/release/555',
            },
            matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await searchLibrary('Back, Baby', undefined, undefined, 5, true);

      // The cascade ran (LML was consulted) but its sole row is non-streaming,
      // so it's scoped out; only the streaming alias trigram row survives.
      expect(mockLookupBySong).toHaveBeenCalledTimes(1);
      expect(results.find((r) => r.id === 101)).toBeUndefined();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
    });

    it('BS#1886: cascade row collides with an alias id — merge carries matched_via_alias onto the cascade row', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      process.env.CATALOG_TRACK_SEARCH_DISCOGS_ENABLED = 'true';
      resetCatalogTrackSearchConfig();

      // Cascade bridge row shares id 42 with the alias trigram row below.
      const collidingTrackRow = {
        id: 42,
        code_letters: 'OH',
        code_artist_number: 7,
        code_number: 1,
        artist_name: 'OHSEES',
        alphabetical_name: 'OHSEES',
        album_title: 'A Weird Exits',
        format_name: 'CD',
        genre_name: 'Rock',
        rotation_bin: null,
        add_date: new Date('2024-01-15'),
        label: 'Castle Face',
        label_id: null,
        on_streaming: true,
        album_artist: null,
        plays: 7,
        artwork_url: null,
        legacy_release_id: 555,
        artist_id: 9001,
        discogs_artist_id: null,
        musicbrainz_artist_id: null,
        wikidata_qid: null,
        spotify_artist_id: null,
        apple_music_artist_id: null,
        bandcamp_id: null,
      };

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const libraryChain = createMockQueryChain([collidingTrackRow]);
      libraryChain.limit = jest.fn().mockResolvedValue([collidingTrackRow]);
      const ctaChain = createMockQueryChain([]);
      ctaChain.where = jest.fn().mockResolvedValue([]);
      const chains = [libraryChain, ctaChain];
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = chains[Math.min(callIndex, chains.length - 1)];
        callIndex += 1;
        return chain;
      });

      mockAliasTierRows(db.execute, [
        {
          ...baseViewRow,
          alias_max_sim: 0.4,
          alias_matched_variant: 'Thee Oh Sees',
          alias_matched_source: 'discogs_name_variation',
        },
      ]);

      mockLookupBySong.mockReset();
      mockLookupBySong.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 555,
              title: 'A Weird Exits',
              artist: 'OHSEES',
              call_number: 'Rock CD OH 1/7',
              library_url: 'https://library.wxyc.org/release/555',
            },
            matched_via: [{ title: 'Back, Baby', artist_credit: null, confidence: 0.92, source: 'discogs_release' }],
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await searchLibrary('Back, Baby');

      // Single merged row (ids collide): the cascade's matched_via is the
      // stronger signal AND the alias hint rides along, matching the
      // `/library/query` merge.
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
      expect(results[0].matched_via?.[0]).toMatchObject({ source: 'discogs_release' });
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });
  });

  describe('/library/query (library-search.service.searchLibrary)', () => {
    const baseQueryParams = {
      q: 'Thee Oh Sees',
      page: 0,
      limit: 25,
      sort: 'artist' as const,
      order: 'asc' as const,
    };

    const baseQueryRow = {
      id: 42,
      add_date: '2024-01-15',
      album_title: 'A Weird Exits',
      artist_name: 'OHSEES',
      code_letters: 'OH',
      code_number: 1,
      code_artist_number: 7,
      format_name: 'CD',
      genre_name: 'Rock',
      label: 'Castle Face',
      label_id: null,
      rotation_bin: null,
      plays: 7,
      on_streaming: true,
      album_artist: null,
    };

    function stubGenreFormatLookups() {
      // validateEnumFilters calls db.select for genres/formats; tests skip
      // params.genre/format so the validator is a no-op, but the cached
      // sets prime on first call. Return an empty chain to short-circuit.
      const chain = createMockQueryChain([]);
      db.select.mockReset();
      db.select.mockReturnValue(chain);
    }

    it('flag off: query row has no alias fields → matched_via_alias absent', async () => {
      stubGenreFormatLookups();
      db.execute.mockReset();
      // dataQuery, then countQuery — both Promise.all-issued.
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results, total } = await searchCatalogQuery(baseQueryParams);

      expect(total).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
      expect(results[0].matched_via_alias).toBeUndefined();
    });

    it('flag on: alias_hit fields present on row → matched_via_alias attached', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute
        .mockResolvedValueOnce([
          {
            ...baseQueryRow,
            alias_max_sim: 0.85,
            alias_matched_variant: 'Thee Oh Sees',
            alias_matched_source: 'discogs_name_variation',
          },
        ])
        // BS#1885: this row is alias-only (total_non_alias: 0), so the new
        // gate falls through toward the cascade guards — proven harmless
        // here because searchLibrary (library.service) isn't mocked in this
        // file and the cascade flags default off, so runCatalogTrackSearchCascade
        // resolves [] and the alias row passes through unchanged.
        .mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

      const { results } = await searchCatalogQuery(baseQueryParams);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('flag on: alias_hit null on row → matched_via_alias absent', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute
        .mockResolvedValueOnce([
          {
            ...baseQueryRow,
            alias_max_sim: null,
            alias_matched_variant: null,
            alias_matched_source: null,
          },
        ])
        // BS#1885: a genuine (non-alias) row — total_non_alias: 1 pins the
        // short-circuit gate (no cascade fallthrough for a real primary hit).
        .mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);

      const { results } = await searchCatalogQuery(baseQueryParams);

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
    });

    it('flag on + empty q: alias LATERAL is suppressed (no q to match against)', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      // Empty q → conditions=[] → queryWhere=null → fromClause has no WHERE.
      // dataQuery returns rows; alias_max_sim should be absent (not even
      // selected). Verify by returning a row WITHOUT alias fields and
      // confirming no crash.
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery({ ...baseQueryParams, q: '' });

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
    });

    it('flag on + only field-specific conditions: alias path is suppressed (gated on all-field condition)', async () => {
      // A pure `artist:foo` query parses to one field=='artist_name'
      // condition with no `field === 'all'` member, so `hasExpandableAllField`
      // is false and `aliasActive` is false. The catalog query falls through
      // to the legacy single-SELECT path — no CTE, no UNION ALL, no alias
      // substrate join — preserving pre-#1318 behavior for field-specific
      // queries.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery({ ...baseQueryParams, q: 'artist:OHSEES' });

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
      // Both calls are issued via Promise.all (dataQuery + countQuery). The
      // load-bearing assertion is that neither SQL embedded the alias
      // substrate join (LATERAL alias_hit or CTE alias_hits).
      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');
      expect(renderedData).not.toContain('alias_hit');
      expect(renderedCount).not.toContain('alias_hit');
      expect(renderedData).not.toContain('alias_hits');
      expect(renderedCount).not.toContain('alias_hits');
    });

    it('flag on + bare quoted term: alias path is suppressed (quoting opts out of fuzzy matching, BS#2702)', async () => {
      // A quoted term is the user narrowing on purpose. Alias expansion is a
      // widening, and branch (b) selects precisely the rows where the quoted
      // whole-value predicate is NOT TRUE — so leaving the gate open on an
      // exact condition answered a narrowed query with fuzzy neighbours. The
      // quote characters could not even reach the probe: pg_trgm treats `"` as
      // a word separator, so `similarity('cat power', '"cat power"')` is 1 and
      // the alias arm behaved identically to the unquoted query.
      //
      // Same rationale the gate already applied to field-specific queries in
      // the test above; `exact` simply belongs in the same category.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1 }]);

      const { results } = await searchCatalogQuery({ ...baseQueryParams, q: '"OHSEES"' });

      expect(results).toHaveLength(1);
      expect(results[0].matched_via_alias).toBeUndefined();
      const renderedData = JSON.stringify(db.execute.mock.calls[0]?.[0] ?? '');
      const renderedCount = JSON.stringify(db.execute.mock.calls[1]?.[0] ?? '');
      expect(renderedData).not.toContain('alias_hit');
      expect(renderedCount).not.toContain('alias_hit');
    });

    it('flag on + a bare term alongside a quoted one: alias path stays active', async () => {
      // The gate asks whether ANY all-field condition is non-exact, not
      // whether none is exact. `cat "Moon Pix"` carries a bare all-field term,
      // which is a legitimate thing to expand — narrowing one term must not
      // silently disable fuzzy matching for the other.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);

      await searchCatalogQuery({ ...baseQueryParams, q: 'OHSEES "A Weird Exits"' });

      const renderedData = JSON.stringify(db.execute.mock.calls[0]?.[0] ?? '');
      expect(renderedData).toContain('alias_hits');
    });

    it('flag on: branch-B dedupe predicate is NULL-safe so alias-only NULL-label rows survive (BS#1557)', async () => {
      // BS#1557 regression pin. `queryWhereAliasOff` is
      // `(artist ILIKE q OR album ILIKE q OR label ILIKE q)`. `library.label`
      // is nullable, so for an alias-only hit whose matched album has a NULL
      // label the predicate evaluates to NULL (FALSE OR FALSE OR NULL). The
      // old dedupe `NOT (queryWhereAliasOff)` is then `NOT NULL = NULL`, which
      // drops the row from branch B — exactly the row the alias path exists to
      // surface. The fix uses the NULL-safe `(queryWhereAliasOff) IS NOT TRUE`.
      //
      // The mocked DB can't exercise Postgres three-valued logic, so the
      // load-bearing assertion is on the rendered dedupe predicate: it must be
      // the `IS NOT TRUE` form. We also confirm a NULL-label alias-only row the
      // mock returns still projects through unharmed.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();

      const nullLabelAliasRow = {
        ...baseQueryRow,
        label: null,
        alias_max_sim: 0.81,
        alias_matched_variant: 'Thee Oh Sees',
        alias_matched_source: 'discogs_name_variation',
      };
      db.execute.mockReset();
      // BS#1885: alias-only row (total_non_alias: 0).
      db.execute.mockResolvedValueOnce([nullLabelAliasRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 0 }]);

      const { results } = await searchCatalogQuery(baseQueryParams);

      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');

      // The NULL-safe dedupe form must be present in both arms of the UNION.
      expect(renderedData).toContain('IS NOT TRUE');
      expect(renderedCount).toContain('IS NOT TRUE');

      // The NULL-label alias-only row still surfaces with its alias hint.
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(42);
      expect(results[0].label).toBe('');
      expect(results[0].matched_via_alias).toEqual([
        { matched_variant: 'Thee Oh Sees', source: 'discogs_name_variation' },
      ]);
    });

    it('flag on: emits ALT1 UNION ALL shape with alias_hits CTE (BS#1318)', async () => {
      // BS#1318 regression pin: the alias-aware catalog path must use the
      // CTE + UNION ALL form, not the LATERAL JOIN. The LATERAL had a 3-6.5×
      // p95 regression on selective queries because it picked the PK btree
      // and filtered `variant % q` row-by-row, never touching the GIN
      // trigram index. UNION ALL with a CTE lets the planner run the
      // trigram bitmap scan once.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      stubGenreFormatLookups();
      db.execute.mockReset();
      // baseQueryRow carries no alias fields — a genuine (non-alias) row.
      db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);

      await searchCatalogQuery(baseQueryParams);

      const dataCall = db.execute.mock.calls[0]?.[0];
      const countCall = db.execute.mock.calls[1]?.[0];
      const renderedData = JSON.stringify(dataCall ?? '');
      const renderedCount = JSON.stringify(countCall ?? '');

      // Positive: CTE + UNION ALL appear in both queries (data + count).
      expect(renderedData).toContain('alias_hits');
      expect(renderedData).toContain('UNION ALL');
      expect(renderedCount).toContain('alias_hits');
      expect(renderedCount).toContain('UNION ALL');

      // Negative: the LATERAL JOIN must be gone — that's the whole point.
      // `alias_hit` (singular) was the LATERAL alias; with UNION ALL we
      // project from `alias_hits` (the CTE name) instead.
      expect(renderedData).not.toContain('alias_hit ON true');
      expect(renderedCount).not.toContain('alias_hit ON true');
      expect(renderedData).not.toContain('LEFT JOIN LATERAL');
      expect(renderedCount).not.toContain('LEFT JOIN LATERAL');
    });

    // ---------------------------------------------------------------------
    // BS#2018 — alias-branch fuzzy hits flooded the result set.
    //
    // `q=monolake` returned all 14 Bill Monroe albums ahead of the 6 Monolake
    // ones, because (1) Discogs artist 450691 carries the misprint variant
    // "Monore", which clears pg_trgm's 0.30 `%` threshold against "monolake"
    // by 0.03, and (2) `alias_max_sim` was projected but never used in ORDER
    // BY, so a 0.333 typo-collision sorted identically to an exact hit.
    //
    // Fix 1 tiers the sort (alias-only rows always after non-alias rows).
    // Fix 2 raises the alias match floor to 0.40.
    //
    // This tier stays UNCONDITIONAL, unlike the two relevance-ranked paths in
    // `library.service.ts` that BS#2020 narrowed to fuzzy hits only. The
    // narrowing buys nothing here and costs something: this endpoint orders by
    // the caller's chosen column, so an exempted row is not "ranked on its
    // merits", it is merely alphabetized among the real matches — one
    // exact-variant artist with 30 early-alphabet albums would fill page 0.
    // And the argument that justifies exempting elsewhere (no OFFSET, so
    // demoted means deleted) does not apply to a paginated surface.
    // ---------------------------------------------------------------------
    describe('BS#2018 alias-noise floor + rank tiering', () => {
      const ALIAS_ONLY_TIER = '(alias_max_sim IS NOT NULL) ASC';

      function runAliasQuery(
        params: { sort?: CatalogSort; order?: CatalogOrder } = {}
      ): Promise<{ data: string; count: string }> {
        stubGenreFormatLookups();
        db.execute.mockReset();
        db.execute.mockResolvedValueOnce([baseQueryRow]).mockResolvedValueOnce([{ total: 1, total_non_alias: 1 }]);
        return searchCatalogQuery({ ...baseQueryParams, ...params }).then(() => ({
          data: renderSqlWithParams(db.execute.mock.calls[0]?.[0]),
          count: renderSqlWithParams(db.execute.mock.calls[1]?.[0]),
        }));
      }

      beforeEach(() => {
        process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
        delete process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
        resetCatalogSearchAliasConfig();
      });

      const originalFloor = process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
      afterAll(() => {
        // Restore rather than delete, matching the outer describe's handling of
        // CATALOG_SEARCH_ALIAS_ENABLED: a developer with the floor exported in
        // their shell should get their environment back, not a silently unset
        // var for the rest of the Jest worker.
        if (originalFloor === undefined) delete process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
        else process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = originalFloor;
        resetCatalogSearchAliasConfig();
      });

      it('Fix 2: the alias CTE post-filters on similarity >= the configured floor', async () => {
        const { data, count } = await runAliasQuery();

        // The `%` predicate stays — it is what drives the GIN trigram index
        // (`artist_search_alias_variant_trgm_idx`). The floor rides on top of
        // it as a filter, so the index scan is unchanged (BS#1318).
        expect(data).toContain('asa.variant % Thee Oh Sees');
        expect(data).toContain('similarity(asa.variant, Thee Oh Sees) >= 0.4');
        expect(count).toContain('asa.variant % Thee Oh Sees');
        expect(count).toContain('similarity(asa.variant, Thee Oh Sees) >= 0.4');
      });

      it('Fix 2: the floor is operator-tunable via CATALOG_SEARCH_ALIAS_MIN_SIMILARITY', async () => {
        // The AC for Fix 1 depends on this knob: with the floor back at 0.30
        // the noise rows return, which is the only way to observe the tiering.
        process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.3';
        resetCatalogSearchAliasConfig();

        const { data } = await runAliasQuery();

        expect(data).toContain('similarity(asa.variant, Thee Oh Sees) >= 0.3');
      });

      it('Fix 1: alias-only rows are tiered last, ahead of the caller sort', async () => {
        const { data } = await runAliasQuery();

        // The tier key must lead the ORDER BY, and the caller's own sort must
        // still follow it intact. `FALSE < TRUE` in Postgres, so ASC puts the
        // non-alias rows first.
        expect(data).toContain(`ORDER BY ${ALIAS_ONLY_TIER}, artist_name ASC, album_title ASC, id ASC`);
      });

      const SORT_EXPECTATIONS: [CatalogSort, string, string][] = [
        ['artist', 'artist_name', 'album_title'],
        ['album', 'album_title', 'artist_name'],
        ['plays', 'plays', 'artist_name'],
        ['date', 'add_date', 'artist_name'],
      ];

      it.each(
        SORT_EXPECTATIONS.flatMap(([sort, primary, secondary]) =>
          (['asc', 'desc'] as const).map((order) => ({ sort, order, primary, secondary }))
        )
      )('Fix 1: tier leads the ORDER BY for sort=$sort order=$order', async ({ sort, order, primary, secondary }) => {
        const { data } = await runAliasQuery({ sort, order });

        const expected = `ORDER BY ${ALIAS_ONLY_TIER}, ${primary} ${order.toUpperCase()}, ${secondary} ASC, id ASC`;
        expect(data).toContain(expected);
      });

      it('leaves the inner DISTINCT ON dedupe ordering untouched (BS#1554)', async () => {
        const { data } = await runAliasQuery();

        // The rotation-bin dedupe ordinal decides WHICH duplicate row
        // survives; perturbing it changes the surfaced rotation bin. The
        // tier belongs on the OUTER sort only.
        expect(data).toContain('ORDER BY id ASC, CASE rotation_bin');
        expect(data.slice(0, data.indexOf('ORDER BY id ASC, CASE rotation_bin'))).not.toContain(ALIAS_ONLY_TIER);
      });

      it('alias OFF: neither the floor nor the tier appears (legacy path unchanged)', async () => {
        delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
        resetCatalogSearchAliasConfig();

        const { data, count } = await runAliasQuery();

        expect(data).not.toContain('similarity(asa.variant');
        expect(data).not.toContain(ALIAS_ONLY_TIER);
        expect(data).not.toContain('alias_max_sim');
        expect(count).not.toContain('similarity(asa.variant');
        expect(data).toContain('ORDER BY artist_name ASC, album_title ASC, id ASC');
      });
    });
  });

  describe('searchByArtist (request-line single-column trigram)', () => {
    it('flag off: chained builder returns row → matched_via_alias absent', async () => {
      const chain = createMockQueryChain([baseViewRow]);
      chain.limit = jest.fn().mockResolvedValue([baseViewRow]);
      db.select.mockReset();
      db.select.mockReturnValue(chain);
      db.execute.mockReset();

      const results = await searchByArtist('OHSEES');

      expect(results).toHaveLength(1);
      expect((results[0] as { matched_via_alias?: unknown }).matched_via_alias).toBeUndefined();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('flag on: raw SQL returns alias hit → matched_via_alias propagates through enrichLibraryResult', async () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      db.select.mockReset();

      const aliasRow = {
        ...baseViewRow,
        alias_max_sim: 0.92,
        alias_matched_variant: 'Thee Oh Sees',
        alias_matched_source: 'wxyc_library_alt',
      };
      mockAliasTierRows(db.execute, [aliasRow]);

      const results = await searchByArtist('Thee Oh Sees');

      expect(db.execute).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      const hit = results[0] as { matched_via_alias?: Array<{ matched_variant: string; source: string }> };
      expect(hit.matched_via_alias).toEqual([{ matched_variant: 'Thee Oh Sees', source: 'wxyc_library_alt' }]);
    });

    it('flag on: emits ALT1 UNION ALL shape with alias_hits CTE (BS#1318)', async () => {
      // BS#1318 regression pin for the request-line single-column trigram
      // path. Same root cause as the catalog `/library/query` path: the
      // LATERAL was correlated on artist_id and never used the GIN trigram
      // index. UNION ALL with a CTE fixes the plan.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
      db.select.mockReset();
      mockAliasTierRows(db.execute, []);

      await searchByArtist('Thee Oh Sees');

      const call = db.execute.mock.calls[0]?.[0];
      const rendered = JSON.stringify(call ?? '');
      expect(rendered).toContain('alias_hits');
      expect(rendered).toContain('UNION ALL');
      expect(rendered).not.toContain('alias_hit ON true');
      expect(rendered).not.toContain('LEFT JOIN LATERAL');
    });
  });

  describe('searchLibrary (Both-mode trigram path) — ALT1 UNION ALL shape (BS#1318)', () => {
    it('flag on: emits ALT1 UNION ALL shape with alias_hits CTE', async () => {
      // BS#1318 regression pin for the Both-mode trigram fallback in
      // `searchLibraryByTrigramBoth`. The tsvector tier returns 0 rows so
      // the trigram tier fires; assert the SQL uses the new CTE + UNION ALL
      // form rather than the LATERAL JOIN.
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();

      db.select.mockReset();
      mockAliasTierRows(db.execute, []);

      await searchLibrary('Thee Oh Sees');

      // db.execute is called once for the alias-aware trigram query (and
      // potentially for `checkLibraryArtistNameHealth` — but only the
      // alias-aware call embeds the CTE/UNION ALL keywords).
      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeDefined();
      const rendered = JSON.stringify(aliasCall?.[0] ?? '');
      expect(rendered).toContain('alias_hits');
      expect(rendered).toContain('UNION ALL');
      expect(rendered).not.toContain('alias_hit ON true');
      expect(rendered).not.toContain('LEFT JOIN LATERAL');
    });
  });

  // -----------------------------------------------------------------------
  // BS#2020 — alias-only rows could displace real trigram matches.
  //
  // Both alias-aware paths in `library.service.ts` ranked alias-only rows and
  // real matches on a single `GREATEST(...)` scale. Branch (b) INNER JOINs on
  // `artist_id`, so ONE mid-scoring variant admits its artist's entire
  // discography at that score, and every one of those rows outranks any real
  // match scoring below it. Measured against a prod-shaped clone: the variant
  // "Monolake Live" (similarity 0.6429 vs `monolake` — an ordinary name
  // variation, comfortably over BS#2018's 0.40 floor) put 6 Bill Monroe
  // albums on the page and pushed Mono (0.400), Monolord (0.385), Monos
  // (0.364), Midlake / Monokle / Monopot (0.308) off it entirely.
  //
  // Distinct from BS#2018, which fixed `/library/query` — a path whose
  // ORDER BY had no relevance term at all. Here relevance ordering already
  // exists and must be PRESERVED inside each tier, not replaced. That
  // difference is also why only these two paths narrow the tier to fuzzy
  // hits: an exemption is only meaningful where something ranks the exempted
  // row afterwards. See `buildFuzzyAliasTier` for the full argument.
  //
  // The full ORDER BY is four terms, and each earns its place:
  //
  //   1. fuzzy-alias tier   — a 0.64 variant must not outrank a 0.40 real hit
  //   2. GREATEST(...) DESC — relevance, preserved from before the fix
  //   3. direct-match tie   — at EQUAL relevance, prefer the row that matched
  //                           the query text over one that matched a variant
  //   4. id ASC             — determinism
  //
  // Term 3 exists because term 1's guard removed the only signal separating a
  // direct match from an alias match once both score 1.0, which would have
  // left `id ASC` — catalog age — to decide. See the builder for why that is
  // currently unreachable on this path and kept anyway.
  // -----------------------------------------------------------------------
  describe('BS#2020 alias-only rows tier after real trigram matches', () => {
    const FUZZY_ALIAS_TIER = '(alias_max_sim IS NOT NULL AND alias_max_sim < 1) ASC';
    const DIRECT_MATCH_TIE_BREAK = '(alias_max_sim IS NOT NULL) ASC';
    const flat = (text: string) => text.replace(/\s+/g, ' ');

    beforeEach(() => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      resetCatalogSearchAliasConfig();
    });

    /** Render the alias-aware SQL emitted by the Both-mode trigram tier. */
    async function renderBothModeSql(query = 'monolake'): Promise<string> {
      // tsvector tier must return 0 rows so the trigram tier fires.
      db.select.mockReset();
      mockAliasTierRows(db.execute, []);

      await searchLibrary(query);

      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeDefined();
      return flat(renderSqlWithParams(aliasCall?.[0]));
    }

    /** Render the alias-aware SQL emitted by the request-line artist path. */
    async function renderByArtistSql(query = 'monolake'): Promise<string> {
      db.select.mockReset();
      mockAliasTierRows(db.execute, []);

      await searchByArtist(query);

      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeDefined();
      return flat(renderSqlWithParams(aliasCall?.[0]));
    }

    it('Both-mode: the tier leads the ORDER BY, relevance still ranks inside it', async () => {
      const rendered = await renderBothModeSql();

      // Tier FIRST, or a 0.64 alias row still outranks a 0.40 real one.
      expect(rendered).toContain(`ORDER BY ${FUZZY_ALIAS_TIER}, GREATEST(`);
      // GREATEST must survive intact: within a tier the strongest hit leads.
      expect(rendered).toContain('similarity(artist_name, monolake)');
      expect(rendered).toContain('similarity(album_title, monolake)');
      expect(rendered).toContain('COALESCE(alias_max_sim, 0)');
      expect(rendered).toContain(`) DESC, ${DIRECT_MATCH_TIE_BREAK}, id ASC`);
    });

    it('Both-mode: branch (b) dedupes with IS NOT TRUE so NULL-artist_name rows survive (BS#2031)', async () => {
      // `library.artist_name` is nullable: for a NULL artist_name and a
      // non-matching title the trigram predicate is NULL, and `WHERE NOT <NULL>`
      // drops the row from both branches. Only the NULL-safe form keeps the
      // alias-only row. The mocked DB cannot exercise three-valued logic, so
      // pin the rendered form (mirrors the BS#1557 pin for /library/query).
      const rendered = await renderBothModeSql();

      // Branch (b) is the only place `alias_hits` is joined.
      const joinAt = rendered.indexOf('INNER JOIN alias_hits ON');
      expect(joinAt).toBeGreaterThanOrEqual(0);
      const branchB = rendered.slice(joinAt);

      expect(branchB).toContain('% monolake) IS NOT TRUE');
      expect(branchB).not.toMatch(/WHERE NOT\b/);
    });

    it('request-line: the tier leads the ORDER BY (single-column relevance)', async () => {
      const rendered = await renderByArtistSql();

      expect(rendered).toContain(`ORDER BY ${FUZZY_ALIAS_TIER}, GREATEST(`);
      expect(rendered).toContain('similarity(artist_name, monolake)');
      expect(rendered).toContain('COALESCE(alias_max_sim, 0)');
      expect(rendered).toContain(`) DESC, ${DIRECT_MATCH_TIE_BREAK}, id ASC`);
      // No album_title predicate on this path, so none in the ranking either.
      expect(rendered).not.toContain('similarity(album_title');
    });

    it.each([
      ['Both-mode', renderBothModeSql],
      ['request-line', renderByArtistSql],
    ])('%s: the tier sorts ASC so real matches come first (FALSE < TRUE)', async (_label, render) => {
      const rendered = await render();

      // Assert presence before absence. A bare `not.toContain` here would
      // pass against a build with no tier at all — the vacuous-guard trap
      // BS#2019 shipped and had to fix.
      expect(rendered).toContain(FUZZY_ALIAS_TIER);
      // The single most reversible mistake: DESC inverts the fix and
      // promotes every alias row above every real match.
      expect(rendered).not.toContain('(alias_max_sim IS NOT NULL AND alias_max_sim < 1) DESC');
    });

    it.each([
      ['Both-mode', renderBothModeSql],
      ['request-line', renderByArtistSql],
    ])('%s: the exemption and the tie-break appear in that order, not swapped', async (_label, render) => {
      const rendered = await render();

      // Both terms are the same substring apart from the guard, so the thing
      // worth pinning is their POSITIONS: the guarded form must lead and the
      // bare form must trail. Swapped, the bare form becomes the tier and the
      // fix silently reverts to demoting exact variants — which the string
      // assertions above would not catch, since both strings are still there.
      const tierAt = rendered.indexOf(`ORDER BY ${FUZZY_ALIAS_TIER}`);
      const tieBreakAt = rendered.indexOf(`) DESC, ${DIRECT_MATCH_TIE_BREAK}`);
      expect(tierAt).toBeGreaterThanOrEqual(0);
      expect(tieBreakAt).toBeGreaterThan(tierAt);
    });

    it('Both-mode alias OFF: the legacy chained-builder ordering is untouched', async () => {
      delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
      resetCatalogSearchAliasConfig();

      const tsvectorChain = createMockQueryChain([]);
      tsvectorChain.limit = jest.fn().mockResolvedValue([]);
      const trigramChain = createMockQueryChain([]);
      trigramChain.limit = jest.fn().mockResolvedValue([]);
      let callIndex = 0;
      db.select.mockReset();
      db.select.mockImplementation(() => {
        const chain = callIndex === 0 ? tsvectorChain : trigramChain;
        callIndex += 1;
        return chain;
      });
      mockAliasTierRows(db.execute, []);

      await searchLibrary('monolake');

      // BS#1318 requires the alias-OFF path stay byte-identical so the
      // planner keeps reaching the per-column GIN trigram indexes. The tier
      // references a column that branch (a) alone does not project.
      const ordering = trigramChain.orderBy.mock.calls.flat().map(renderSqlWithParams).join(' | ');
      expect(ordering).not.toContain('alias_max_sim');
      const aliasCall = db.execute.mock.calls.find((call) => JSON.stringify(call[0] ?? '').includes('alias_hits'));
      expect(aliasCall).toBeUndefined();
    });
  });
});
