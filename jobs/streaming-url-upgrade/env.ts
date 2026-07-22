/**
 * Shared env-var parser for the streaming-url-upgrade job.
 *
 * `Number(raw)` (not `parseInt`) so partial-parse strings like "35000banana"
 * surface as NaN and get rejected instead of silently coercing to 35000.
 * `Number.isSafeInteger` guards against precision-lost large values
 * (2^53+1 silently rounds to 2^53 and isInteger returns true).
 *
 * Invalid values fall back with a `console.warn` — the JSON logger isn't
 * available at module-load time (which is when these readers fire). A
 * future cleanup could route through the structured logger after init.
 */
export const envInt = (name: string, fallback: number, prefix = 'env'): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  console.warn(`${prefix}: ${name}=${raw} is invalid (must be positive safe integer); using fallback ${fallback}`);
  return fallback;
};
