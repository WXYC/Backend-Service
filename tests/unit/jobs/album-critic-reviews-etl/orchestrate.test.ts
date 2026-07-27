/**
 * Unit tests for the album-critic-reviews-etl orchestrator (BS#1830). All
 * dependencies (manifest fetch, match, anti-join, extract, upsert) are
 * injected fakes — no network, no DB, no Anthropic SDK. The run guards live
 * here so these tests can exercise them directly: zero-parsed,
 * zero-matched, and the all-new-items-but-zero-written regression all
 * throw so cron monitoring can't stay green through a wholesale drift.
 * DRY_RUN skips extraction and every write, emitting a locked-schema JSON
 * report line.
 */
import {
  runEtl,
  resolveDryRun,
  type RunOptions,
  type Totals,
} from '../../../../jobs/album-critic-reviews-etl/orchestrate';
import type { CorpusItem } from '../../../../jobs/album-critic-reviews-etl/manifest';
import type { Extraction } from '../../../../jobs/album-critic-reviews-etl/extract';
import type { UpsertOutcome } from '../../../../jobs/album-critic-reviews-etl/writer';
import { initLogger, closeLogger } from '../../../../jobs/album-critic-reviews-etl/logger';

// log() is a no-op until initLogger() runs (it gates on module-level
// baseTags) — needed so the nothing_new-line assertion below actually has
// something to observe on stdout.
beforeAll(() => {
  initLogger({ repo: 'Backend-Service', tool: 'album-critic-reviews-etl-test' });
});

afterAll(async () => {
  await closeLogger();
});

const manifestLine = (overrides: Partial<CorpusItem> = {}): string =>
  JSON.stringify({
    artist: 'Jessica Pratt',
    album: 'On Your Own Love Again',
    source: 'The Quietus',
    sourceUrl: `https://example.com/${Math.random()}`,
    articleText: 'A hazy, intimate record.',
    ...overrides,
  });

const buildManifest = (items: Array<Partial<CorpusItem>>): string => items.map((i) => manifestLine(i)).join('\n');

const cleanExtraction = (): Extraction => ({
  isReview: true,
  snippet: 'A remarkable record.',
  author: null,
  rating: null,
});

type TestOpts = RunOptions & {
  extractCalls: CorpusItem[];
  upsertCalls: unknown[];
};

const makeOpts = (overrides: Partial<RunOptions> = {}): TestOpts => {
  const extractCalls: CorpusItem[] = [];
  const upsertCalls: unknown[] = [];
  const opts: TestOpts = {
    fetchManifest: () => Promise.resolve(buildManifest([{}])),
    matchItem: () => Promise.resolve(1),
    loadExistingPairs: () => Promise.resolve(new Set<string>()),
    extract: (item) => {
      extractCalls.push(item);
      return Promise.resolve(cleanExtraction());
    },
    upsertRow: (row) => {
      upsertCalls.push(row);
      return Promise.resolve<UpsertOutcome>({ inserted: true, updated: false, unchanged: false });
    },
    extractCalls,
    upsertCalls,
    ...overrides,
  };
  return opts;
};

describe('runEtl — run guards', () => {
  it('throws when the manifest is empty (zero parsed lines)', async () => {
    const opts = makeOpts({ fetchManifest: () => Promise.resolve('') });
    await expect(runEtl(opts)).rejects.toThrow(/parsed/i);
  });

  it('throws when the manifest is entirely malformed (zero parsed lines)', async () => {
    const opts = makeOpts({ fetchManifest: () => Promise.resolve('not json\nalso not json') });
    await expect(runEtl(opts)).rejects.toThrow(/parsed/i);
  });

  it('throws when zero items matched an album (resolver regression or stale corpus)', async () => {
    const opts = makeOpts({ matchItem: () => Promise.resolve(null) });
    await expect(runEtl(opts)).rejects.toThrow(/matched/i);
  });

  it('the zero-matched guard fires even in DRY_RUN', async () => {
    const opts = makeOpts({ matchItem: () => Promise.resolve(null), dryRun: true });
    await expect(runEtl(opts)).rejects.toThrow(/matched/i);
  });

  it('throws when new items existed but zero were written (extraction/write regression)', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{}, {}])),
      extract: () => Promise.resolve({ isReview: false, snippet: '', author: null, rating: null }),
    });
    await expect(runEtl(opts)).rejects.toThrow(/written/i);
  });
});

