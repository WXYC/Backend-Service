/**
 * BS#2000 in-band throttle detector.
 *
 * LML#904 measured ~56% of Apple probes nulling out on LML's own self-throttle
 * at the default rate ceiling. In that regime this job's `none` verdicts are
 * untrustworthy and would NULL correct links, so the run has to notice and
 * stop. The rescue rate — first-pass null, later-pass URL — is a direct
 * observation of that condition and costs nothing extra to collect.
 */

import {
  evaluateRescueRate,
  newRescueTracker,
  rescueRate,
  MAX_RESCUE_RATE_DEFAULT,
  MIN_RESCUE_SAMPLE_DEFAULT,
} from '../../../../jobs/va-apple-music-url-remediation/calibrate';

describe('rescueRate', () => {
  it('is 0 before anything is sampled (never NaN)', () => {
    expect(rescueRate(newRescueTracker())).toBe(0);
  });

  it('is rescued / first-pass nulls', () => {
    expect(rescueRate({ firstPassNulls: 100, rescued: 38 })).toBeCloseTo(0.38);
  });
});

describe('evaluateRescueRate', () => {
  it('does not judge an under-sampled run', () => {
    // A couple of unlucky early triples must not halt an otherwise healthy run;
    // the operational Sentry gate is the primary defense, this is the backstop.
    const verdict = evaluateRescueRate({ firstPassNulls: 5, rescued: 5 });
    expect(verdict.abort).toBe(false);
    expect(verdict.sample).toBe(5);
  });

  it('proceeds at or below the ceiling once sampled', () => {
    const tracker = { firstPassNulls: MIN_RESCUE_SAMPLE_DEFAULT, rescued: 5 };
    expect(rescueRate(tracker)).toBeCloseTo(0.1);
    expect(evaluateRescueRate(tracker).abort).toBe(false);
  });

  it('aborts above the ceiling', () => {
    const tracker = { firstPassNulls: 100, rescued: 38 };
    const verdict = evaluateRescueRate(tracker);
    expect(verdict.abort).toBe(true);
    expect(verdict.rate).toBeCloseTo(0.38);
    expect(verdict.reason).toMatch(/LML#904/);
  });

  it('models the LML#904 regime', () => {
    // At p≈0.56 the three-pass rescue rate p(1-p)(1+p) is ≈0.38 — well over
    // the 10% default. At a healthy p≈0.05 it is ≈0.05 — under it. The gate
    // must separate those two worlds, which is the whole point.
    const p = (x: number) => x * (1 - x) * (1 + x);
    const throttled = { firstPassNulls: 1000, rescued: Math.round(1000 * p(0.56)) };
    const healthy = { firstPassNulls: 1000, rescued: Math.round(1000 * p(0.05)) };
    expect(evaluateRescueRate(throttled).abort).toBe(true);
    expect(evaluateRescueRate(healthy).abort).toBe(false);
  });

  it('honors overridden thresholds', () => {
    const tracker = { firstPassNulls: 100, rescued: 15 };
    expect(evaluateRescueRate(tracker, { maxRate: 0.2 }).abort).toBe(false);
    expect(evaluateRescueRate(tracker, { maxRate: 0.1 }).abort).toBe(true);
    expect(evaluateRescueRate(tracker, { minSample: 1000 }).abort).toBe(false);
  });

  it('ships a default ceiling that separates the two regimes', () => {
    expect(MAX_RESCUE_RATE_DEFAULT).toBeGreaterThan(0.05 * (1 - 0.05) * (1 + 0.05));
    expect(MAX_RESCUE_RATE_DEFAULT).toBeLessThan(0.56 * (1 - 0.56) * (1 + 0.56));
  });
});
