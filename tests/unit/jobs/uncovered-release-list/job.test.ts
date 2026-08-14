/**
 * Unit tests for jobs/uncovered-release-list job.ts (BS#1877, the "widen the
 * candidate set" amendment) — the option parsing that selects the job's
 * mode.
 *
 * `uncoveredJobOptions` maps the `--backfill` argv flag and the two new env
 * knobs (`UNCOVERED_PLAY_LOOKBACK_DAYS`, `UNCOVERED_MAX_RELEASES_PER_RUN`)
 * to the options `runJob` acts on. It is the one operator-facing seam for
 * this job's mode — pinning it keeps that seam honest without a DB or
 * network. Donor: `tests/unit/jobs/concerts-poster-enrichment/job.test.ts`,
 * whose header states the "one operator-facing seam" rationale this mirrors.
 * Deliberately does NOT test a `dryRun` field — this job has none;
 * `resolveDryRun` (orchestrate.ts) is the sole DRY_RUN switch.
 *
 * `@wxyc/database` is auto-mocked by the unit jest config's moduleNameMapper
 * (its `requirePositiveInt` re-exports the real validator), and importing
 * job.ts is inert under jest because NODE_ENV==='test' gates the
 * `void main()` auto-invoke.
 */
import {
  uncoveredJobOptions,
  PLAY_LOOKBACK_DAYS_DEFAULT,
  PLAY_LOOKBACK_DAYS_ENV,
  MAX_RELEASES_PER_RUN_DEFAULT,
  MAX_RELEASES_PER_RUN_ENV,
} from '../../../../jobs/uncovered-release-list/job';

const argv = (...flags: string[]): string[] => ['node', 'job.js', ...flags];

describe('uncoveredJobOptions (BS#1877)', () => {
  it('defaults to non-backfill with the documented lookback + cap', () => {
    const opts = uncoveredJobOptions({}, argv());

    expect(opts).toEqual({
      backfill: false,
      playLookbackDays: PLAY_LOOKBACK_DAYS_DEFAULT,
      maxReleasesPerRun: MAX_RELEASES_PER_RUN_DEFAULT,
    });
  });

  it('sets backfill only for the --backfill flag', () => {
    expect(uncoveredJobOptions({}, argv('--backfill')).backfill).toBe(true);
    expect(uncoveredJobOptions({}, argv()).backfill).toBe(false);
    // A near-miss flag must NOT enable backfill.
    expect(uncoveredJobOptions({}, argv('--backfil')).backfill).toBe(false);
  });

  it('carries no dryRun field — DRY_RUN stays env-resolved via resolveDryRun', () => {
    const opts = uncoveredJobOptions({}, argv());
    expect(opts).not.toHaveProperty('dryRun');
  });

  it('reads the play-lookback env override and rejects a non-positive value', () => {
    expect(uncoveredJobOptions({ [PLAY_LOOKBACK_DAYS_ENV]: '14' }, argv()).playLookbackDays).toBe(14);
    expect(() => uncoveredJobOptions({ [PLAY_LOOKBACK_DAYS_ENV]: '0' }, argv())).toThrow(PLAY_LOOKBACK_DAYS_ENV);
    expect(() => uncoveredJobOptions({ [PLAY_LOOKBACK_DAYS_ENV]: '2weeks' }, argv())).toThrow(PLAY_LOOKBACK_DAYS_ENV);
  });

  it('reads the max-releases-per-run env override and rejects a non-positive value', () => {
    expect(uncoveredJobOptions({ [MAX_RELEASES_PER_RUN_ENV]: '2000' }, argv()).maxReleasesPerRun).toBe(2000);
    expect(() => uncoveredJobOptions({ [MAX_RELEASES_PER_RUN_ENV]: '-1' }, argv())).toThrow(MAX_RELEASES_PER_RUN_ENV);
  });

  it('honors an operator raising the cap for a --backfill invocation', () => {
    const opts = uncoveredJobOptions({ [MAX_RELEASES_PER_RUN_ENV]: '2000' }, argv('--backfill'));
    expect(opts).toEqual({ backfill: true, playLookbackDays: PLAY_LOOKBACK_DAYS_DEFAULT, maxReleasesPerRun: 2000 });
  });
});
