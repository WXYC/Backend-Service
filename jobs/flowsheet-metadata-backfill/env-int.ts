/**
 * Shared `Number()`-based, warn-and-fallback env-int parser (BS#1995 review
 * follow-up).
 *
 * Extracted out of four near-identical copies (`lml-fetch.ts`,
 * `lml-limiter.ts`, and two variants in `lml-health.ts`) so the validation
 * bug found in review only needed fixing once: the pre-extraction copies
 * validated with `Number.isFinite(parsed) && parsed > 0` (or `>= 0`), which
 * silently accepted whitespace-only strings (`Number(' ')` === `0`, which
 * passes a non-negative bound with no warning at all — a stray trailing
 * space in an `--env-file` line could silently disable a safety gate),
 * decimals (`2.5`), hex (`0x10`), and scientific notation (`1e3`) despite
 * every call site being named `envInt`.
 *
 * `logger.ts`'s `resolveTracesSampleRate` is NOT one of the four — it's a
 * bounded-float parser (0–1, for `SENTRY_TRACES_SAMPLE_RATE`) with its own
 * silent-fallback-to-1-on-invalid contract, not an integer parser, and
 * folding it in here would either warp this module's semantics or bolt an
 * unrelated float path onto it. Left alone.
 *
 * Each call site keeps its own exact warning-message wording (they differed
 * slightly before this extraction — "must be positive number" vs "must be a
 * positive number" — preserved verbatim via the `buildWarning` callback
 * rather than silently unified) and its own default/fallback value; only the
 * parsing + validation mechanism is shared.
 */

/** `'positive'` requires `> 0`; `'non-negative'` allows `0` (the "0 disables" convention several knobs in this job use). */
export type EnvIntBound = 'positive' | 'non-negative';

/** Plain base-10 integer literal, optional leading minus. Rejects whitespace-only, decimals, hex, and scientific notation. */
const DECIMAL_INT_PATTERN = /^-?\d+$/;

/**
 * Read `process.env[name]` and parse it as a base-10 integer meeting
 * `bound`. Unset or empty-string env values return `fallback` silently (the
 * "not configured" case, distinct from "configured but invalid"). Any other
 * unparseable or out-of-bound value warns via `buildWarning(raw)` (the
 * *untrimmed* raw string, so the warning shows exactly what was set) and
 * returns `fallback`.
 */
export const parseEnvInt = (
  name: string,
  fallback: number,
  bound: EnvIntBound,
  buildWarning: (raw: string) => string
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const trimmed = raw.trim();
  if (DECIMAL_INT_PATTERN.test(trimmed)) {
    const parsed = Number(trimmed);
    if (bound === 'positive' ? parsed > 0 : parsed >= 0) {
      return parsed;
    }
  }
  console.warn(buildWarning(raw));
  return fallback;
};
