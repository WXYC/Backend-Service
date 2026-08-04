#!/usr/bin/env node

/**
 * Schema-shape report generator for the PR-bot.
 *
 * Reads the PR's diff against the merge base on stdin (or via `--diff <file>`),
 * detects newly-introduced schema constraints (uniqueIndex / .unique() / .notNull()
 * SET-NOT-NULL ALTERs / check / FK additions), generates a SELECT that finds
 * rows which would violate each constraint, runs the SELECT against the probe
 * target, and prints a markdown comment summary to stdout.
 *
 * The probe target is the ephemeral RDS sandbox that the `migrate-dryrun` job
 * in `.github/workflows/test.yml` restores from the most recent automated prod
 * snapshot. That job invokes this script BEFORE it applies the pending
 * migrations, which is the whole point: the question is "how many rows that
 * exist in prod today would this new constraint reject", and after the
 * migrations run the answer is zero by construction. #703 originally specified
 * a standing staging clone (`STAGING_DATABASE_URL_RO`); that credential was
 * never provisioned, and #1982 folded the probe into `migrate-dryrun` rather
 * than mint a new long-lived one.
 *
 * The script is deliberately conservative: it never throws to the workflow.
 * If anything goes wrong (no probe target, parse failure, query timeout) it
 * prints a graceful "manual check required" comment and exits 0 so the
 * workflow can still post it. Every query runs in a READ ONLY transaction.
 *
 * Usage:
 *   git diff origin/main...HEAD -- shared/database/src/schema.ts shared/database/src/migrations | \
 *     node scripts/schema-shape-report.mjs > comment.md
 *
 *   # or
 *   node scripts/schema-shape-report.mjs --diff /tmp/pr.diff > comment.md
 *
 * Env (probe target — discrete params preferred, URL accepted):
 *   SHAPE_PROBE_DB_HOST / _PORT / _NAME / _USERNAME / _PASSWORD
 *                               — discrete connection params. This is what
 *                                 `migrate-dryrun` passes; it avoids having to
 *                                 percent-encode a secret password into a URL
 *                                 in shell.
 *   SHAPE_PROBE_DATABASE_URL    — PostgreSQL connection URL. Alternative to the
 *                                 discrete params; takes precedence if set.
 *                                 `STAGING_DATABASE_URL_RO` is still honored as
 *                                 an alias for #703 continuity.
 *   SHAPE_PROBE_SCHEMA_NAME     — Schema name (defaults to `wxyc_schema`).
 *                                 Alias: `STAGING_SCHEMA_NAME`.
 *   SHAPE_PROBE_SNAPSHOT_LABEL  — Free-form provenance label for the snapshot
 *                                 the numbers came from, rendered in the
 *                                 comment header. Alias: `STAGING_SNAPSHOT_LABEL`.
 *
 * See: https://github.com/WXYC/Backend-Service/issues/703
 *      https://github.com/WXYC/Backend-Service/issues/1982
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Comment marker — the workflow uses this to find a previous comment and
// edit-in-place rather than spamming the PR.
// ---------------------------------------------------------------------------
export const COMMENT_MARKER = '<!-- wxyc-schema-shape-report -->';

const SCHEMA_NAME = process.env.SHAPE_PROBE_SCHEMA_NAME || process.env.STAGING_SCHEMA_NAME || 'wxyc_schema';
const SNAPSHOT_LABEL =
  process.env.SHAPE_PROBE_SNAPSHOT_LABEL || process.env.STAGING_SNAPSHOT_LABEL || new Date().toISOString().slice(0, 10);
const SAMPLE_LIMIT = 5;
const PER_QUERY_TIMEOUT_MS = 30000;

/**
 * Column names whose VALUES must never be echoed into the rendered comment.
 *
 * The comment lands on a pull request in a PUBLIC repository, and since #1982
 * the probe runs against a restore of the real prod snapshot rather than the
 * never-provisioned staging clone #703 assumed. A duplicate-group probe on,
 * say, `auth_user.email` would otherwise paste live addresses into a
 * world-readable comment. Counts — the actionable part of the report — are
 * unaffected; only the sample key VALUES are masked, and the column name is
 * still shown so the reviewer knows what to go look at themselves.
 */
