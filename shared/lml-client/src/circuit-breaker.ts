/**
 * Per-limiter circuit breaker for the shared LML client (BS#1748, PR 2 of the
 * "bound the limiter queue" spec).
 *
 * DESIGN PIN — this state lives on an `LmlLimiter` INSTANCE, never at module
 * scope. A module-level singleton would leak across `--runInBand` spec files
 * (the #962 sharp-edge-#1 hazard behind the BS#955 incident): one spec's
 * simulated LML slowness would trip a breaker that the next spec then observes
 * as already-open. `createLmlLimiter` constructs one `LmlCircuitBreaker` per
 * limiter it builds, so two limiters (e.g. the runtime `defaultLimiter` and a
 * job's dedicated limiter) hold fully independent breaker state.
 *
 * State machine (closed → open → half-open → closed):
 *
 *   - CLOSED: admit every call. Count *consecutive* failures; on reaching
 *     `failureThreshold` consecutive failures, trip to OPEN.
 *   - OPEN: fast-fail every call (the caller sheds with `shed_breaker_open`)
 *     without acquiring, until `openMs` has elapsed since it opened, then move
 *     to HALF_OPEN on the next admission attempt.
 *   - HALF_OPEN: admit exactly ONE probe. Its success closes the breaker and
 *     resets the counter; its failure re-opens for another `openMs`. Every
 *     other call while a probe is in flight is fast-failed like OPEN.
 *
 * A "failure" (see `LmlLimiter.run` in index.ts) is specifically an LML HTTP
 * timeout or a queue-saturation shed — the multi-minute-hang failure mode this
 * breaker exists to short-circuit. A fast non-timeout error (e.g. an LML 502)
 * and a normal empty-but-successful response are BOTH treated as healthy
 * (`recordSuccess`): the breaker guards against slowness, not against LML
 * returning a quick answer we happen not to like.
 *
 * The breaker reads the wall clock via `Date.now()` only — no timers, no
 * `setTimeout` — so it advances deterministically under Jest fake timers.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Consecutive failures in CLOSED that trip the breaker to OPEN. */
  failureThreshold: number;
  /** How long the breaker stays OPEN before admitting a half-open probe (ms). */
  openMs: number;
}

export class LmlCircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** True while a half-open probe is outstanding — blocks a second probe. */
  private probeInFlight = false;

  constructor(private readonly config: CircuitBreakerConfig) {}

  /**
   * Decide whether a call may proceed. Returns `true` to admit; `false` means
   * the breaker is OPEN (or a half-open probe is already outstanding) and the
   * caller must shed with `shed_breaker_open` WITHOUT acquiring a permit.
   *
   * Transitions OPEN → HALF_OPEN in place when `openMs` has elapsed, handing
   * the caller the single probe slot.
   */
  tryAdmit(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.config.openMs) {
        this.state = 'half_open';
        this.probeInFlight = true;
        return true;
      }
      return false;
    }

    // half_open: admit the probe only if one isn't already in flight. (The
    // OPEN→HALF_OPEN transition above sets probeInFlight, so the common path
    // here is "reject a concurrent call while the probe runs".)
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /** Record a healthy outcome: a half-open probe closes the breaker; either
   *  way the consecutive-failure streak resets. */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.probeInFlight = false;
    }
    this.consecutiveFailures = 0;
  }

  /** Record a failure (timeout or saturation shed). A half-open probe failure
   *  re-opens immediately; in CLOSED, trip once the streak hits the
   *  threshold. */
  recordFailure(): void {
    if (this.state === 'half_open') {
      this.open();
      return;
    }
    // closed (a failure recorded while OPEN is not expected — OPEN fast-fails
    // before running — but is harmless: re-open resets the window).
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  /** Current state — for tests and observability snapshots. */
  get currentState(): CircuitState {
    return this.state;
  }
}
