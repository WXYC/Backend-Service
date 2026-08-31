/**
 * Pins the Sentry-capture / log-warning gating for two BS#2281 review
 * findings that live in `runScrub`'s control flow rather than the pure
 * decision core: the `shows.legacy_dj_name` pre-flight (finding 3) and the
 * write-side PII guard (finding 2). Separate file so `jest.mock` of the
 * logger module can't leak into the main `run-scrub.test.ts` suite (which
 * relies on the real no-op logger, exactly like every OTHER injectable-seam
 * test in this job) — same isolation pattern as
 * jobs/concerts-poster-enrichment/orchestrate.capture.test.ts.
 */
import {
  runScrub,
  __resetStopForTesting,
  type ScrubRow,
  type MessageRow,
  type DjNameFix,
  type MessageFix,
} from '../../../../jobs/flowsheet-dj-name-scrub/orchestrate';
import { captureError, log } from '../../../../jobs/flowsheet-dj-name-scrub/logger';

jest.mock('../../../../jobs/flowsheet-dj-name-scrub/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
  errorMessage: (error: unknown): string => (error instanceof Error ? error.message : JSON.stringify(error)),
}));

const mockedLog = log as jest.MockedFunction<typeof log>;
const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

/** Only DJ with no handle at all, so their real name is what leaks. */
const ROSTER = [{ realName: 'A. Hearst', djName: null }];

const makeRow = (overrides: Partial<ScrubRow> = {}): ScrubRow => ({
  id: 1,
  entry_type: 'track',
  dj_name: 'stale handle',
  message: null,
  show_id: 500,
  dj_name_override: null,
  legacy_dj_name: null,
  primary_dj_id: 'user-1',
  user_found: true,
  user_dj_name: 'zorp',
  ...overrides,
});

const pager = <T>(pages: T[][]) => {
  let call = 0;
  return jest.fn(() => Promise.resolve(pages[call++] ?? []));
};

const baseOpts = () => ({
  dryRun: true,
  batchSize: 100,
  mainAfterId: 0,
  messageAfterId: 0,
  orphanAfterId: 0,
  liveActivityLookbackSeconds: 0,
  loadUsers: jest.fn(() => Promise.resolve(ROSTER)),
  loadShowsLegacyDjNames: jest.fn(() => Promise.resolve([])),
  loadPreflightRows: jest.fn(() => Promise.resolve([])),
  loadMainPage: pager<ScrubRow>([]),
  loadMessagePage: pager<MessageRow>([]),
  loadOrphanPage: pager<ScrubRow>([]),
  applyDjNameBatch: jest.fn((fixes: DjNameFix[]) => Promise.resolve(fixes.length)),
  applyMessageBatch: jest.fn((fixes: MessageFix[]) => Promise.resolve(fixes.length)),
  analyzeFlowsheet: jest.fn(() => Promise.resolve()),
  verifyScrub: jest.fn(() => Promise.resolve(0)),
});

const warnStepCalls = (step: string) => mockedLog.mock.calls.filter(([level, s]) => level === 'warn' && s === step);
const captureStepCalls = (step: string) => mockedCaptureError.mock.calls.filter(([, s]) => s === step);

beforeEach(() => {
  __resetStopForTesting();
  jest.clearAllMocks();
});

describe('finding 2 — recomputed_is_roster_real_name is a loud warning, not a hard failure', () => {
  it('warns and captures, but does NOT fail the run, when a recompute lands on a roster real name', async () => {
    const opts = baseOpts();
    // dj_name_override wins the recompute chain (BS#1321); here it holds the
    // real name, so what this job would WRITE is itself PII.
    opts.loadMainPage = pager([[makeRow({ id: 7, dj_name_override: 'A. Hearst' })]]);

    const result = await runScrub(opts);

    expect(result.main.by_change_class.recomputed_is_roster_real_name).toBe(1);
    expect(result.failed).toBe(false);
    expect(warnStepCalls('recomputed_pii_detected')).toHaveLength(1);
    expect(captureStepCalls('recomputed_pii_detected')).toHaveLength(1);
  });

  it('stays silent when the only PII involved is being REMOVED, not written', async () => {
    const opts = baseOpts();
    // Stored value is the real name; the recompute (the linked user's handle)
    // is clean — this is stored_is_roster_real_name, a different class.
    opts.loadMainPage = pager([[makeRow({ id: 8, dj_name: 'A. Hearst', user_dj_name: 'zorp' })]]);

    const result = await runScrub(opts);

    expect(result.main.by_change_class.stored_is_roster_real_name).toBe(1);
    expect(warnStepCalls('recomputed_pii_detected')).toHaveLength(0);
    expect(captureStepCalls('recomputed_pii_detected')).toHaveLength(0);
  });

  it('fires in dry-run too — an operator must see this before anyone asks for --execute', async () => {
    const opts = baseOpts();
    opts.dryRun = true;
    opts.loadMainPage = pager([[makeRow({ id: 9, dj_name_override: 'A. Hearst' })]]);

    await runScrub(opts);

    expect(warnStepCalls('recomputed_pii_detected')).toHaveLength(1);
  });
});