describe('runEtl — counters', () => {
  it('counts parsed/invalid and matched (post-dedup — two items resolving to the SAME album collapse to one)', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{}, {}]) + '\nnot json'),
    });
    const totals: Totals = await runEtl(opts);
    expect(totals.parsed).toBe(2);
    expect(totals.invalid).toBe(1);
    expect(totals.matched).toBe(1); // both items resolve to the default matchItem's albumId=1
  });

  it('dedups multiple matched reviews for the same album to one, tallied by winning source', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ source: 'Paste' }, { source: 'The Quietus' }])),
    });
    const totals = await runEtl(opts);
    expect(totals.matched).toBe(1);
    expect(totals.matched_by_source).toEqual({ 'The Quietus': 1 });
    expect(opts.upsertCalls).toHaveLength(1);
  });

  it('anti-join skips items already present, counted in already_present, with zero extract calls for them', async () => {
    const existingSourceUrl = 'https://example.com/existing';
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: existingSourceUrl }])),
      loadExistingPairs: () => Promise.resolve(new Set([`1:${existingSourceUrl}`])),
    });
    const totals = await runEtl(opts);
    expect(totals.already_present).toBe(1);
    expect(totals.would_extract).toBe(0);
    expect(opts.extractCalls).toHaveLength(0);
    expect(opts.upsertCalls).toHaveLength(0);
  });

  it('counts rejected items (buildRow-equivalent extraction returning isReview:false) without throwing, when at least one item writes', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: 'https://a/1' }, { sourceUrl: 'https://a/2' }])),
      // Distinct albumIds per item so dedup doesn't collapse them into one
      // (a shared albumId would mean only ONE of the two ever reaches
      // extraction).
      matchItem: (item) => Promise.resolve(item.sourceUrl.endsWith('/1') ? 1 : 2),
      extract: jest
        .fn()
        .mockResolvedValueOnce({ isReview: false, snippet: '', author: null, rating: null })
        .mockResolvedValueOnce(cleanExtraction()),
    });
    const totals = await runEtl(opts);
    expect(totals.rejected).toBe(1);
    expect(totals.written).toBe(1);
  });

  it('isolates a per-item extraction error: counted as llm_errors, does not wedge the run', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: 'https://a/1' }, { sourceUrl: 'https://a/2' }])),
      matchItem: (item) => Promise.resolve(item.sourceUrl.endsWith('/1') ? 1 : 2),
      extract: jest.fn().mockRejectedValueOnce(new Error('model timeout')).mockResolvedValueOnce(cleanExtraction()),
    });
    const totals = await runEtl(opts);
    expect(totals.llm_errors).toBe(1);
    expect(totals.written).toBe(1);
  });

  it('isolates a per-item write error: counted as write_errors, does not wedge the run', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: 'https://a/1' }, { sourceUrl: 'https://a/2' }])),
      matchItem: (item) => Promise.resolve(item.sourceUrl.endsWith('/1') ? 1 : 2),
      upsertRow: jest
        .fn()
        .mockRejectedValueOnce(new Error('value too long for type character varying(32)'))
        .mockResolvedValueOnce({ inserted: true, updated: false, unchanged: false }),
    });
    const totals = await runEtl(opts);
    expect(totals.write_errors).toBe(1);
    expect(totals.written).toBe(1);
    // The extract-then-write loop reached both items despite the first throwing.
    expect(opts.extractCalls).toHaveLength(2);
  });

  it('throws when new items existed but every write failed (write_errors -> zero written)', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: 'https://a/1' }, { sourceUrl: 'https://a/2' }])),
      matchItem: (item) => Promise.resolve(item.sourceUrl.endsWith('/1') ? 1 : 2),
      upsertRow: () => Promise.reject(new Error('db down')),
    });
    await expect(runEtl(opts)).rejects.toThrow(/written/i);
  });

  it('reports inserted/updated/unchanged from the writer outcome', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: 'https://a/1' }])),
      upsertRow: () => Promise.resolve<UpsertOutcome>({ inserted: false, updated: false, unchanged: true }),
    });
    const totals = await runEtl(opts);
    expect(totals.unchanged).toBe(1);
    expect(totals.inserted).toBe(0);
    expect(totals.written).toBe(1); // written = inserted + updated + unchanged
  });

  it('END-TO-END unranked-source recall: an album whose sole matched review is from an unranked source is written', async () => {
    const opts = makeOpts({
      fetchManifest: () => Promise.resolve(buildManifest([{ source: 'Some Brand New Zine Nobody Ranked' }])),
    });
    const totals = await runEtl(opts);
    expect(totals.matched).toBe(1);
    expect(totals.written).toBe(1);
    expect(opts.upsertCalls).toHaveLength(1);
  });
});

describe('runEtl — nothing-new steady state', () => {
  it('logs a distinct nothing_new step and makes zero extract/upsert calls when everything is already present', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const sourceUrl = 'https://example.com/already-there';
      const opts = makeOpts({
        fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl }])),
        loadExistingPairs: () => Promise.resolve(new Set([`1:${sourceUrl}`])),
      });
      const totals = await runEtl(opts);
      expect(totals.written).toBe(0);
      expect(opts.extractCalls).toHaveLength(0);
      expect(opts.upsertCalls).toHaveLength(0);

      const lines = stdoutSpy.mock.calls.map((c) => String(c[0]));
      const nothingNewLine = lines.find((line) => line.includes('"step":"nothing_new"'));
      expect(nothingNewLine).toBeDefined();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('runEtl — DRY_RUN', () => {
  it('skips extract AND upsert, emits the locked-schema JSON report line, and still reports matching counters', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const opts = makeOpts({
        fetchManifest: () => Promise.resolve(buildManifest([{ sourceUrl: 'https://a/1' }]) + '\nnot json'),
        dryRun: true,
      });
      const totals = await runEtl(opts);

      expect(opts.extractCalls).toHaveLength(0);
      expect(opts.upsertCalls).toHaveLength(0);
      expect(totals).toMatchObject({
        parsed: 1,
        invalid: 1,
        matched: 1,
        already_present: 0,
        would_extract: 1,
        extracted: 0,
        written: 0,
      });

      // Distinguish the locked report line from the "started"/"finished" log
      // lines (which also carry `"dry_run":true`) by its unique
      // `would_extract` key.
      const reportLine = stdoutSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes('"would_extract"'));
      if (reportLine === undefined) throw new Error('no dry-run report line written to stdout');
      const report = JSON.parse(reportLine.trim());
      expect(report).toEqual({
        job: 'album-critic-reviews-etl',
        dry_run: true,
        fetched: 2,
        parsed: 1,
        invalid: 1,
        matched: 1,
        matched_by_source: { 'The Quietus': 1 },
        already_present: 0,
        would_extract: 1,
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('resolveDryRun', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, false],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['yes', false],
  ])('resolves %p -> %p (locked truthy set: true|1, case-insensitive)', (raw, expected) => {
    expect(resolveDryRun(raw)).toBe(expected);
  });
});
