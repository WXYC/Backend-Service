/**
 * M2.4 — Backend-Service metadata + artwork cache verify (issue #528).
 *
 * After M2.1 corrects mojibake'd name fields in BS PG, the metadata and
 * artwork cached on those same rows is still derived from LML lookups
 * keyed by the *bad* names. This script finds those rows and either
 * reports counts (default) or NULLs the cached fields so the next
 * request triggers a fresh lookup with the corrected name.
 *
 * The "caches" in BS PG are persisted columns:
 *
 *   library:    artwork_url, canonical_entity_id (+ confidence + resolved_at)
 *   flowsheet:  artwork_url, discogs_url, release_year, spotify_url,
 *               apple_music_url, youtube_music_url, bandcamp_url,
 *               soundcloud_url, artist_bio, artist_wikipedia_url
 *
 * The in-process LRU caches in apps/backend/controllers/proxy.controller.ts
 * have ≤ 1 hour TTL and turn over on every restart, so they don't need an
 * explicit scan — a backend redeploy invalidates them.
 *
 * Default = invalidate (NULL cached fields). The next read repopulates
 * via LML keyed by the corrected name. Rekey would preserve the cached
 * artwork URL, but the cache value (e.g., a Discogs release_id) might
 * point to a release that was matched against the wrong artist, so
 * starting fresh is safer.
 *
 * Usage:
 *   # Dry-run: report counts to stdout / a CSV.
 *   npx tsx scripts/cache-scan/mojibake_cache_audit.ts \
 *     --csv /tmp/mojibake_fixes.csv \
 *     --out audit/bs_cache_audit.json
 *
 *   # Apply: NULL cached fields on matching rows.
 *   npx tsx scripts/cache-scan/mojibake_cache_audit.ts \
 *     --csv /tmp/mojibake_fixes.csv \
 *     --apply
 *
 * The CSV is the V012 fixes file (from /tmp/mojibake_fixes.csv) with a
 * header row of `table,column,current,proposed,...`. Only the `current`
 * and `proposed` columns are read.
 */

import { config } from 'dotenv';
config();

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

// -----------------------------------------------------------------------------
// Cache column inventories — exported so tests can pin them.
// -----------------------------------------------------------------------------

export const LIBRARY_NAME_COLUMNS = ['artist_name', 'album_artist', 'alternate_artist_name', 'album_title'] as const;

export const LIBRARY_CACHE_COLUMNS = [
  'artwork_url',
  'canonical_entity_id',
  'canonical_entity_confidence',
  'canonical_entity_resolved_at',
] as const;

export const FLOWSHEET_NAME_COLUMNS = ['artist_name', 'album_title', 'track_title', 'record_label'] as const;

export const FLOWSHEET_CACHE_COLUMNS = [
  'artwork_url',
  'discogs_url',
  'release_year',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'bandcamp_url',
  'soundcloud_url',
  'artist_bio',
  'artist_wikipedia_url',
] as const;

const SCHEMA = 'wxyc_schema';

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

export interface CorrectedName {
  current: string;
  proposed: string;
}

/**
 * Parse a fixes CSV into a deduplicated list of (current, proposed) pairs.
 *
 * Accepts the V012 schema (`table,column,current,proposed,...`); any extra
 * trailing columns are ignored. Skips the header, blank lines, and rows
 * that are missing either name. Supports double-quoted values containing
 * commas (RFC 4180-ish), which is enough for our fix-pair shape — we do
 * not handle embedded newlines or escaped quotes because the source
 * generator never emits those.
 */
