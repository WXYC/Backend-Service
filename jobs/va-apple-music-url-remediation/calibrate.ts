/**
 * In-band throttle-noise detector for the BS#2000 remediation.
 *
 * THE PROBLEM. LML#904 measured that at the default
 * `LML_APPLE_MUSIC_RATE_PER_MIN=60` (1 req/s) roughly **56% of
 * `find_track_url` probes time out** at the 4s ceiling and return null — with
 * zero 429s, because the wait is LML's own acquire-time, not Apple's (the raw
 * GET is ~338ms). This job NULLs a column on the strength of "LML returned no
 * Apple URL", so if it runs in that regime it will null a large fraction of
 * the CORRECT links it exists to preserve. Multi-pass alone doesn't rescue it:
 * at p≈0.56, even three consecutive passes still null a correct link ~18% of
 * the time.
 *
 * WHY THERE IS NO CONTROL COHORT. The obvious design — sample non-V/A rows
 * with a stored URL, re-verify them, and treat their null rate as the ambient
 * throttle rate — does not work here, and would be worse than nothing because
 * it manufactures false confidence. LML#1139's cache purge is scoped to the
 * V/A key space, so non-V/A triples come back from LML's *untouched, warm* L1
 * `track_streaming_url_cache` without ever running the Apple probe. There is
 * no cache-bypass knob on the lookup path (`forceLookup` only overrides the
 * BS#1293 `discogsUnavailable` gate), so that gate would measure ≈0 no matter
 * how badly throttled the probe was. Post-purge, the V/A cohort is the only
 * cold-by-construction population — and every member of it is also subject to
 * the guard, so no within-run control group exists.
 *
 * WHAT WE MEASURE INSTEAD. The multi-pass rule already produces the right
 * signal for free. A triple that returns null on pass 1 and a URL on a later
 * pass is a *directly observed* throttle-null: LML had the answer and the
 * first probe simply didn't get it. With three passes the observed rescue rate
 * is p(1-p)(1+p) — ≈0.38 at p=0.56, ≈0.05 at p=0.05 — so a high rescue rate is
 * live proof that `none` verdicts in this run are unreliable. Exceeding the
 * threshold aborts before more damage is done.
 *
 * The rate is only judged once `minSample` first-pass nulls have accumulated,
 * so a couple of unlucky early triples can't halt an otherwise healthy run.
 *
 * This does NOT replace the operational gate. The authoritative check is
 * LML#904's own: watch the 429-count and null-rate Sentry queries after
 * raising `LML_APPLE_MUSIC_RATE_PER_MIN`, before starting the run. This is the
 * backstop that catches a roll-up that silently didn't take.
 */

/** Default ceiling on the observed rescue rate before the run aborts. */
export const MAX_RESCUE_RATE_DEFAULT = 0.1;

/** First-pass nulls that must accumulate before the rate is judged at all. */
export const MIN_RESCUE_SAMPLE_DEFAULT = 50;

export interface RescueTracker {
  /** Triples whose first pass returned no Apple URL. */
  firstPassNulls: number;
  /** Of those, the ones a later pass resolved — observed throttle-nulls. */
  rescued: number;
}

export const newRescueTracker = (): RescueTracker => ({ firstPassNulls: 0, rescued: 0 });

/** Observed rescue rate, or 0 when nothing has been sampled yet. */
export const rescueRate = (tracker: RescueTracker): number =>
  tracker.firstPassNulls === 0 ? 0 : tracker.rescued / tracker.firstPassNulls;

export interface RescueVerdict {
  /** True when the run should stop before writing anything further. */
  abort: boolean;
  rate: number;
  sample: number;
  reason?: string;
}

/**
 * Judge the tracker against the configured ceiling.
 *
 * Returns `abort: false` while the sample is too small to mean anything — the
 * deliberate choice being that an under-sampled run continues rather than
 * halting on noise, since the operational Sentry gate is the primary defense
 * and this is the backstop.
 */
export const evaluateRescueRate = (
  tracker: RescueTracker,
  { maxRate = MAX_RESCUE_RATE_DEFAULT, minSample = MIN_RESCUE_SAMPLE_DEFAULT } = {}
): RescueVerdict => {
  const rate = rescueRate(tracker);
  const sample = tracker.firstPassNulls;
  if (sample < minSample) return { abort: false, rate, sample };
  if (rate <= maxRate) return { abort: false, rate, sample };
  return {
    abort: true,
    rate,
    sample,
    reason:
      `observed second/third-pass rescue rate ${(rate * 100).toFixed(1)}% over ${sample} first-pass nulls ` +
      `exceeds the ${(maxRate * 100).toFixed(1)}% ceiling — LML's Apple probe is nulling under load ` +
      `(LML#904), so 'no match' verdicts in this run cannot be trusted and would NULL correct URLs. ` +
      `Raise LML_APPLE_MUSIC_RATE_PER_MIN, confirm it took, and re-run.`,
  };
};
