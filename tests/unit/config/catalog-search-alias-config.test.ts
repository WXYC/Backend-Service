/**
 * Unit tests for the catalog-search-alias config (BS#2018).
 *
 * Two properties under test:
 *
 *   1. `enabled` keeps the strict `=== 'true'` contract it had when this
 *      config was a bare `createEnvFlagConfig` flag. Widening the catalog
 *      search path must not happen on `=1`/`TRUE`/`yes`.
 *   2. `minSimilarity` — the BS#2018 trigram floor applied to
 *      `artist_search_alias.variant` matches, on top of pg_trgm's `%`
 *      operator (which is itself pinned at the 0.30 session default).
 *
 * The `MEASURED_*` tables below are the load-bearing part. They are real
 * `similarity()` readings taken against PostgreSQL 18 / pg_trgm on the
 * prod-shaped alias substrate; the default floor has to sit strictly between
 * them. A future tuning pass that moves `DEFAULT_ALIAS_MIN_SIMILARITY`
 * without re-measuring will fail here rather than silently resurrect the
 * `q=monolake` -> "Bill Monroe" flood, or silently drop `Osees`.
 */
import {
  getConfig,
  loadConfig,
  resetConfig,
  DEFAULT_ALIAS_MIN_SIMILARITY,
  PG_TRGM_DEFAULT_THRESHOLD,
} from '../../../apps/backend/config/catalogSearchAlias';

/**
 * Alias variants that trigram-collide with an unrelated query at pg_trgm's
 * default 0.30 threshold. Every one of these is a real production false
 * positive found in the BS#2018 investigation — each admits its artist's
 * ENTIRE discography into the result set via the branch-(b) INNER JOIN.
 */
const MEASURED_FALSE_POSITIVES = [
  // Discogs artist 450691 (Bill Monroe) carries the misprint "Monore" among
  // its 42 `namevariations`. This is the screenshot in BS#2018.
  { variant: 'Monore', query: 'monolake', similarity: 0.33333 },
  // Same artist, same shape, different query: "William Parker" is a real
  // WXYC jazz artist whose catalog search returns Bill Monroe today.
  { variant: 'William Monroe', query: 'William Parker', similarity: 0.36364 },
  { variant: 'Monroe, William', query: 'William Parker', similarity: 0.36364 },
] as const;

/**
 * Alias variants that MUST keep matching — the cases the alias substrate
 * exists to serve (BS#1273 / BS#1318). Note `oh sees` sits exactly ON the
 * default floor: raising the floor past 0.40 drops it.
 */
const MEASURED_TRUE_POSITIVES = [
  { variant: 'oh sees', query: 'Osees', similarity: 0.4 },
  { variant: 'Thee Oh Sees', query: 'theeohsees', similarity: 0.41176 },
  { variant: 'Stereolab', query: 'stereolb', similarity: 0.58333 },
  // Diacritic folds — the three Unicode-bearing names in wxyc-shared's
  // canonical artist pool.
  { variant: 'Nilufer Yanya', query: 'Nilüfer Yanya', similarity: 0.64706 },
  { variant: 'Csillagrablok', query: 'Csillagrablók', similarity: 0.64706 },
  { variant: 'Hermanos Gutierrez', query: 'Hermanos Gutiérrez', similarity: 0.72727 },
  { variant: 'Robert Henke', query: 'robert henke', similarity: 1.0 },
] as const;