export function parseFixesCsv(content: string): CorrectedName[] {
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const out: CorrectedName[] = [];
  let headerSkipped = false;
  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    const fields = parseCsvLine(rawLine);
    if (!headerSkipped) {
      headerSkipped = true;
      // Heuristic header check: first row whose 3rd/4th columns are literally
      // "current"/"proposed". If a CSV without a header is ever passed, the
      // first row is just dropped — acceptable since the producer always
      // emits a header.
      if (fields[2]?.toLowerCase() === 'current' && fields[3]?.toLowerCase() === 'proposed') {
        continue;
      }
      // Not a header row — fall through and treat it as data.
    }
    const current = fields[2]?.trim();
    const proposed = fields[3]?.trim();
    if (!current || !proposed) continue;
    const key = `${current}\u0000${proposed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ current, proposed });
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        buf += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

/**
 * Whether the string carries the double-encoded UTF-8 fingerprint —
 * its bytes can be re-encoded as latin1 and decoded as UTF-8 to a
 * different, valid (no U+FFFD) string. Same heuristic as
 * scripts/audit/bs_mojibake_scan.py's `try_fix`, kept in sync so
 * detector results agree across phases.
 */
export function hasMojibakeFingerprint(s: string | null | undefined): boolean {
  if (!s) return false;
  // Cheap pre-filter: only strings carrying latin1-supplement codepoints
  // (0x80-0xFF) can be the result of double-encoded UTF-8 displayed as
  // latin1. Skip everything else — including clean Greek/Cyrillic.
  let hasSupplement = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80 && cp <= 0xff) {
      hasSupplement = true;
      break;
    }
  }
  if (!hasSupplement) return false;

  // Re-encode as latin1 (one codepoint per byte; >0xFF is fatal).
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp > 0xff) return false;
    bytes[i] = cp;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (decoded === s) return false;
  if (decoded.includes('\ufffd')) return false;
  return true;
}

// -----------------------------------------------------------------------------
// DB operations
// -----------------------------------------------------------------------------

export interface CacheCount {
  table: string;
  cachedField: string;
  matchedRows: number;
}

export interface InvalidateResult {
  table: string;
  rowsAffected: number;
}

type CountRow = Record<string, number | string | null>;

const TABLE_TARGETS = [
  ['library', LIBRARY_NAME_COLUMNS, LIBRARY_CACHE_COLUMNS] as const,
  ['flowsheet', FLOWSHEET_NAME_COLUMNS, FLOWSHEET_CACHE_COLUMNS] as const,
] as const;

/**
 * Build the OR-matrix `"name_col_1" = ANY($names) OR "name_col_2" = ANY($names) OR ...`
 * as a parameterized drizzle SQL fragment. The cache row is implicated
 * whenever any of the row's name fields hits the corrected-name set —
 * we don't know which field LML actually keyed on at write time.
 *
 * Column identifiers are compile-time constants (LIBRARY_NAME_COLUMNS,
 * FLOWSHEET_NAME_COLUMNS), so embedding them via `sql.raw` is safe.
 * The names array goes through drizzle's parameter binding.
 */
function buildNameMatchClause(nameColumns: readonly string[], names: string[]): SQL {
  // Compose `"col_1" = ANY($names) OR "col_2" = ANY($names) OR ...` by
  // weaving raw column-prefix fragments and the bound array parameter.
  // Each ANY binds a fresh parameter slot; drizzle ships the same array
  // value for each, which is fine — there's no per-call cost worth shaving.
  const head = `"${nameColumns[0]}" = ANY(`;
  const middleSeparators = nameColumns.slice(1).map((col) => `) OR "${col}" = ANY(`);
  let composed: SQL = sql`${sql.raw(head)}${names}`;
  for (const fragment of middleSeparators) {
    composed = sql`${composed}${sql.raw(fragment)}${names}`;
  }
  return sql`${composed}${sql.raw(')')}`;
}

/**
 * Run the per-table COUNT(*) FILTER pass and return one CacheCount entry
 * per (table, cache column). One round trip per table; each cache column
 * gets its own FILTER aggregate inline.
 */
export async function countStaleCacheRows(correctedNames: string[]): Promise<CacheCount[]> {
  if (correctedNames.length === 0) return [];

  const out: CacheCount[] = [];

  for (const [table, nameCols, cacheCols] of TABLE_TARGETS) {
    const aggregates = sql.raw(
      cacheCols.map((col) => `COUNT(*) FILTER (WHERE "${col}" IS NOT NULL)::bigint AS "${col}"`).join(', ')
    );
    const matchClause = buildNameMatchClause(nameCols, correctedNames);
    const tableRef = sql.raw(`"${SCHEMA}"."${table}"`);
    const rows = (await db.execute(
      sql`SELECT ${aggregates} FROM ${tableRef} WHERE (${matchClause})`
    )) as unknown as CountRow[];
    const row = rows?.[0] ?? {};
    for (const col of cacheCols) {
      const raw = row[col];
      const n = typeof raw === 'number' ? raw : raw == null ? 0 : Number(raw);
      out.push({ table, cachedField: col, matchedRows: Number.isFinite(n) ? n : 0 });
    }
  }

  return out;
}

/**
 * NULL every cache column on rows whose name field equals one of the
 * corrected names AND have at least one non-null cache field. The
 * `OR ... IS NOT NULL` guard keeps the UPDATE from rewriting clean
 * rows for no reason — minimizes row churn and avoids spurious CDC
 * notifications on rows that have nothing to invalidate.
 */
export async function invalidateStaleCacheRows(correctedNames: string[]): Promise<InvalidateResult[]> {
  if (correctedNames.length === 0) return [];

  const out: InvalidateResult[] = [];

  for (const [table, nameCols, cacheCols] of TABLE_TARGETS) {
    const setClause = sql.raw(cacheCols.map((col) => `"${col}" = NULL`).join(', '));
    const matchClause = buildNameMatchClause(nameCols, correctedNames);
    const cacheNonNullClause = sql.raw(cacheCols.map((col) => `"${col}" IS NOT NULL`).join(' OR '));
    const tableRef = sql.raw(`"${SCHEMA}"."${table}"`);
    const result = (await db.execute(
      sql`UPDATE ${tableRef} SET ${setClause} WHERE (${matchClause}) AND (${cacheNonNullClause})`
    )) as unknown as { count?: number; rowCount?: number } | undefined;
    const rowsAffected = Number(result?.count ?? result?.rowCount ?? 0);
    out.push({ table, rowsAffected: Number.isFinite(rowsAffected) ? rowsAffected : 0 });
  }

  return out;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

interface CliArgs {
  csvPath: string;
  apply: boolean;
  outPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let csvPath = '/tmp/mojibake_fixes.csv';
  let apply = false;
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--csv') {
      csvPath = argv[++i];
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--out') {
      outPath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: mojibake_cache_audit.ts [--csv <path>] [--apply] [--out <json-path>]');
      process.exit(0);
    }
  }
  return { csvPath, apply, outPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.csvPath)) {
    console.error(`Fix CSV not found: ${args.csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(args.csvPath, 'utf8');
  const fixes = parseFixesCsv(csvContent);
  const correctedNames = Array.from(new Set(fixes.map((f) => f.proposed)));
  console.log(`Loaded ${fixes.length} fix-pair(s) — ${correctedNames.length} unique corrected names.`);

  const before = await countStaleCacheRows(correctedNames);
  const beforeTotal = before.reduce((acc, c) => acc + c.matchedRows, 0);
  console.log(`Stale-cache rows BEFORE: ${beforeTotal} (across ${before.length} (table, field) cells)`);
  for (const c of before) {
    if (c.matchedRows > 0) {
      console.log(`  ${c.table}.${c.cachedField}: ${c.matchedRows}`);
    }
  }

  let invalidated: InvalidateResult[] = [];
  let after: CacheCount[] = [];
  if (args.apply) {
    invalidated = await invalidateStaleCacheRows(correctedNames);
    for (const r of invalidated) {
      console.log(`  invalidated: ${r.table} — ${r.rowsAffected} row(s)`);
    }
    after = await countStaleCacheRows(correctedNames);
    const afterTotal = after.reduce((acc, c) => acc + c.matchedRows, 0);
    console.log(`Stale-cache rows AFTER:  ${afterTotal}`);
  }

  if (args.outPath) {
    const payload = {
      csvPath: args.csvPath,
      fixPairCount: fixes.length,
      correctedNameCount: correctedNames.length,
      apply: args.apply,
      before,
      invalidated,
      after,
      generatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${args.outPath}.`);
  }

  await closeDatabaseConnection();
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const arg = process.argv[1];
  return arg.endsWith('mojibake_cache_audit.ts') || arg.endsWith('mojibake_cache_audit.js');
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}
