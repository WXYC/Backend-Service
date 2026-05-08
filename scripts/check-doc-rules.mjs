#!/usr/bin/env node

/**
 * Parse <!-- @rule ... --> markers in docs/*.md and warn on staleness.
 *
 * Each operational rule in docs/ is preceded by a marker:
 *
 *   <!-- @rule id=hand-edit-when
 *              enforced-by=scripts/validate-migrations.mjs:check-1
 *              added=2026-02-01
 *              incidents=#400,#550
 *              review-after=2026-08-01 -->
 *
 *   **The one sanctioned hand-edit ...** [body prose]
 *
 * Fields:
 *   id           kebab-case unique identifier
 *   enforced-by  file:check tag, OR the literal string "none"
 *   added        ISO date the rule was added
 *   incidents    optional comma-separated #NNN list
 *   review-after optional ISO date — when set and reached, flag the rule
 *
 * This script surfaces three classes of drift, all warn-only:
 *
 *   1. enforcement-gap-old: enforced-by=none AND added is older than
 *      MAX_UNENFORCED_DAYS (default 180). The rule has lived on author
 *      discipline long enough to merit promoting to a check or
 *      removing it as internalized.
 *
 *   2. compress-candidate: enforced-by != none AND the prose body
 *      after the marker exceeds COMPRESS_THRESHOLD chars (default
 *      900). The check now carries the load; the prose can collapse
 *      to a short pointer to the check.
 *
 *   3. review-overdue: review-after date has passed.
 *
 * The intent is the question this codebase keeps re-asking: "when is
 * an incident-anchored rule ready to compress?" Once enforcement
 * exists, prose stops being load-bearing and becomes commentary —
 * this script tells you when that moment has arrived.
 *
 * Exit 0 always. Pre-push runs this warn-only.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DOCS_DIR = resolve(REPO_ROOT, 'docs');

const MAX_UNENFORCED_DAYS = Number(process.env.MAX_UNENFORCED_DAYS) || 180;
const COMPRESS_THRESHOLD = Number(process.env.COMPRESS_THRESHOLD) || 900;

// ---- collect markdown files ----------------------------------------------

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkMarkdown(p, out);
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

// ---- @rule marker parser -------------------------------------------------

const MARKER_RE = /<!--\s*@rule\s+([\s\S]*?)-->/g;

function parseMarker(raw) {
  // Field tokens are key=value, separated by whitespace. Values cannot
  // contain whitespace except inside an explicit comma list (no spaces).
  const fields = {};
  for (const tok of raw.trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq < 0) continue;
    fields[tok.slice(0, eq).trim()] = tok.slice(eq + 1).trim();
  }
  return fields;
}

function bodyAfterMarker(content, markerEnd) {
  // Body runs from end of marker to next marker, next H2/H3, or EOF.
  const rest = content.slice(markerEnd);
  const stops = [];
  const nextMarker = rest.search(/<!--\s*@rule\b/);
  if (nextMarker >= 0) stops.push(nextMarker);
  // Headings: ^## or ^### at start of line. Skip the first line so the
  // marker's own following blank/text doesn't count as a heading.
  const headingMatch = rest.search(/\n##{1,2}[^#]/);
  if (headingMatch >= 0) stops.push(headingMatch);
  const stop = stops.length ? Math.min(...stops) : rest.length;
  return rest.slice(0, stop).trim();
}

// ---- staleness checks ----------------------------------------------------

function ageDays(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / 86400000);
}

function isPast(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

// ---- main ----------------------------------------------------------------

const findings = [];
const seenIds = new Map(); // id -> file:line

for (const file of walkMarkdown(DOCS_DIR)) {
  const content = readFileSync(file, 'utf8');
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(content)) !== null) {
    const fields = parseMarker(m[1]);
    const id = fields.id || '(no-id)';
    const enforcedBy = fields['enforced-by'] || 'none';
    const added = fields.added;
    const reviewAfter = fields['review-after'];
    const lineNo = content.slice(0, m.index).split('\n').length;
    const where = `${relative(REPO_ROOT, file)}:${lineNo}`;

    // duplicate id check
    if (id !== '(no-id)') {
      if (seenIds.has(id)) {
        findings.push({
          level: 'duplicate-id',
          where,
          msg: `rule id=${id} also defined at ${seenIds.get(id)}`,
        });
      } else {
        seenIds.set(id, where);
      }
    }

    // body length
    const body = bodyAfterMarker(content, m.index + m[0].length);
    const bodyLen = body.length;

    // (1) enforcement-gap-old
    if (enforcedBy === 'none' && added) {
      const days = ageDays(added);
      if (days !== null && days > MAX_UNENFORCED_DAYS) {
        findings.push({
          level: 'enforcement-gap-old',
          where,
          msg: `rule id=${id} unenforced for ${days} days (>${MAX_UNENFORCED_DAYS}d) — consider promoting to a check or removing as internalized`,
        });
      }
    }

    // (2) compress-candidate
    if (enforcedBy !== 'none' && bodyLen > COMPRESS_THRESHOLD) {
      findings.push({
        level: 'compress-candidate',
        where,
        msg: `rule id=${id} enforced by ${enforcedBy} but body is ${bodyLen} chars (>${COMPRESS_THRESHOLD}) — consider compressing to a pointer`,
      });
    }

    // (3) review-overdue
    if (reviewAfter && isPast(reviewAfter)) {
      findings.push({
        level: 'review-overdue',
        where,
        msg: `rule id=${id} review-after=${reviewAfter} has passed — re-evaluate`,
      });
    }
  }
}

// ---- report --------------------------------------------------------------

if (findings.length === 0) {
  if (process.env.DEBUG) {
    console.error(`check-doc-rules: scanned ${seenIds.size} rules — no findings`);
  }
  process.exit(0);
}

console.error('');
console.error(`  check-doc-rules: ${findings.length} finding(s) across ${seenIds.size} rule(s)`);
console.error('');

const grouped = findings.reduce((acc, f) => {
  (acc[f.level] ||= []).push(f);
  return acc;
}, {});

const order = ['duplicate-id', 'review-overdue', 'enforcement-gap-old', 'compress-candidate'];
for (const level of order) {
  const items = grouped[level];
  if (!items) continue;
  console.error(`  [${level}]`);
  for (const f of items) {
    console.error(`    ${f.where}: ${f.msg}`);
  }
  console.error('');
}

process.exit(0);
