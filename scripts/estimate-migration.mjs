#!/usr/bin/env node

/**
 * Migration Runtime Estimator
 *
 * Estimates the duration of SQL migrations based on table sizes and operation types.
 * Queries pg_stat_user_tables for row counts and applies cost models.
 *
 * Usage:
 *   node scripts/estimate-migration.mjs [options] [migration-file...]
 *
 * Options:
 *   --all                  Estimate all pending migrations
 *   --output=json          Output as JSON (for CI)
 *   --output=table         Output as formatted table (default)
 *   --threshold=SECONDS    Warn if estimate exceeds threshold (default: 60)
 *   --connection=URL       Database connection URL
 *
 * Environment:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD - Database connection
 *
 * Examples:
 *   node scripts/estimate-migration.mjs 0027_add-performance-indexes.sql
 *   node scripts/estimate-migration.mjs --all --output=json --threshold=30
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'shared/database/src/migrations');

// Cost model for different operations (in milliseconds)
// These are rough estimates based on typical PostgreSQL performance
const COST_MODEL = {
  // Index operations
  CREATE_INDEX: {
    base: 100, // Base overhead in ms
    perRow: 0.1, // ms per row
    description: 'Standard index creation (locks table for writes)',
  },
  CREATE_INDEX_CONCURRENTLY: {
    base: 200,
    perRow: 0.15, // Slightly slower due to snapshot management
    description: 'Concurrent index (no locks, higher overhead)',
  },
  CREATE_UNIQUE_INDEX: {
    base: 150,
    perRow: 0.12,
    description: 'Unique index (includes uniqueness check)',
  },
  DROP_INDEX: {
    base: 10,
    perRow: 0,
    description: 'Drop index (instant)',
  },

  // Table operations
  CREATE_TABLE: {
    base: 50,
    perRow: 0,
    description: 'Create empty table',
  },
  DROP_TABLE: {
    base: 50,
    perRow: 0.01, // Some overhead for large tables
    description: 'Drop table',
  },

  // Column operations
  ADD_COLUMN_NULLABLE: {
    base: 50,
    perRow: 0, // Nullable columns are instant (metadata only)
    description: 'Add nullable column (instant)',
  },
  ADD_COLUMN_NOT_NULL_DEFAULT: {
    base: 100,
    perRow: 0.05, // Must update each row
    description: 'Add NOT NULL column with default',
  },
  DROP_COLUMN: {
    base: 50,
    perRow: 0, // Metadata operation
    description: 'Drop column (metadata only)',
  },
  ALTER_COLUMN_TYPE: {
    base: 100,
    perRow: 0.1, // Must rewrite data
    description: 'Change column type',
  },

  // Constraint operations
  ADD_CONSTRAINT_FK: {
    base: 100,
    perRow: 0.02, // Validates existing rows
    description: 'Add foreign key constraint',
  },
  ADD_CONSTRAINT_CHECK: {
    base: 100,
    perRow: 0.01,
    description: 'Add check constraint',
  },
  DROP_CONSTRAINT: {
    base: 20,
    perRow: 0,
    description: 'Drop constraint (instant)',
  },

  // Data operations
  UPDATE: {
    base: 100,
    perRow: 0.05,
    description: 'Update rows',
  },
  DELETE: {
    base: 100,
    perRow: 0.02,
    description: 'Delete rows',
  },

  // Type operations
  CREATE_TYPE: {
    base: 20,
    perRow: 0,
    description: 'Create enum type',
  },
  ALTER_TYPE_ADD_VALUE: {
    base: 20,
    perRow: 0,
    description: 'Add enum value',
  },
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    all: false,
    output: 'table',
    threshold: 60,
    connectionUrl: null,
    files: [],
  };

  for (const arg of args) {
    if (arg === '--all') {
      options.all = true;
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    } else if (arg.startsWith('--threshold=')) {
      options.threshold = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--connection=')) {
      options.connectionUrl = arg.split('=')[1];
    } else if (!arg.startsWith('-')) {
      options.files.push(arg);
    }
  }

  return options;
}

// Build database connection configuration
function getDbConfig(options) {
  if (options.connectionUrl) {
    return options.connectionUrl;
  }

  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const database = process.env.DB_NAME || 'wxyc_db';
  const username = process.env.DB_USERNAME || 'postgres';
  const password = process.env.DB_PASSWORD || '';

  return `postgres://${username}:${password}@${host}:${port}/${database}`;
}

// Get table row counts from database
async function getTableStats(connectionUrl) {
  try {
    // Dynamic import of postgres
    const postgres = (await import('postgres')).default;
    const sql = postgres(connectionUrl, { max: 1 });

    const stats = await sql`
      SELECT
        schemaname || '.' || relname as table_name,
        n_live_tup as row_count
      FROM pg_stat_user_tables
      WHERE schemaname IN ('public', 'wxyc_schema')
      ORDER BY n_live_tup DESC
    `;

    await sql.end();

    // Convert to map
    const statsMap = new Map();
    for (const row of stats) {
      statsMap.set(row.table_name, parseInt(row.row_count, 10));
      // Also add without schema prefix for easier matching
      const tableName = row.table_name.split('.')[1];
      if (tableName) {
        statsMap.set(tableName, parseInt(row.row_count, 10));
      }
    }

    return statsMap;
  } catch (error) {
    console.error(`Warning: Could not connect to database: ${error.message}`);
    console.error('Using default estimates (1000 rows per table)');
    return null;
  }
}

// Extract table name from SQL statement
function extractTableName(sql) {
  // Match various patterns for table names
  const patterns = [
    /(?:ON|FROM|INTO|UPDATE|TABLE)\s+("[^"]+"\."[^"]+")/i,
    /(?:ON|FROM|INTO|UPDATE|TABLE)\s+("[^"]+")/i,
    /(?:ON|FROM|INTO|UPDATE|TABLE)\s+(\S+)/i,
  ];

  for (const pattern of patterns) {
    const match = sql.match(pattern);
    if (match) {
      // Clean up the table name
      return match[1].replace(/"/g, '').split('.').pop();
    }
  }
  return null;
}

// Parse migration and identify operations
function parseMigration(content) {
  const operations = [];

  // Split by statement breakpoint or semicolons
  let statements;
  if (content.includes('--> statement-breakpoint')) {
    statements = content.split(/--> statement-breakpoint/);
  } else {
    statements = content.split(/;(?=\s*(?:--|ALTER|CREATE|DROP|UPDATE|DELETE|INSERT|$))/i);
  }

  for (const stmt of statements) {
    const sql = stmt
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join(' ')
      .trim();
    if (!sql) continue;

    const upperSql = sql.toUpperCase();
    const tableName = extractTableName(sql);

    // Determine operation type
    if (/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql)) {
      operations.push({
        type: 'CREATE_INDEX_CONCURRENTLY',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/CREATE\s+UNIQUE\s+INDEX/i.test(sql)) {
      operations.push({
        type: 'CREATE_UNIQUE_INDEX',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/CREATE\s+INDEX/i.test(sql)) {
      operations.push({
        type: 'CREATE_INDEX',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/DROP\s+INDEX/i.test(sql)) {
      operations.push({
        type: 'DROP_INDEX',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/CREATE\s+TABLE/i.test(sql)) {
      operations.push({
        type: 'CREATE_TABLE',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/DROP\s+TABLE/i.test(sql)) {
      operations.push({
        type: 'DROP_TABLE',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/ADD\s+COLUMN.*NOT\s+NULL.*DEFAULT/i.test(sql) || /ADD\s+COLUMN.*DEFAULT.*NOT\s+NULL/i.test(sql)) {
      operations.push({
        type: 'ADD_COLUMN_NOT_NULL_DEFAULT',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/ADD\s+COLUMN/i.test(sql)) {
      operations.push({
        type: 'ADD_COLUMN_NULLABLE',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/DROP\s+COLUMN/i.test(sql)) {
      operations.push({
        type: 'DROP_COLUMN',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/ALTER\s+COLUMN.*SET\s+DATA\s+TYPE/i.test(sql) || /ALTER\s+COLUMN.*TYPE/i.test(sql)) {
      operations.push({
        type: 'ALTER_COLUMN_TYPE',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/ADD\s+CONSTRAINT.*FOREIGN\s+KEY/i.test(sql)) {
      operations.push({
        type: 'ADD_CONSTRAINT_FK',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/ADD\s+CONSTRAINT/i.test(sql)) {
      operations.push({
        type: 'ADD_CONSTRAINT_CHECK',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/DROP\s+CONSTRAINT/i.test(sql)) {
      operations.push({
        type: 'DROP_CONSTRAINT',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/^UPDATE\s/i.test(sql)) {
      operations.push({
        type: 'UPDATE',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/^DELETE\s/i.test(sql)) {
      operations.push({
        type: 'DELETE',
        table: tableName,
        sql: sql.substring(0, 80),
      });
    } else if (/CREATE\s+TYPE/i.test(sql)) {
      operations.push({
        type: 'CREATE_TYPE',
        table: null,
        sql: sql.substring(0, 80),
      });
    } else if (/ALTER\s+TYPE.*ADD\s+VALUE/i.test(sql)) {
      operations.push({
        type: 'ALTER_TYPE_ADD_VALUE',
        table: null,
        sql: sql.substring(0, 80),
      });
    }
  }

  return operations;
}

// Estimate duration for a single operation
function estimateOperation(operation, tableStats, defaultRowCount = 1000) {
  const cost = COST_MODEL[operation.type];
  if (!cost) {
    return { ms: 100, warning: `Unknown operation type: ${operation.type}` };
  }

  let rowCount = defaultRowCount;
  if (operation.table && tableStats) {
    rowCount = tableStats.get(operation.table) || defaultRowCount;
  }

  const ms = cost.base + cost.perRow * rowCount;

  const result = {
    ms,
    rowCount,
    description: cost.description,
  };

  // Add warnings for slow operations
  if (ms > 5000) {
    result.warning = `${operation.table}: ${rowCount.toLocaleString()} rows, ~${(ms / 1000).toFixed(1)}s`;
  }

  return result;
}

// Estimate total migration duration
function estimateMigration(filePath, tableStats) {
  const content = fs.readFileSync(filePath, 'utf8');
  const operations = parseMigration(content);

  let totalMs = 0;
  const warnings = [];
  const operationDetails = [];

  for (const op of operations) {
    const estimate = estimateOperation(op, tableStats);
    totalMs += estimate.ms;

    operationDetails.push({
      type: op.type,
      table: op.table,
      estimatedMs: Math.round(estimate.ms),
      rowCount: estimate.rowCount,
      sql: op.sql,
    });

    if (estimate.warning) {
      warnings.push(estimate.warning);
    }
  }

  return {
    file: path.basename(filePath),
    operations: operationDetails,
    totalOperations: operations.length,
    estimatedMs: Math.round(totalMs),
    estimatedSeconds: Math.round(totalMs / 1000 * 10) / 10,
    warnings,
  };
}

// Format output as table
function formatTable(estimates, threshold) {
  let output = '\nMigration Duration Estimates\n';
  output += '═'.repeat(70) + '\n\n';

  for (const est of estimates) {
    const exceedsThreshold = est.estimatedSeconds > threshold;
    const icon = exceedsThreshold ? '⚠️ ' : '✅ ';

    output += `${icon}${est.file}\n`;
    output += `   Operations: ${est.totalOperations}\n`;
    output += `   Estimated:  ${est.estimatedSeconds}s\n`;

    if (est.warnings.length > 0) {
      output += `   Warnings:\n`;
      for (const w of est.warnings) {
        output += `     - ${w}\n`;
      }
    }

    if (est.operations.length > 0 && est.operations.length <= 10) {
      output += `   Operations breakdown:\n`;
      for (const op of est.operations) {
        const rowInfo = op.rowCount ? ` (${op.rowCount.toLocaleString()} rows)` : '';
        output += `     - ${op.type}: ~${op.estimatedMs}ms${rowInfo}\n`;
      }
    }

    output += '\n';
  }

  // Summary
  const totalSeconds = estimates.reduce((sum, e) => sum + e.estimatedSeconds, 0);
  const hasThresholdViolations = estimates.some((e) => e.estimatedSeconds > threshold);

  output += '─'.repeat(70) + '\n';
  output += `Total estimated time: ${totalSeconds.toFixed(1)}s\n`;
  output += `Threshold: ${threshold}s\n`;

  if (hasThresholdViolations) {
    output += '\n⚠️  Some migrations exceed the threshold. Consider:\n';
    output += '   - Running during low-traffic periods\n';
    output += '   - Using CONCURRENTLY for index creation\n';
    output += '   - Splitting into smaller migrations\n';
  }

  return output;
}

// Format output as JSON
function formatJson(estimates, threshold) {
  const hasThresholdViolations = estimates.some((e) => e.estimatedSeconds > threshold);

  return JSON.stringify(
    {
      estimates,
      summary: {
        totalMigrations: estimates.length,
        totalEstimatedSeconds: estimates.reduce((sum, e) => sum + e.estimatedSeconds, 0),
        threshold,
        exceedsThreshold: hasThresholdViolations,
        warnings: estimates.flatMap((e) => e.warnings),
      },
    },
    null,
    2
  );
}

// Get migration files
function getMigrationFiles(options) {
  if (options.files.length > 0) {
    return options.files.map((f) => {
      if (!f.includes('/')) {
        return path.join(MIGRATIONS_DIR, f);
      }
      return path.resolve(process.cwd(), f);
    });
  }

  if (options.all) {
    return fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !f.includes('.rollback'))
      .map((f) => path.join(MIGRATIONS_DIR, f));
  }

  return [];
}

// Main execution
async function main() {
  const options = parseArgs();
  const files = getMigrationFiles(options);

  if (files.length === 0) {
    console.log('Usage: node scripts/estimate-migration.mjs [--all] [--output=json] [--threshold=60] [migration-file...]');
    console.log('\nNo migration files specified.');
    process.exit(0);
  }

  // Get table statistics from database
  const connectionUrl = getDbConfig(options);
  const tableStats = await getTableStats(connectionUrl);

  // Estimate each migration
  const estimates = [];
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }
    estimates.push(estimateMigration(filePath, tableStats));
  }

  // Output results
  if (options.output === 'json') {
    console.log(formatJson(estimates, options.threshold));
  } else {
    console.log(formatTable(estimates, options.threshold));
  }

  // Exit with error if threshold exceeded (for CI)
  const exceedsThreshold = estimates.some((e) => e.estimatedSeconds > options.threshold);
  if (exceedsThreshold && options.output === 'json') {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