describe('catalogSearchAlias config', () => {
  const originalEnabled = process.env.CATALOG_SEARCH_ALIAS_ENABLED;
  const originalFloor = process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    delete process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
    resetConfig();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    if (originalEnabled === undefined) delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
    else process.env.CATALOG_SEARCH_ALIAS_ENABLED = originalEnabled;
    if (originalFloor === undefined) delete process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY;
    else process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = originalFloor;
    resetConfig();
  });

  describe('enabled (unchanged strict-true contract)', () => {
    it('defaults to disabled when the env var is unset', () => {
      expect(loadConfig().enabled).toBe(false);
    });

    it('enables only on the exact string "true"', () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      expect(loadConfig().enabled).toBe(true);
    });

    it.each(['1', 'TRUE', 'yes', 'on', ''])('does not enable on non-canonical value %p', (value) => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = value;
      expect(loadConfig().enabled).toBe(false);
    });

    it('caches the singleton until resetConfig() is called', () => {
      process.env.CATALOG_SEARCH_ALIAS_ENABLED = 'true';
      expect(getConfig().enabled).toBe(true);
      delete process.env.CATALOG_SEARCH_ALIAS_ENABLED;
      expect(getConfig().enabled).toBe(true);
      resetConfig();
      expect(getConfig().enabled).toBe(false);
    });
  });

  describe('minSimilarity (BS#2018 alias trigram floor)', () => {
    it('defaults to DEFAULT_ALIAS_MIN_SIMILARITY when unset', () => {
      expect(loadConfig().minSimilarity).toBe(DEFAULT_ALIAS_MIN_SIMILARITY);
      expect(DEFAULT_ALIAS_MIN_SIMILARITY).toBe(0.4);
    });

    it('reads a valid override', () => {
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.35';
      expect(loadConfig().minSimilarity).toBe(0.35);
    });

    it('accepts the pg_trgm default, which reverts to pre-BS#2018 behavior', () => {
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = String(PG_TRGM_DEFAULT_THRESHOLD);
      expect(loadConfig().minSimilarity).toBe(0.3);
    });

    // A malformed value must fall back to the default rather than clamp.
    // Clamping `40` (a plausible "percent" typo) to 1.0 would match nothing
    // and silently kill the whole alias feature; falling back keeps the
    // shipped calibration.
    it.each(['', '   ', 'abc', 'NaN', '40', '-0.1', '1.5', 'Infinity'])(
      'falls back to the default on unusable value %p',
      (value) => {
        process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = value;
        expect(loadConfig().minSimilarity).toBe(DEFAULT_ALIAS_MIN_SIMILARITY);
      }
    );

    // The knob's whole purpose is a mid-incident backout. A typo that leaves
    // the shipped default silently in place reads to the operator as "the
    // floor wasn't the cause" — so every rejected override says so out loud.
    it.each(['abc', '40', '-0.1', '1.5'])('warns that the override %p was rejected', (value) => {
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = value;
      loadConfig();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('CATALOG_SEARCH_ALIAS_MIN_SIMILARITY');
      expect(warnSpy.mock.calls[0][0]).toContain('not a percentage');
    });

    it('warns that a below-pg_trgm-threshold override is a no-op', () => {
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.1';
      // Parsed and honored — it just cannot do anything, because `%` still
      // rejects everything under pg_trgm's own threshold.
      expect(loadConfig().minSimilarity).toBe(0.1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('no effect');
    });

    it('does not warn on a usable override', () => {
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.45';
      expect(loadConfig().minSimilarity).toBe(0.45);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('caches minSimilarity on the same singleton as enabled', () => {
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.5';
      expect(getConfig().minSimilarity).toBe(0.5);
      process.env.CATALOG_SEARCH_ALIAS_MIN_SIMILARITY = '0.9';
      expect(getConfig().minSimilarity).toBe(0.5);
      resetConfig();
      expect(getConfig().minSimilarity).toBe(0.9);
    });
  });

  describe('calibration guard — the default floor separates measured noise from measured signal', () => {
    it.each(MEASURED_FALSE_POSITIVES)(
      'excludes the $variant -> $query collision (similarity $similarity)',
      ({ similarity }) => {
        // pg_trgm's `%` lets these through today; the floor is what stops them.
        expect(similarity).toBeGreaterThanOrEqual(PG_TRGM_DEFAULT_THRESHOLD);
        expect(similarity).toBeLessThan(DEFAULT_ALIAS_MIN_SIMILARITY);
      }
    );

    it.each(MEASURED_TRUE_POSITIVES)(
      'still admits the $variant -> $query match (similarity $similarity)',
      ({ similarity }) => {
        expect(similarity).toBeGreaterThanOrEqual(DEFAULT_ALIAS_MIN_SIMILARITY);
      }
    );

    it("cannot be loosened below pg_trgm's own threshold in effect", () => {
      // Documenting an intentional asymmetry: the `%` predicate stays in the
      // query (it is what drives the GIN index), so setting the env var below
      // 0.30 cannot widen matching — pg_trgm still floors at its session
      // threshold. The knob can only tighten.
      expect(DEFAULT_ALIAS_MIN_SIMILARITY).toBeGreaterThanOrEqual(PG_TRGM_DEFAULT_THRESHOLD);
    });
  });
});
