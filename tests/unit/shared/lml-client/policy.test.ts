/**
 * Unit tests for the BS→LML caller classification policy layer (BS#1826).
 */
import {
  ALL_LML_CALLERS,
  LML_CALLER_POLICY,
  resolveLmlPolicy,
  _resetLmlPolicyForTest,
  type LmlCaller,
  type LmlCallerClass,
} from '@wxyc/lml-client';

describe('lml-client policy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetLmlPolicyForTest();
  });

  describe('ALL_LML_CALLERS / resolveLmlPolicy', () => {
    it('resolves every registered caller to exactly one class', () => {
      for (const caller of ALL_LML_CALLERS) {
        const policy = resolveLmlPolicy(caller);
        expect(policy.class).toBeGreaterThanOrEqual(1);
        expect(policy.class).toBeLessThanOrEqual(5);
        expect(Number.isInteger(policy.class)).toBe(true);
      }
    });

    it('exposes the same set of callers via LML_CALLER_POLICY as ALL_LML_CALLERS', () => {
      expect(Object.keys(LML_CALLER_POLICY).sort()).toEqual([...ALL_LML_CALLERS].sort());
    });

    it('every resolved policy carries a positive timeoutMs', () => {
      for (const caller of ALL_LML_CALLERS) {
        expect(resolveLmlPolicy(caller).timeoutMs).toBeGreaterThan(0);
      }
    });

    it('throws for an unregistered caller', () => {
      expect(() => resolveLmlPolicy('totally-not-registered' as LmlCaller)).toThrow(
        /unregistered LML caller "totally-not-registered"/
      );
    });

    it('the plan’s caller→class map is represented exactly (spot check every row)', () => {
      const expected: Record<LmlCaller, LmlCallerClass> = {
        'proxy-library-search': 1,
        'library-track-search': 2,
        'library-rotation-picker': 2,
        'proxy-album-metadata': 2,
        'library-enrich-artwork': 2,
        'artwork-discogs-fallback': 2,
        'request-line': 2,
        'library-add-album': 2,
        'library-update-album': 2,
        'flowsheet-linkage': 2,
        add_to_rotation: 3,
        proxy: 3,
        'library-canonical-entity': 2,
        'library-add-album-streaming': 4,
        'library-update-album-streaming': 4,
        'metadata-service': 5,
        'enrichment-worker': 5,
        'flowsheet-metadata-backfill': 5,
        'album-level-backfill': 5,
        'catalog-popularity-freetext-resolve': 5,
        'flowsheet-linked-reenrichment': 5,
        'flowsheet-artwork-repair': 5,
        'flowsheet-reenrichment': 5,
        'streaming-url-upgrade': 5,
        'apple-music-url-backfill': 5,
        'va-apple-music-url-remediation': 5,
        'concerts-genre-enrichment': 5,
        'concerts-artist-lml-resolver': 5,
        'rotation-release-id-backfill': 5,
        'flowsheet-no-match-recheck': 5,
        'library-discogs-unavailable-recheck': 5,
        'artwork-provenance-remediation': 5,
        'library-artwork-url-backfill': 5,
        'library-canonical-entity-backfill': 5,
      };
      for (const [caller, expectedClass] of Object.entries(expected) as [LmlCaller, LmlCallerClass][]) {
        expect(resolveLmlPolicy(caller).class).toBe(expectedClass);
      }
      // No unexpected extra callers snuck in.
      expect(ALL_LML_CALLERS.length).toBe(Object.keys(expected).length);
    });
  });

  describe('per-class defaults', () => {
    it('class 1 (protected local catalog search) defaults to 3 s, no budget header', () => {
      const policy = resolveLmlPolicy('proxy-library-search');
      expect(policy.timeoutMs).toBe(3000);
      expect(policy.budgetMs).toBeUndefined();
    });

    it('class 2 (interactive enrichment/lookup) defaults to 5 s timeout / 4 s budget', () => {
      const policy = resolveLmlPolicy('library-track-search');
      expect(policy.timeoutMs).toBe(5000);
      expect(policy.budgetMs).toBe(4000);
    });

    it('write-through library-canonical-entity resolves to class 2 (budget + short timeout), not budget-less class 3', () => {
      // BS#1826 review fix: a warm_cache write-through that can reach the
      // Discogs cascade via defaultLimiter must carry a soft budget, unlike
      // the budget-less class-3 PG-cached reads.
      const policy = resolveLmlPolicy('library-canonical-entity');
      expect(policy.class).toBe(2);
      expect(policy.timeoutMs).toBe(5000);
      expect(policy.budgetMs).toBe(4000);
    });

    it('class 3 "proxy" reads (getRelease/getArtistDetails/resolveEntity) also default to 8 s', () => {
      expect(resolveLmlPolicy('proxy').timeoutMs).toBe(8000);
    });

    it('class 4 (streaming availability checks) defaults to 5 s, no budget header', () => {
      const policy = resolveLmlPolicy('library-add-album-streaming');
      expect(policy.timeoutMs).toBe(5000);
      expect(policy.budgetMs).toBeUndefined();
      expect(resolveLmlPolicy('library-update-album-streaming').timeoutMs).toBe(5000);
    });

    it('class 5 (batch/backfill enrichment) defaults to 29 s timeout / 28 s budget', () => {
      const policy = resolveLmlPolicy('enrichment-worker');
      expect(policy.timeoutMs).toBe(29000);
      expect(policy.budgetMs).toBe(28000);
    });
  });

  describe('per-caller overrides', () => {
    it('library-rotation-picker overrides to the BS#992 10 s timeout / 9 s budget', () => {
      const policy = resolveLmlPolicy('library-rotation-picker');
      expect(policy.timeoutMs).toBe(10000);
      expect(policy.budgetMs).toBe(9000);
    });

    it('library-enrich-artwork overrides budgetMs to 2000 (the #1828 constant), timeoutMs stays class-2 default', () => {
      const policy = resolveLmlPolicy('library-enrich-artwork');
      expect(policy.budgetMs).toBe(2000);
      expect(policy.timeoutMs).toBe(5000);
    });

    it('library-enrich-artwork honors LIBRARY_SEARCH_LML_BUDGET_MS', () => {
      process.env.LIBRARY_SEARCH_LML_BUDGET_MS = '1500';
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy('library-enrich-artwork').budgetMs).toBe(1500);
    });

    it('add_to_rotation overrides timeoutMs to the identity default (2000), no budget header', () => {
      const policy = resolveLmlPolicy('add_to_rotation');
      expect(policy.timeoutMs).toBe(2000);
      expect(policy.budgetMs).toBeUndefined();
    });

    it('add_to_rotation honors LML_RESOLVE_TIMEOUT_MS (the pre-existing resolveIdentity lever)', () => {
      process.env.LML_RESOLVE_TIMEOUT_MS = '3500';
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy('add_to_rotation').timeoutMs).toBe(3500);
    });
  });

  describe('LML_CLASS{1..5}_TIMEOUT_MS / LML_CLASS2_BUDGET_MS env knobs', () => {
    it.each([
      ['LML_CLASS1_TIMEOUT_MS', 'proxy-library-search', 'timeoutMs', 9999],
      ['LML_CLASS2_TIMEOUT_MS', 'library-track-search', 'timeoutMs', 8888],
      // Below the class-2 default timeoutMs (5000) — BS#1842's budget-vs-timeout
      // sanitizer would otherwise null out a budget >= timeout as a misconfig.
      ['LML_CLASS2_BUDGET_MS', 'library-track-search', 'budgetMs', 4444],
      ['LML_CLASS3_TIMEOUT_MS', 'proxy', 'timeoutMs', 6666],
      ['LML_CLASS4_TIMEOUT_MS', 'library-add-album-streaming', 'timeoutMs', 5555],
      ['LML_CLASS5_TIMEOUT_MS', 'enrichment-worker', 'timeoutMs', 40000],
    ] as const)('%s overrides %s.%s to %d', (envName, caller, field, value) => {
      process.env[envName] = String(value);
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy(caller as LmlCaller)[field]).toBe(value);
    });

    it('class 5 budgetMs is derived as timeoutMs - 1000 when LML_CLASS5_TIMEOUT_MS is overridden', () => {
      process.env.LML_CLASS5_TIMEOUT_MS = '40000';
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy('enrichment-worker').budgetMs).toBe(39000);
    });

    it('an invalid env value falls back to the documented default (envInt contract)', () => {
      process.env.LML_CLASS1_TIMEOUT_MS = '-5';
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy('proxy-library-search').timeoutMs).toBe(3000);
    });
  });

  describe('budgetMs misconfig edges (BS#1842)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('class 5: a low LML_CLASS5_TIMEOUT_MS driving budgetMs <= 0 omits the budget header and warns', () => {
      process.env.LML_CLASS5_TIMEOUT_MS = '800'; // 800 - 1000 = -200
      _resetLmlPolicyForTest();
      const policy = resolveLmlPolicy('enrichment-worker');
      expect(policy.timeoutMs).toBe(800);
      expect(policy.budgetMs).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/budgetMs=-200 \(<= 0\)/));
    });

    it('class 5: budgetMs exactly 0 (LML_CLASS5_TIMEOUT_MS=1000) also omits the header', () => {
      process.env.LML_CLASS5_TIMEOUT_MS = '1000';
      _resetLmlPolicyForTest();
      const policy = resolveLmlPolicy('enrichment-worker');
      expect(policy.budgetMs).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/budgetMs=0 \(<= 0\)/));
    });

    it('class 2: LML_CLASS2_BUDGET_MS >= LML_CLASS2_TIMEOUT_MS omits the header and warns', () => {
      process.env.LML_CLASS2_TIMEOUT_MS = '5000';
      process.env.LML_CLASS2_BUDGET_MS = '5000';
      _resetLmlPolicyForTest();
      const policy = resolveLmlPolicy('library-track-search');
      expect(policy.timeoutMs).toBe(5000);
      expect(policy.budgetMs).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/budgetMs=5000 >= timeoutMs=5000/));
    });

    it('class 2: a well-formed budget < timeout passes through unchanged with no warning', () => {
      process.env.LML_CLASS2_TIMEOUT_MS = '5000';
      process.env.LML_CLASS2_BUDGET_MS = '3000';
      _resetLmlPolicyForTest();
      const policy = resolveLmlPolicy('library-track-search');
      expect(policy.budgetMs).toBe(3000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('a class-1/3/4 caller with no budgetMs at all is unaffected (undefined stays undefined, no warning)', () => {
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy('proxy-library-search').budgetMs).toBeUndefined();
      expect(resolveLmlPolicy('proxy').budgetMs).toBeUndefined();
      expect(resolveLmlPolicy('library-add-album-streaming').budgetMs).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('_resetLmlPolicyForTest', () => {
    it('rebuilds LML_CALLER_POLICY in place so a later resolveLmlPolicy call sees the new env', () => {
      const before = resolveLmlPolicy('library-track-search').timeoutMs;
      process.env.LML_CLASS2_TIMEOUT_MS = String(before + 1234);
      _resetLmlPolicyForTest();
      expect(resolveLmlPolicy('library-track-search').timeoutMs).toBe(before + 1234);
      // The exported binding itself didn't change identity (still a Record).
      expect(typeof LML_CALLER_POLICY).toBe('object');
    });
  });
});