const PII_COLUMN_PATTERN =
  /(email|password|token|secret|phone|address|ip_addr|fingerprint|real_name|dj_name|user_id|dj_id)/i;
const REDACTED = '[redacted]';

/** Mask the VALUES of PII-bearing keys in a sampled duplicate group. */
function redactSampleKeys(keys) {
  if (!keys || typeof keys !== 'object') return keys;
  return Object.fromEntries(
    Object.entries(keys).map(([name, value]) => [name, PII_COLUMN_PATTERN.test(name) ? REDACTED : value])
  );
}

// ---------------------------------------------------------------------------
// Diff loading
// ---------------------------------------------------------------------------

function loadDiff() {
  const diffArgIdx = process.argv.indexOf('--diff');
  if (diffArgIdx >= 0 && process.argv[diffArgIdx + 1]) {
    return readFileSync(process.argv[diffArgIdx + 1], 'utf8');
  }
  // Read from stdin
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Diff parsing helpers
// ---------------------------------------------------------------------------

/**
 * Yield "added" line bodies grouped by file, with the file path attached.
 * Each entry is { file, line } where line is the raw added text (without the
 * leading '+').
 */
function iterateAddedLines(diff) {
  const out = [];
  let currentFile = null;
  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice('+++ b/'.length);
      continue;
    }
    if (rawLine.startsWith('+++') || rawLine.startsWith('---')) {
      continue;
    }
    if (currentFile && rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      out.push({ file: currentFile, line: rawLine.slice(1) });
    }
  }
  return out;
}

/**
 * Detect new uniqueIndex(...) calls in schema.ts diffs.
 * Pattern: `uniqueIndex('NAME').on(table.col1, table.col2)` optionally followed
 * by `.where(sql\`...\`)` for partial indexes.
 *
 * Returns: { kind: 'unique', name, columns, where, table?, source }
 *
 * `table` requires looking back in the schema for the enclosing `wxyc_schema.table('NAME', ...)`
 * call; we resolve it later by scanning the full schema file.
 */
function detectUniqueIndexes(addedLines, schemaText) {
  const constraints = [];
  // We scan the full schema file (not just the diff) so we can map any
  // uniqueIndex name back to its enclosing table.
  const indexToTable = mapUniqueIndexNamesToTables(schemaText);

  // Match `uniqueIndex('NAME')` or `uniqueIndex("NAME")` introduced in the diff.
  const re = /uniqueIndex\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  for (const { file, line } of addedLines) {
    if (!file.endsWith('schema.ts')) continue;
    let match;
    while ((match = re.exec(line)) !== null) {
      const name = match[1];
      const table = indexToTable.get(name);
      constraints.push({
        kind: 'unique',
        name,
        table: table?.tableName,
        columns: table?.columns ?? [],
        where: table?.where ?? null,
        source: `schema.ts uniqueIndex('${name}')`,
      });
    }
  }
  return constraints;
}

/**
 * Walk schema.ts and produce a map of uniqueIndex-name -> { tableName, columns, where }
 * by tracking the most-recently-seen `<schema>.table('NAME', ...)` call.
 */
