
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
    // @ts-ignore
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  return "cmd_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export  const safeSql = (s?: string | null) =>
    s === undefined || s === null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
export  const safeSqlNum = (n?: number | null) =>
    n === undefined || n === null || Number.isNaN(Number(n)) ? "NULL" : String(Number(n));