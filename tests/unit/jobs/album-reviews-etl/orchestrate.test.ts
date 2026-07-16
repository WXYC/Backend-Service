/**
 * Unit tests for the album-reviews-etl orchestrator. All dependencies
 * (sheet fetch, upsert, link pass) are injected fakes — no network, no
 * DB. The run guards live here (not in job.ts) precisely so these tests
 * can exercise them: zero valid rows, a majority-invalid sheet, and the
 * all-writes-failed regression all throw so cron monitoring can't stay
 * green through a wholesale drift. DRY_RUN skips every write and emits
 * the locked-schema JSON report line.
 */
import { runEtl, resolveDryRun, type RunOptions, type Totals } from '../../../../jobs/album-reviews-etl/orchestrate';
import type { UpsertOutcome } from '../../../../jobs/album-reviews-etl/writer';

const HEADERS = [
  'Timestamp',
  'Artist Name',
  'Album Name',
  'Record Label',
  'Please write your review here',
  'Name of reviewer, and date',
  'rotated? (y/n)',
];

const row = (
  timestamp: string,
  artist: string,
  album: string,
  review = 'Great record.',
  reviewer = 'DJ Ana'
): string[] => [timestamp, artist, album, 'Merge', review, reviewer, ''];

const validRows = [
  row('7/15/2021 14:05:33', 'Juana Molina', 'DOGA'),
  row('7/16/2021 09:00:00', 'Jessica Pratt', 'On Your Own Love Again'),
  row('7/17/2021 21:30:00', 'Stereolab', 'Dots and Loops'),
];

const junkRow = row('B1163=', '', ''); // formula residue, no artist/album

const makeOpts = (overrides: Partial<RunOptions> = {}): RunOptions & { upserts: string[]; linkCalls: number[] } => {
  const upserts: string[] = [];
  const linkCalls: number[] = [];
  const opts: RunOptions & { upserts: string[]; linkCalls: number[] } = {
    fetchRows: () => Promise.resolve([HEADERS, ...validRows]),
    upsertSubmission: (content) => {
      upserts.push(content.source_key ?? '<null>');
      return Promise.resolve<UpsertOutcome>({ inserted: true, updated: false, unchanged: false });
    },
    linkPass: () => {
      linkCalls.push(1);
      return Promise.resolve({ linked: 2, link_ambiguous: 1, link_unmatched: 3 });
    },
    upserts,
    linkCalls,
    ...overrides,
  };
  return opts;
};

describe('runEtl — counters', () => {
  it('counts fetched/valid/skipped_invalid and the upsert outcome split', async () => {
    let call = 0;
    const outcomes: UpsertOutcome[] = [
      { inserted: true, updated: false, unchanged: false },
      { inserted: false, updated: true, unchanged: false },
      { inserted: false, updated: false, unchanged: true },
    ];
    const opts = makeOpts({
      fetchRows: () => Promise.resolve([HEADERS, ...validRows, junkRow]),
      upsertSubmission: () => Promise.resolve(outcomes[call++]),
    });
    const totals = await runEtl(opts);

    expect(totals).toEqual<Totals>({
      fetched: 4,
      valid: 3,
      skipped_invalid: 1,
      fallback_keys: 0,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      linked: 2,
      link_ambiguous: 1,
      link_unmatched: 3,
    });
  });

  it('counts fallback keys (timestamp-less rows still ingest under nots:)', async () => {
    const opts = makeOpts({
      fetchRows: () => Promise.resolve([HEADERS, row('', 'Bianca Scout', 'The Heart of the Anchoress'), ...validRows]),
    });
    const totals = await runEtl(opts);

    expect(totals.fallback_keys).toBe(1);
    expect(totals.valid).toBe(4);
    expect(opts.upserts.some((k) => k.startsWith('nots:'))).toBe(true);
  });

  it('keys upserts on the form timestamp', async () => {
    const opts = makeOpts();
    await runEtl(opts);
    expect(opts.upserts).toContain('form:2021-07-15T18:05:33.000Z');
    expect(opts.upserts).toHaveLength(3);
  });

  it('counts a per-row upsert error in no outcome bucket and continues the run', async () => {
    let call = 0;
    const opts = makeOpts({
      upsertSubmission: () => {
        call += 1;
        if (call === 2) return Promise.reject(new Error('boom'));
        return Promise.resolve({ inserted: true, updated: false, unchanged: false });
      },
    });
    const totals = await runEtl(opts);

    expect(totals.valid).toBe(3);
    expect(totals.inserted).toBe(2);
    expect(totals.updated + totals.unchanged).toBe(0);
  });
});

