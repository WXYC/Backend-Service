// Resolve SENTRY_TRACES_SAMPLE_RATE for the auth runtime container.
// Default 1.0 preserves the post-#767 behavior where Sentry's Express
// auto-instrumentation captures every HTTP transaction. Operators can
// downshift via env var (e.g. SENTRY_TRACES_SAMPLE_RATE=0.1) without a
// code change if Sentry transaction costs spike. Job loggers default to
// 0; runtime defaults to 1.0 — same algorithm, different documented default.
export const resolveTracesSampleRate = (
  raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE,
  defaultRate = 1.0
): number => {
  if (raw === undefined) return defaultRate;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return defaultRate;
  return parsed;
};