function mapUniqueIndexNamesToTables(schemaText) {
  const result = new Map();
  if (!schemaText) return result;

  // Find every `wxyc_schema.table('NAME', ...)` and `pgTable('NAME', ...)` opening,
  // record its position, then sort. For each uniqueIndex/unique we encounter,
  // attribute it to the most-recent table-opening before it.
  const tableOpenings = [];
  const tableRe = /(?:wxyc_schema\.table|pgTable)\(\s*['"`]([^'"`]+)['"`]/g;
  let tMatch;
  while ((tMatch = tableRe.exec(schemaText)) !== null) {
    tableOpenings.push({ pos: tMatch.index, tableName: tMatch[1] });
  }
  if (tableOpenings.length === 0) return result;

  // Now find every uniqueIndex(...).on(...).where(...) span
  const idxRe = /uniqueIndex\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.on\(([^)]*)\)(?:\s*\.where\(\s*sql`([^`]*)`\s*\))?/g;
  let iMatch;
  while ((iMatch = idxRe.exec(schemaText)) !== null) {
    const name = iMatch[1];
    const rawColumns = iMatch[2];
    const whereSql = iMatch[3] ?? null;
    const tableEntry = lastBefore(tableOpenings, iMatch.index);
    if (!tableEntry) continue;

    const columns = parseColumns(rawColumns);
    result.set(name, {
      tableName: tableEntry.tableName,
      columns,
      where: whereSql ? sqlTemplateToPlain(whereSql) : null,
    });
  }
  return result;
}

function lastBefore(arr, pos) {
  let candidate = null;
  for (const entry of arr) {
    if (entry.pos < pos) candidate = entry;
    else break;
  }
  return candidate;
}

/**
 * Parse the inside of `.on(table.col1, table.col2)` or `.on(sql\`expr\`)` into
 * a list of column names (or expressions). For sql-template expressions we
 * fall back to the raw text — the consumer renders it as-is.
 */
function parseColumns(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // sql`...` template
  if (/^sql`/.test(trimmed)) {
    const inner = trimmed.match(/sql`([^`]*)`/)?.[1] ?? trimmed;
    return [{ kind: 'expr', text: sqlTemplateToPlain(inner) }];
  }

  // Comma-split (best-effort: trigger expression columns are captured as exprs)
  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => {
    const colMatch = p.match(/(?:table|t)\.([A-Za-z_][A-Za-z0-9_]*)/);
    if (colMatch) return { kind: 'col', name: colMatch[1] };
    return { kind: 'expr', text: p };
  });
}

/**
 * Drizzle's sql-template uses ${table.col} interpolations. We can't resolve
 * those without a real evaluator, so we strip the `${...}` markers down to
 * a best-effort plain SQL string that mentions the column name. It's only
 * used in display / WHERE clauses where raw drizzle expressions tend to
 * appear verbatim (e.g. `${table.kill_date} IS NULL`).
 */
function sqlTemplateToPlain(s) {
  return s.replace(/\$\{[^}]*\.([A-Za-z_][A-Za-z0-9_]*)\}/g, '$1').trim();
}

/**
 * Detect `ALTER COLUMN ... SET NOT NULL` clauses introduced in migration SQL
 * files. Yields one entry per (table, column).
 */
function detectSetNotNull(addedLines) {
  const out = [];
  // Track the most-recent ALTER TABLE prefix per file so multi-line ALTERs
  // (e.g. `ALTER TABLE foo \n ALTER COLUMN bar SET NOT NULL`) attribute
  // correctly. We do a simple per-file pass.
  const byFile = new Map();
  for (const entry of addedLines) {
    if (!entry.file.includes('shared/database/src/migrations/')) continue;
    if (!entry.file.endsWith('.sql')) continue;
    const list = byFile.get(entry.file) || [];
    list.push(entry.line);
    byFile.set(entry.file, list);
  }

  for (const [file, lines] of byFile) {
    let currentTable = null;
    for (const line of lines) {
      const tableMatch = line.match(/ALTER\s+TABLE\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
      if (tableMatch) currentTable = tableMatch[1];

      const colMatch = line.match(/ALTER\s+COLUMN\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+SET\s+NOT\s+NULL/i);
      if (colMatch && currentTable) {
        out.push({
          kind: 'notnull',
          table: currentTable,
          column: colMatch[1],
          source: `${file.split('/').pop()}: ALTER COLUMN ${colMatch[1]} SET NOT NULL`,
        });
      }
    }
  }
  return out;
}

/**
 * Detect FK additions: `ALTER TABLE foo ADD CONSTRAINT bar FOREIGN KEY (col) REFERENCES other(id)`
 */
function detectForeignKeys(addedLines) {
  const out = [];
  const re =
    /ALTER\s+TABLE\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ADD\s+CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+FOREIGN\s+KEY\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)\s+REFERENCES\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)/i;
  for (const { file, line } of addedLines) {
    if (!file.includes('shared/database/src/migrations/')) continue;
    const m = line.match(re);
    if (!m) continue;
    out.push({
      kind: 'fk',
      table: m[1],
      constraint: m[2],
      column: m[3],
      refTable: m[4],
      refColumn: m[5],
      source: `${file.split('/').pop()}: FK ${m[2]}`,
    });
  }
  return out;
}