describe('runEtl — run guards', () => {
  it('fails the run on an empty response (not even a header row)', async () => {
    await expect(runEtl(makeOpts({ fetchRows: () => Promise.resolve([]) }))).rejects.toThrow(/empty/i);
  });

  it('fails the run when a required header vanished (contract break, not a mappable state)', async () => {
    const beheaded = HEADERS.map((h) => (h === 'Artist Name' ? 'Renamed Column' : h));
    await expect(runEtl(makeOpts({ fetchRows: () => Promise.resolve([beheaded, ...validRows]) }))).rejects.toThrow(
      /header/i
    );
  });

  it('fails the run when zero valid rows mapped (a ~1.6k-row archive is never empty)', async () => {
    const opts = makeOpts({ fetchRows: () => Promise.resolve([HEADERS, junkRow, junkRow]) });
    await expect(runEtl(opts)).rejects.toThrow(/valid/i);
    // Guards fire BEFORE any write.
    expect(opts.upserts).toHaveLength(0);
    expect(opts.linkCalls).toHaveLength(0);
  });

  it('fails the run when more than half the fetched rows are invalid (wholesale sheet drift)', async () => {
    const opts = makeOpts({
      fetchRows: () => Promise.resolve([HEADERS, junkRow, junkRow, junkRow, ...validRows.slice(0, 2)]),
    });
    await expect(runEtl(opts)).rejects.toThrow(/invalid/i);
    expect(opts.upserts).toHaveLength(0);
  });

  it('passes at exactly 50% invalid (>50% is the guard, not >=)', async () => {
    const opts = makeOpts({
      fetchRows: () => Promise.resolve([HEADERS, junkRow, junkRow, ...validRows.slice(0, 2)]),
    });
    const totals = await runEtl(opts);
    expect(totals.skipped_invalid).toBe(2);
    expect(totals.inserted).toBe(2);
  });

  it('fails the run when valid rows exist but every write failed (wholesale write regression must not stay green)', async () => {
    const opts = makeOpts({ upsertSubmission: () => Promise.reject(new Error('permission denied')) });
    await expect(runEtl(opts)).rejects.toThrow(/0 written|zero writ/i);
  });
});

describe('runEtl — DRY_RUN', () => {
  it('skips upserts AND the link pass, emits the locked-schema JSON report line, and still reports mapping counters', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const opts = makeOpts({
        fetchRows: () =>
          Promise.resolve([HEADERS, ...validRows, junkRow, row('', 'Bianca Scout', 'The Heart of the Anchoress')]),
        dryRun: true,
      });
      const totals = await runEtl(opts);

      expect(opts.upserts).toHaveLength(0);
      expect(opts.linkCalls).toHaveLength(0);
      expect(totals).toMatchObject({
        fetched: 5,
        valid: 4,
        skipped_invalid: 1,
        fallback_keys: 1,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        linked: 0,
      });

      // The locked report schema (documented in the job README): exactly
      // these keys, one JSON line on stdout.
      const reportLine = stdoutSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes('"dry_run":true'));
      if (reportLine === undefined) throw new Error('no dry-run report line written to stdout');
      const report = JSON.parse(reportLine.trim());
      expect(report).toEqual({
        job: 'album-reviews-etl',
        dry_run: true,
        fetched: 5,
        valid: 4,
        skipped_invalid: 1,
        fallback_keys: 1,
        would_write: 4,
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