describe('finding 3 — shows.legacy_dj_name pre-flight', () => {
  /**
   * A polluted show is REPORTED; only a row the pass would actually rewrite to
   * a real name WARNS. Measured on production 2026-08-30: 392 polluted shows,
   * 14,663 of their rows in scope, and 82 actual writes — the other 14,581 are
   * `already_current` skips, because migration 0053 froze `flowsheet.dj_name`
   * from the very `legacy_dj_name` the recompute returns.
   */
  it('reports a polluted show but stays SILENT when the pass would rewrite nothing', async () => {
    const opts = baseOpts();
    opts.loadShowsLegacyDjNames = jest.fn(() =>
      Promise.resolve([{ id: 1, legacy_dj_name: 'A. Hearst', dj_name_override: null }])
    );
    // The show's rows already hold the value the chain resolves — the pass
    // skips every one of them, so there is nothing to warn about.
    opts.loadPreflightRows = jest.fn(() =>
      Promise.resolve([
        {
          entry_type: 'track' as const,
          legacy_show_id: 999999,
          dj_name: 'A. Hearst',
          dj_name_override: null,
          legacy_dj_name: 'A. Hearst',
          primary_dj_id: null,
          user_found: false,
          user_dj_name: null,
        },
      ])
    );

    const result = await runScrub(opts);

    expect(result.legacyDjNamePiiCount).toBe(1);
    expect(result.harmCandidateShowCount).toBe(1);
    expect(result.harmfulRecomputeCount).toBe(0);
    expect(warnStepCalls('harmful_recompute_detected')).toHaveLength(0);
    expect(captureStepCalls('harmful_recompute_detected')).toHaveLength(0);
  });

  it('warns and captures when the pass WOULD rewrite a row to a roster real name', async () => {
    const opts = baseOpts();
    opts.loadShowsLegacyDjNames = jest.fn(() =>
      Promise.resolve([{ id: 1, legacy_dj_name: 'A. Hearst', dj_name_override: null }])
    );
    // Stored value disagrees with the chain, so this row really would change.
    opts.loadPreflightRows = jest.fn(() =>
      Promise.resolve([
        {
          entry_type: 'track' as const,
          legacy_show_id: 999999,
          dj_name: 'some other name',
          dj_name_override: null,
          legacy_dj_name: 'A. Hearst',
          primary_dj_id: null,
          user_found: false,
          user_dj_name: null,
        },
      ])
    );

    const result = await runScrub(opts);

    expect(result.harmfulRecomputeCount).toBe(1);
    expect(warnStepCalls('harmful_recompute_detected')).toHaveLength(1);
    expect(captureStepCalls('harmful_recompute_detected')).toHaveLength(1);
  });

  it('runs before the first pass, in dry-run mode too', async () => {
    const opts = baseOpts();
    opts.dryRun = true;
    opts.loadShowsLegacyDjNames = jest.fn(() =>
      Promise.resolve([{ id: 1, legacy_dj_name: 'A. Hearst', dj_name_override: null }])
    );

    await runScrub(opts);

    expect(opts.loadShowsLegacyDjNames).toHaveBeenCalledTimes(1);
  });

  it('stays silent, and reports zero, when no legacy_dj_name is polluted', async () => {
    const opts = baseOpts();
    opts.loadShowsLegacyDjNames = jest.fn(() =>
      Promise.resolve([{ id: 1, legacy_dj_name: 'genuine legacy handle', dj_name_override: null }])
    );

    const result = await runScrub(opts);

    expect(result.legacyDjNamePiiCount).toBe(0);
    expect(warnStepCalls('harmful_recompute_detected')).toHaveLength(0);
  });

  it('fails the run, before any pass starts, when the pre-flight query itself throws', async () => {
    const opts = baseOpts();
    opts.loadShowsLegacyDjNames = jest.fn(() => Promise.reject(new Error('connection reset')));

    const result = await runScrub(opts);

    expect(result.failed).toBe(true);
    expect(opts.loadMainPage).not.toHaveBeenCalled();
  });

  it('surfaces the count on the RunResult even when the run also finds nothing to write', async () => {
    const opts = baseOpts();
    opts.loadShowsLegacyDjNames = jest.fn(() =>
      Promise.resolve([
        { id: 1, legacy_dj_name: 'A. Hearst', dj_name_override: null },
        { id: 2, legacy_dj_name: 'A. Hearst', dj_name_override: null },
        { id: 3, legacy_dj_name: 'genuine legacy handle', dj_name_override: null },
      ])
    );

    const result = await runScrub(opts);

    expect(result.legacyDjNamePiiCount).toBe(2);
  });
});