/**
 * Detect CHECK constraint additions:
 *  - schema.ts:   `check('name', sql\`...\`)`
 *  - migration:   `ADD CONSTRAINT ... CHECK (...)`
 */
function detectChecks(addedLines) {
  const out = [];

  // schema.ts form
  const schemaRe = /check\(\s*['"`]([^'"`]+)['"`]\s*,\s*sql`([^`]*)`/g;
  // migration form
  const migRe =
    /ALTER\s+TABLE\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ADD\s+CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+CHECK\s*\((.*?)\)/i;

  for (const { file, line } of addedLines) {
    if (file.endsWith('schema.ts')) {
      let m;
      while ((m = schemaRe.exec(line)) !== null) {
        out.push({
          kind: 'check',
          name: m[1],
          predicate: sqlTemplateToPlain(m[2]),
          table: null,
          source: `schema.ts check('${m[1]}')`,
        });
      }
    } else if (file.includes('shared/database/src/migrations/')) {
      const m = line.match(migRe);
      if (m) {
        out.push({
          kind: 'check',
          name: m[2],
          predicate: m[3],
          table: m[1],
          source: `${file.split('/').pop()}: CHECK ${m[2]}`,
        });
      }
    }
  }
  return out;
}

/**
 * Detect `.unique()` chain calls on columns in schema.ts. These are inline
 * single-column unique constraints (`varchar('x').unique()`).
 *
 * Note: we deliberately only pick up calls that look like part of a column
 * builder chain — a `.unique()` immediately following a Drizzle type call.
 */
function detectInlineUnique(addedLines) {
  const out = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_]+\([^)]*\)[^,]*?\.unique\(\)/;
  for (const { file, line } of addedLines) {
    if (!file.endsWith('schema.ts')) continue;
    const m = line.match(re);
    if (!m) continue;
    out.push({
      kind: 'unique',
      name: `inline_${m[1]}_unique`,
      table: null,
      columns: [{ kind: 'col', name: m[1] }],
      where: null,
      source: `schema.ts inline .unique() on ${m[1]}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SELECT generation
// ---------------------------------------------------------------------------

function qualifiedTable(table) {
  return `"${SCHEMA_NAME}"."${table}"`;
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function formatColumnsForSelect(columns) {
  return columns.map((c) => (c.kind === 'col' ? quoteIdent(c.name) : `(${c.text})`)).join(', ');
}

/**
 * Build a `jsonb_build_object('col1', col1, 'col2', col2)` expression so
 * sample rows render with column names rather than f1/f2 anonymous tuple fields.
 */
function formatColumnsAsJsonObject(columns) {
  const pairs = columns
    .map((c, i) => {
      if (c.kind === 'col') {
        return `'${c.name.replace(/'/g, "''")}', ${quoteIdent(c.name)}`;
      }
      return `'expr_${i}', (${c.text})`;
    })
    .join(', ');
  return `jsonb_build_object(${pairs})`;
}

/**
 * Build the WHERE clause for a unique-constraint probe.
 *
 * PostgreSQL indexes are `NULLS DISTINCT` by default: two NULLs are never
 * considered equal, so a row whose key contains a NULL can never conflict with
 * any other row. For a multi-column key the exemption is per-ROW, not per-
 * column — equality against a NULL column yields NULL, so if ANY key column is
 * NULL that row is exempt. The probe must therefore count only rows where
 * EVERY key column is non-NULL.
 *
 * Without this guard, `GROUP BY <cols> HAVING count(*) > 1` collapses every
 * NULL-keyed row into one giant phantom "duplicate group" and the report
 * claims a constraint would be rejected when `CREATE UNIQUE INDEX` applies
 * cleanly. That produced a 72,599-row false positive on `shows.specialty_id`
 * — see the reproduction in #1984.
 *
 * A partial index's own predicate is ANDed with the guard, never replaced by
 * it: both must hold for a row to be a genuine conflict candidate.
 *
 * PG15+ `NULLS NOT DISTINCT` would invert this, making NULL-keyed rows
 * conflict after all. It cannot reach prod today: prod RDS is PG14, and
 * `NULLS NOT DISTINCT` is a `42601 syntax error` there — the `migrate-dryrun`
 * gate is precisely what catches it (BS#1424, where PR #1414 tried exactly
 * this and was rejected). The detector also only sources unique constraints
 * from drizzle `uniqueIndex(...)` / `.unique()` in schema.ts, neither of which
 * emits that clause. If prod is ever upgraded to PG15+, this guard must become
 * conditional on the index's null-handling — `docs/migrations.md`'s
 * `dev-prod-pg-version-skew` rule is the checklist that should bring you here.
 */
