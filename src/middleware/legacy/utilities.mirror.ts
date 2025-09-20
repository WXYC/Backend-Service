
export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}


export function expBackoffMs(attempt: number, base: number, max: number, jitterRatio: number) {
  const pure = Math.min(max, base * 2 ** (attempt - 1));
  const jitter = pure * jitterRatio;
  // random in [pure - jitter, pure + jitter]
  return Math.max(0, pure + (Math.random() * 2 - 1) * jitter);
}

export function cryptoRandomId() {
  // Node 18+: crypto.randomUUID() available; fallback otherwise
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof (crypto as { randomUUID?: () => string }).randomUUID === "function"
    ) {
      return (crypto as { randomUUID: () => string }).randomUUID();
    }
  } catch { /* ignore */ }
  return "cmd_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const toMs = (v: unknown, fallback = Date.now()): number => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const iso = Date.parse(v);
    if (Number.isFinite(iso)) return Math.floor(iso);
    const num = Number(v);
    if (Number.isFinite(num)) return Math.floor(num);
  }
  return Math.floor(fallback);
};

export  const safeSql = (s?: string | null) =>
    s === undefined || s === null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
/**
 * Floors valid numbers and returns their string representation for SQL.
 * Returns the string "NULL" for invalid inputs (non-numbers or non-finite values).
 * Intended for safe SQL number generation.
 */
export const safeSqlNum = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? String(Math.floor(n)) : "NULL";