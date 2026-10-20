/**
 * Pins the totals counters (BS#3393 B4d, replacing the BS#1563 totals span): every totals bucket,
 * including `enrich_error` (the corruption tell the #1560 wedge needed), is emitted as a
 * `flowsheet-metadata-backfill.<bucket>` `logCounter` line carrying a number, even when zero.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';

jest.mock('@sentry/node', () => ({
  setTag: jest.fn(),
  init: jest.fn(),
  captureException: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { runBackfill, type EnrichFn, type LookupFn } from '../../../../jobs/flowsheet-metadata-backfill/orchestrate';
import type { LookupResponse } from '@wxyc/lml-client';

const TOTALS_KEYS = [
  'scanned',
  'enriched_match',
  'enriched_match_raced',
  'enriched_no_match',
  'enriched_no_match_raced',
  'lml_error',
  'enrich_error',
  // BS#1591: the deliberate below-floor residual (so pending-cohort
  // dashboards can subtract it), the vanished-mid-run count (deletes /
  // out-of-band marker stamps), and the two worker-lifecycle buckets
  // (reconciled = true worker overlap; inflight = claims left untouched;
  // both dormant fail-safes since BS#895 — see orchestrate.ts).
  'below_floor_skipped',
  'stale_skipped',
  'worker_reconciled',
  'worker_inflight_skipped',
  // BS#895 review follow-up (finding #4): rows the recovery-window ceiling
  // has permanently excluded from the sweep.
  'stranded_past_recovery_window',
  // BS#895 / epic #1810 W4: rotation self-heal's OWN counters (review
  // finding #5b — deliberately separate from the shared buckets above so a
  // self-heal catch-up burst can't silently inflate the main sweep's "< 100
  // rows median" dashboard signal).
  'self_heal_candidates',
  'self_heal_skipped',
  'self_heal_scanned',
  'self_heal_resolved',
  'self_heal_no_match',
  'self_heal_lml_error',
  'self_heal_enrich_error',
  // BS#1995 Arm 3: the refusal-to-write bucket for a breaker-open LML
  // response (`degraded_reason: 'upstream_unavailable'`) — see enrich.ts —
  // and its self-heal-pass twin.
  'upstream_unavailable_skipped',
  'self_heal_upstream_unavailable_skipped',
  // BS#1995 Arm 2: breaker-gate activity this run.
  'breaker_probes',
  'breaker_pauses',
];

const matchedResponse: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { release_id: 100, release_url: 'x' } }],
  search_type: 'direct',
};

const counterLines = (spy: jest.SpiedFunction<typeof console.log>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [line] of spy.mock.calls) {
    try {
      const parsed = JSON.parse(String(line)) as { metric?: string; value?: unknown };
      if (parsed.metric) {
        out[parsed.metric] = parsed.value;
      }
    } catch {
      // not a JSON log line
    }
  }
  return out;
};

// One-row run through the default (real) work-list builder: pending-count,
// then the work-list, then the single batch slice — exercising the BS#1591
// wiring end-to-end. The live-activity probe defaults to false in the db
// mock, so the run reaches the `finished` point where the totals counters fire.
const runOneRow = () => {
  (db.execute as jest.Mock)
    .mockResolvedValueOnce([{ pending_total: 1 }] as never)
    .mockResolvedValueOnce([{ id: 1, plays: 42 }] as never)
    .mockResolvedValueOnce([
      {
        id: 1,
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        album_id: null,
        metadata_status: 'pending',
      },
    ] as never);
  const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
  const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');
  return runBackfill({
    lookup,
    enrich,
    throttleMs: 0,
    liveActivityLookbackSeconds: 0,
    // BS#1995 Arm 2: disable the breaker-gate probe — this test isn't
    // about it, and skipping it keeps the run from touching the real
    // `fetch` default.
    breakerProbeIntervalMs: 0,
    playFloor: 5,
    floorRecencyDays: 7,
  });
};

describe('flowsheet-metadata-backfill totals counters (BS#3393)', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    (db.execute as jest.Mock).mockReset();
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits every totals bucket, including enrich_error, as a numeric counter', async () => {
    await runOneRow();

    const counters = counterLines(logSpy);
    expect(counters['flowsheet-metadata-backfill.scanned']).toBe(1);
    expect(counters['flowsheet-metadata-backfill.enriched_match']).toBe(1);
    expect(counters['flowsheet-metadata-backfill.enrich_error']).toBe(0);
    for (const key of TOTALS_KEYS) {
      expect(typeof counters[`flowsheet-metadata-backfill.${key}`]).toBe('number');
    }
  });
});