function buildUniqueWhereClause(constraint) {
  const predicates = constraint.columns.map((c) =>
    c.kind === 'col' ? `${quoteIdent(c.name)} IS NOT NULL` : `(${c.text}) IS NOT NULL`
  );
  if (constraint.where) predicates.unshift(`(${constraint.where})`);
  return `WHERE ${predicates.join(' AND ')}`;
}

/**
 * Build the SELECT that finds violating rows for a given constraint.
 * Returns null if we can't generate a sensible query (e.g. unknown table).
 */
export function buildSelect(constraint) {
  switch (constraint.kind) {
    case 'unique': {
      if (!constraint.table || constraint.columns.length === 0) return null;
      const cols = formatColumnsForSelect(constraint.columns);
      const keys = formatColumnsAsJsonObject(constraint.columns);
      const whereClause = buildUniqueWhereClause(constraint);
      return {
        sql: `
          SELECT count(*)::bigint AS dup_groups,
                 sum(c)::bigint AS total_rows,
                 (
                   SELECT array_agg(jsonb_build_object('keys', keys, 'rows', cnt))
                   FROM (
                     SELECT ${keys} AS keys, count(*) AS cnt
                     FROM ${qualifiedTable(constraint.table)}
                     ${whereClause}
                     GROUP BY ${cols}
                     HAVING count(*) > 1
                     ORDER BY count(*) DESC
                     LIMIT ${SAMPLE_LIMIT}
                   ) s
                 ) AS samples
          FROM (
            SELECT count(*) AS c
            FROM ${qualifiedTable(constraint.table)}
            ${whereClause}
            GROUP BY ${cols}
            HAVING count(*) > 1
          ) g
        `,
        kind: 'unique',
      };
    }

    case 'notnull': {
      if (!constraint.table || !constraint.column) return null;
      return {
        sql: `
          SELECT count(*)::bigint AS bad_rows,
                 (
                   SELECT array_agg(id_text)
                   FROM (
                     SELECT (CASE
                       WHEN to_regclass('${SCHEMA_NAME}.${constraint.table}') IS NOT NULL THEN
                         (SELECT 'row#' || row_number() OVER ()) END) AS id_text
                     FROM ${qualifiedTable(constraint.table)}
                     WHERE ${quoteIdent(constraint.column)} IS NULL
                     LIMIT ${SAMPLE_LIMIT}
                   ) s
                 ) AS samples
          FROM ${qualifiedTable(constraint.table)}
          WHERE ${quoteIdent(constraint.column)} IS NULL
        `,
        kind: 'notnull',
      };
    }

    case 'check': {
      if (!constraint.table || !constraint.predicate) return null;
      // Violating rows are rows where the predicate evaluates to FALSE
      // (NULL is treated as satisfying the constraint, per SQL semantics).
      return {
        sql: `
          SELECT count(*)::bigint AS bad_rows
          FROM ${qualifiedTable(constraint.table)}
          WHERE NOT (${constraint.predicate})
        `,
        kind: 'check',
      };
    }

    case 'fk': {
      if (!constraint.table || !constraint.column || !constraint.refTable || !constraint.refColumn) {
        return null;
      }
      return {
        sql: `
          SELECT count(*)::bigint AS bad_rows
          FROM ${qualifiedTable(constraint.table)} child
          WHERE child.${quoteIdent(constraint.column)} IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${qualifiedTable(constraint.refTable)} parent
              WHERE parent.${quoteIdent(constraint.refColumn)} = child.${quoteIdent(constraint.column)}
            )
        `,
        kind: 'fk',
      };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Comment rendering
// ---------------------------------------------------------------------------

function renderConstraintHeader(c) {
  switch (c.kind) {
    case 'unique': {
      const colText = c.columns.map((col) => (col.kind === 'col' ? col.name : col.text)).join(', ');
      const whereText = c.where ? ` WHERE ${c.where}` : '';
      const tablePart = c.table ? ` on \`${c.table}\`` : '';
      return `\`UNIQUE (${colText})${whereText}\`${tablePart} (\`${c.name}\`)`;
    }
    case 'notnull':
      return `\`${c.column} NOT NULL\` on \`${c.table}\``;
    case 'check':
      return `\`CHECK (${c.predicate})\`${c.table ? ` on \`${c.table}\`` : ''} (\`${c.name}\`)`;
    case 'fk':
      return `\`FOREIGN KEY (${c.column}) REFERENCES ${c.refTable}(${c.refColumn})\` on \`${c.table}\``;
    default:
      return '(unknown)';
  }
}

function renderUniqueResult(constraint, row) {
  const dupGroups = Number(row.dup_groups ?? 0);
  const totalRows = Number(row.total_rows ?? 0);
  const samples = row.samples ?? [];
  if (dupGroups === 0) {
    return `- OK — ${renderConstraintHeader(constraint)}: 0 duplicate groups`;
  }
  const conflictRows = totalRows; // total rows participating in dup groups
  const sampleTable =
    samples.length > 0
      ? '\n\nSample groups:\n\n| keys | rows |\n|---|---|\n' +
        samples.map((s) => `| \`${JSON.stringify(redactSampleKeys(s.keys))}\` | ${s.rows} |`).join('\n')
      : '';
  return [
    `- WARNING — ${renderConstraintHeader(constraint)}`,
    `  - ${dupGroups} duplicate groups would violate this constraint`,
    `  - ${conflictRows} rows would need cleanup before applying`,
    sampleTable,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderScalarResult(constraint, row) {
  const bad = Number(row.bad_rows ?? 0);
  if (bad === 0) {
    return `- OK — ${renderConstraintHeader(constraint)}: 0 violating rows`;
  }
  return `- WARNING — ${renderConstraintHeader(constraint)}: ${bad} rows would violate this constraint`;
}

function renderResult(constraint, queryResult, row) {
  if (queryResult.kind === 'unique') return renderUniqueResult(constraint, row);
  return renderScalarResult(constraint, row);
}

function renderUnverifiable(constraint, reason) {
  return `- _${reason}_ — ${renderConstraintHeader(constraint)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function commentEnvelope(body) {
  return `${COMMENT_MARKER}\n## Schema constraint shape report\n\n${body}\n`;
}

function unavailableComment(reason) {
  return commentEnvelope(`_data-shape probe unavailable, manual check required (${reason})_`);
}

/**
 * Resolve where to probe. Discrete params are preferred over a URL because the
 * `migrate-dryrun` caller already holds the sandbox credentials as separate
 * GitHub secrets, and assembling them into a URL in shell would mean
 * percent-encoding a secret password in a `run:` block.
 *
 * Returns null when nothing is configured — the caller renders the
 * "probe unavailable" comment and still exits 0.
 */
function resolveProbeTarget() {
  const url = process.env.SHAPE_PROBE_DATABASE_URL || process.env.STAGING_DATABASE_URL_RO;
  if (url) return { kind: 'url', value: url };

  const host = process.env.SHAPE_PROBE_DB_HOST;
  if (host) {
    return {
      kind: 'options',
      value: {
        host,
        port: Number(process.env.SHAPE_PROBE_DB_PORT || 5432),
        database: process.env.SHAPE_PROBE_DB_NAME,
        username: process.env.SHAPE_PROBE_DB_USERNAME,
        password: process.env.SHAPE_PROBE_DB_PASSWORD,
      },
    };
  }
  return null;
}

function erroredComment(message) {
  return commentEnvelope(`_data-shape report errored: ${message}; manual check required_`);
}

async function main() {
  const diff = loadDiff();
  if (!diff.trim()) {
    console.log(commentEnvelope('_no schema or migration changes detected in this PR_'));
    return;
  }

  const addedLines = iterateAddedLines(diff);
  if (addedLines.length === 0) {
    console.log(commentEnvelope('_no added lines in schema or migration files_'));
    return;
  }

  // Read the full schema text so we can resolve uniqueIndex names to tables.
  let schemaText = '';
  try {
    schemaText = readFileSync('shared/database/src/schema.ts', 'utf8');
  } catch {
    // not fatal — we just won't be able to attribute schema.ts uniqueIndex
    // calls to a table.
  }

  const constraints = [
    ...detectUniqueIndexes(addedLines, schemaText),
    ...detectInlineUnique(addedLines),
    ...detectSetNotNull(addedLines),
    ...detectChecks(addedLines),
    ...detectForeignKeys(addedLines),
  ];

  if (constraints.length === 0) {
    console.log(
      commentEnvelope('_no new constraints detected in this diff (uniqueIndex, .unique(), SET NOT NULL, CHECK, FK)_')
    );
    return;
  }

  const target = resolveProbeTarget();
  if (!target) {
    const list = constraints.map((c) => `- ${renderConstraintHeader(c)}`).join('\n');
    console.log(
      commentEnvelope(
        `_data-shape probe unavailable, manual check required (no probe target configured — \`SHAPE_PROBE_DB_HOST\` / \`SHAPE_PROBE_DATABASE_URL\` unset)_\n\nDetected new constraints:\n\n${list}`
      )
    );
    return;
  }

  const clientOptions = {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    // The probe target is a restore of a prod snapshot; NOTICE noise from it
    // is not our signal. Mirrors scripts/dryrun-migrate.mjs.
    onnotice: () => {},
    // Keep statement_timeout server-side. Each query also wraps in
    // `SET LOCAL statement_timeout` via a transaction below.
  };

  let sql;
  try {
    sql =
      target.kind === 'url' ? postgres(target.value, clientOptions) : postgres({ ...target.value, ...clientOptions });
  } catch (err) {
    console.log(unavailableComment(`could not initialize Postgres client: ${err.message}`));
    return;
  }

  const renderedLines = [];
  let probeFailed = false;

  for (const constraint of constraints) {
    const built = buildSelect(constraint);
    if (!built) {
      renderedLines.push(renderUnverifiable(constraint, 'could not derive SELECT'));
      continue;
    }
    try {
      const rows = await sql.begin(async (tx) => {
        // READ ONLY first: PostgreSQL only accepts `SET TRANSACTION` before the
        // transaction's first query. The probe has no business writing to a
        // restore of prod, and this makes that structural rather than implied.
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx.unsafe(`SET LOCAL statement_timeout = ${PER_QUERY_TIMEOUT_MS}`);
        return tx.unsafe(built.sql);
      });
      const row = rows[0] ?? {};
      renderedLines.push(renderResult(constraint, built, row));
    } catch (err) {
      probeFailed = true;
      renderedLines.push(renderUnverifiable(constraint, `query failed: ${truncate(err.message, 200)}`));
    }
  }

  try {
    await sql.end({ timeout: 5 });
  } catch {
    // ignore — we already have results
  }

  const headerLines = [
    `Probed: \`${SNAPSHOT_LABEL}\` (schema \`${SCHEMA_NAME}\`), before the pending migrations were applied.`,
    '',
    'This PR adds:',
    '',
    ...renderedLines,
  ];

  if (probeFailed) {
    headerLines.push('', '_one or more probes failed; see above. The check status is non-blocking._');
  } else if (renderedLines.every((l) => l.startsWith('- OK'))) {
    headerLines.push('', 'OK — no rows would violate the new constraints.');
  } else {
    headerLines.push(
      '',
      'WARNING — at least one constraint above has rows that would block the apply. Either pre-clean or rework before merge.'
    );
  }

  console.log(commentEnvelope(headerLines.join('\n')));
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Only run the CLI when executed directly. The module already exported
// COMMENT_MARKER, but an unconditional `main()` at import time contradicted
// that — importing the file to test its pure SQL-generation would have run the
// whole report. Guarding it lets `buildSelect` be exercised against a real
// PostgreSQL from a harness while `node scripts/schema-shape-report.mjs` keeps
// behaving exactly as before.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    // Last-resort safety net: never crash the workflow.
    console.log(erroredComment(truncate(String(err && err.message ? err.message : err), 200)));
  });
}
