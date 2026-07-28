#!/usr/bin/env node
/**
 * Local latency measurement for GET /playlists/recentEntries.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) replaced the
 * in-memory SSE-fed read with a live Postgres query. The in-memory read was
 * O(1) and unbeatable by construction — this script does not try to match
 * it. Instead it produces a repeatable LOCAL p95 number against a real dev
 * stack, to be recorded as a route-level budget in the PR body. A
 * PRODUCTION baseline (comparing against the real in-memory-SSE p95 that
 * was live in prod before this change) is a separate human follow-up — this
 * script only measures the local dev database, which is far smaller than
 * prod's ~2.6M-row flowsheet table.
 *
 * Usage:
 *   node tests/perf/measure-recent-entries-latency.mjs [--n=100] [--iterations=50] [--host=http://localhost:8080]
 *
 * Requires the backend dev server running (`npm run dev`) and the dev
 * database up (`npm run db:start`) — see docs/testing.md /
 * docs/dev-db-fixture.md. Exits non-zero on any request failure so a CI or
 * scripted invocation can't silently report a bogus number from a broken
 * run.
 */

import { performance } from 'node:perf_hooks';

function parseArgs(argv) {
  const args = { n: 100, iterations: 50, host: 'http://localhost:8080' };
  for (const raw of argv.slice(2)) {
    const match = /^--([a-z]+)=(.+)$/.exec(raw);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'n' || key === 'iterations') {
      args[key] = Number(value);
    } else if (key === 'host') {
      args.host = value;
    }
  }
  return args;
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

async function measureOnce(url) {
  const start = performance.now();
  const res = await fetch(url);
  const elapsedMs = performance.now() - start;
  // Drain the body so keep-alive connection reuse doesn't skew later
  // requests' connection-setup cost.
  await res.arrayBuffer();
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status}`);
  }
  return elapsedMs;
}

async function main() {
  const { n, iterations, host } = parseArgs(process.argv);
  const url = `${host}/playlists/recentEntries?n=${n}`;

  console.log(`[perf] Measuring GET ${url}`);
  console.log(`[perf] ${iterations} iterations (sequential, matching the CLAUDE.md curl-loop reference form)`);

  const timings = [];
  for (let i = 0; i < iterations; i++) {
    try {
      const elapsedMs = await measureOnce(url);
      timings.push(elapsedMs);
    } catch (err) {
      console.error(`[perf] Request ${i + 1}/${iterations} failed:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
      return;
    }
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;

  const report = {
    url,
    iterations,
    min_ms: sorted[0],
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted[sorted.length - 1],
    mean_ms: mean,
  };

  console.log('[perf] Results (ms):');
  for (const [key, value] of Object.entries(report)) {
    if (typeof value === 'number') {
      console.log(`  ${key}: ${value.toFixed(2)}`);
    } else {
      console.log(`  ${key}: ${value}`);
    }
  }
  console.log(`\n[perf] p95: ${report.p95_ms.toFixed(2)} ms over ${iterations} requests, n=${n}`);
}

main().catch((err) => {
  console.error('[perf] Fatal error:', err);
  process.exitCode = 1;
});
