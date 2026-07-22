/**
 * Unit tests for jobs/concerts-poster-enrichment job.ts (BS#1743) — the option
 * parsing that selects the job's mode.
 *
 * `enrichJobOptions` maps argv flags (`--backfill`, `--dry-run`) and env knobs
 * (`CONCERTS_POSTER_ENRICH_PAGE_SIZE`, `LIVE_ACTIVITY_LOOKBACK_SECONDS`) to the
 * options `runJob` acts on. It is the one operator-facing seam: a typo here
 * (e.g. `--dryrun` never matching) would silently turn a `--dry-run` preview
 * into real LML fetches + poster writes, or run the one-time `--backfill` in
 * nightly-only mode. Pinning it keeps that seam honest without a DB or network.
 *
 * `@wxyc/database` is auto-mocked by the unit jest config's moduleNameMapper
 * (its `requirePositiveInt`/`requireNonNegativeInt` re-export the real
 * validators), and importing job.ts is inert under jest because NODE_ENV==='test'
 * gates the `void main()` auto-invoke.
 */
import {
  enrichJobOptions,
  LIVE_ACTIVITY_LOOKBACK_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_ENV,
} from '../../../../jobs/concerts-poster-enrichment/job';

const argv = (...flags: string[]): string[] => ['node', 'job.js', ...flags];

describe('enrichJobOptions (BS#1743)', () => {
  it('defaults to a nightly, non-dry run with the documented page size + probe window', () => {
    const opts = enrichJobOptions({}, argv());

    expect(opts).toEqual({
      pageSize: PAGE_SIZE_DEFAULT,
      liveActivityLookbackSeconds: LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
      backfill: false,
      dryRun: false,
    });
  });

  it('sets backfill only for the --backfill flag', () => {
    expect(enrichJobOptions({}, argv('--backfill')).backfill).toBe(true);
    expect(enrichJobOptions({}, argv()).backfill).toBe(false);
    // A near-miss flag must NOT enable backfill (the whole point of pinning this).
    expect(enrichJobOptions({}, argv('--backfil')).backfill).toBe(false);
  });

  it('sets dryRun only for the --dry-run flag', () => {
    expect(enrichJobOptions({}, argv('--dry-run')).dryRun).toBe(true);
    expect(enrichJobOptions({}, argv()).dryRun).toBe(false);
    // A near-miss flag must NOT enable dry-run, or a "preview" would write for real.
    expect(enrichJobOptions({}, argv('--dryrun')).dryRun).toBe(false);
  });

  it('honors both flags together (a dry-run backfill preview)', () => {
    const opts = enrichJobOptions({}, argv('--backfill', '--dry-run'));
    expect(opts.backfill).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it('reads the page-size env override and rejects a non-positive value', () => {
    expect(enrichJobOptions({ [PAGE_SIZE_ENV]: '25' }, argv()).pageSize).toBe(25);
    expect(() => enrichJobOptions({ [PAGE_SIZE_ENV]: '0' }, argv())).toThrow(PAGE_SIZE_ENV);
    expect(() => enrichJobOptions({ [PAGE_SIZE_ENV]: '20banana' }, argv())).toThrow(PAGE_SIZE_ENV);
  });

  it('allows LIVE_ACTIVITY_LOOKBACK_SECONDS=0 to disable the cooperative-pause probe', () => {
    expect(enrichJobOptions({ [LIVE_ACTIVITY_LOOKBACK_ENV]: '0' }, argv()).liveActivityLookbackSeconds).toBe(0);
    expect(enrichJobOptions({ [LIVE_ACTIVITY_LOOKBACK_ENV]: '120' }, argv()).liveActivityLookbackSeconds).toBe(120);
  });
});
