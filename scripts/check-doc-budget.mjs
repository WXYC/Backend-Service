#!/usr/bin/env node

/**
 * Warn when CLAUDE.md grows past a budget threshold.
 *
 * CLAUDE.md is loaded into every Claude session's context. When it grows
 * past ~15k chars it stops being a reference card and starts being a
 * knowledge base — at which point it should be split into docs/*.md
 * with CLAUDE.md becoming a router. This check is the forcing function:
 * it doesn't gate the push, but it makes the cost of accumulation
 * visible at every push.
 *
 * Two thresholds:
 *   - WARN above CLAUDE_MD_BUDGET (default 16000 chars). One section is
 *     overdue for extraction; pick the largest non-reference section
 *     and move it to docs/.
 *   - ALARM above CLAUDE_MD_BUDGET + CLAUDE_MD_ALARM_OVERHEAD (default
 *     +6000). The file has drifted noticeably; treat extraction as a
 *     prerequisite to landing the next addition.
 *
 * Override via environment:
 *   CLAUDE_MD_BUDGET=N           absolute warn threshold (chars)
 *   CLAUDE_MD_ALARM_OVERHEAD=M   chars above warn at which alarm fires
 *
 * Always exits 0 — pre-push must not block on doc hygiene.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLAUDE_MD = resolve(REPO_ROOT, 'CLAUDE.md');

const WARN = Number.isFinite(Number(process.env.CLAUDE_MD_BUDGET)) ? Number(process.env.CLAUDE_MD_BUDGET) : 16000;
const ALARM_OVERHEAD = Number.isFinite(Number(process.env.CLAUDE_MD_ALARM_OVERHEAD))
  ? Number(process.env.CLAUDE_MD_ALARM_OVERHEAD)
  : 6000;
const ALARM = WARN + ALARM_OVERHEAD;

if (!existsSync(CLAUDE_MD)) {
  console.error(`check-doc-budget: ${CLAUDE_MD} not found — skipping`);
  process.exit(0);
}

const chars = readFileSync(CLAUDE_MD, 'utf8').length;

const fmt = (n) => n.toLocaleString('en-US');

if (chars >= ALARM) {
  console.error('');
  console.error(`  [ALARM] CLAUDE.md is ${fmt(chars)} chars (alarm at ${fmt(ALARM)})`);
  console.error('');
  console.error("  CLAUDE.md is loaded into every Claude session's context. The file");
  console.error('  has drifted noticeably above its budget. Before adding more, extract');
  console.error('  a section to docs/ — see docs/migrations.md for the @rule annotation');
  console.error('  pattern, or just lift a self-contained section into a new docs/<topic>.md');
  console.error('  with a one-line pointer left in CLAUDE.md.');
  console.error('');
} else if (chars >= WARN) {
  console.error('');
  console.error(`  [WARN] CLAUDE.md is ${fmt(chars)} chars (budget ${fmt(WARN)})`);
  console.error('  When adding a section, consider extracting an existing one to docs/.');
  console.error('');
} else if (process.env.DEBUG) {
  console.error(`check-doc-budget: CLAUDE.md is ${fmt(chars)} chars (budget ${fmt(WARN)}) — OK`);
}

process.exit(0);
