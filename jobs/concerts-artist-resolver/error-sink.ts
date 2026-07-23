/**
 * Shared onError-sink guard for jobs/concerts-artist-resolver's per-row
 * orchestration loops (BS#1760).
 *
 * Mirrors the bulletproof `safeNotifyError`/`safeStringifyThrown` pair
 * private to orchestrate.ts's `runResolver` (BS#1372) byte-for-byte in
 * behavior. That pair stays where it is — it's a private, non-exported
 * helper scoped to the headliner loop, and the ticket that introduced
 * sync.ts/support.ts (BS#1760) is explicit that those loops must be
 * bespoke rather than reach into orchestrate.ts's headliner-shaped
 * internals. Landing a THIRD hand-rolled copy inside each new loop file
 * would let the two drift on this hardening, so this module exists as
 * the shared home for exactly the two new callers (sync.ts, support.ts).
 *
 * The whole point: a misbehaving `onError` sink (throws synchronously,
 * rejects asynchronously, or even throws while being stringified) must
 * never abort the orchestrator loop it's plugged into. The per-item
 * counter is the durable record of a failure — the sink is best-effort
 * observability layered on top.
 */

/**
 * Stringify a value that's already been thrown without re-throwing. Never
 * trust the value's `.message` getter, `toString`, `Symbol.toPrimitive`,
 * or any other coercion path — a pathological sink might throw values
 * whose stringification itself throws.
 */
export const safeStringifyThrown = (value: unknown): string => {
  try {
    if (value instanceof Error) return value.message;
    return String(value);
  } catch {
    return '<unrepresentable sink error>';
  }
};

/**
 * Invoke an `onError` sink without letting it abort the caller's loop.
 * `await` accepts both `void` and `Promise<void>` returns; a sync throw
 * or an async rejection from the sink is caught and never re-raised. On
 * sink failure, write a single stderr line (prefixed with `sinkPrefix`,
 * e.g. the job name + step) so a broken observability path is at least
 * visible in container logs instead of silently disappearing — mirrors
 * orchestrate.ts's `SINK_FAILURE_PREFIX` convention, generalised to a
 * caller-supplied string since this helper serves more than one loop.
 */
export const safeNotifyError = async <TCandidate>(
  onError: (candidate: TCandidate, error: unknown) => void | Promise<void>,
  candidate: TCandidate,
  error: unknown,
  sinkPrefix: string
): Promise<void> => {
  try {
    await onError(candidate, error);
  } catch (sinkError) {
    const sinkMessage = safeStringifyThrown(sinkError);
    try {
      process.stderr.write(`${sinkPrefix}: onError sink failed: ${sinkMessage}\n`);
    } catch {
      /* even stderr is gone — there is nothing else we can do */
    }
  }
};
