#!/usr/bin/env node

/**
 * Migration Rollback Generator
 *
 * Generates rollback SQL scripts for migration files by parsing the forward
 * migration and creating inverse operations.
 *
 * Usage:
 *   node scripts/generate-rollback.mjs [options] [migration-file]
 *
 * Options:
 *   --all       Generate rollbacks for all migrations without existing rollbacks
 *   --force     Overwrite existing rollback files
 *   --dry-run   Print rollback SQL without writing files
 *
 * Examples:
 *   node scripts/generate-rollback.mjs 0027_add-performance-indexes.sql
 *   node scripts/generate-rollback.mjs --all
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'shared/database/src/migrations');
const ROLLBACKS_DIR = path.join(MIGRATIONS_DIR, 'rollbacks');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    all: false,
    force: false,
    dryRun: false,
    files: [],
  };

  for (const arg of args) {
    if (arg === '--all') {
      options.all = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (!arg.startsWith('-')) {
      options.files.push(arg);
    }
  }

  return options;
}

// Extract table/index/type name from SQL statement
function extractName(sql, keyword) {
  // Match quoted or unquoted names after the keyword
  // Handles: "schema"."table", schema.table, "table", table
  const patterns = [
    // "schema"."name" - properly capture both parts
    new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?("[^"]+"\\.?"[^"]+")`, 'i'),
    // "schema"."name" without outer quotes
    new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?("[^"]+"\\."[^"]+")`, 'i'),
    // schema."name"
    new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?([^\\s.]+\\."[^"]+")`, 'i'),
    // "name" (quoted, no schema)
    new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?("[^"]+")(?![.])`, 'i'),
    // unquoted schema.name
    new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?([^\\s.]+\\.[^\\s(]+)`, 'i'),
    // name (simple, unquoted)
    new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?([^\\s("]+)`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = sql.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Avoid returning just the schema name
      if (name.includes('.') || !sql.includes(`${name}."`)) {
        return name;
      }
    }
  }
  return null;
}

// Extract column name from ADD COLUMN statement
function extractColumnInfo(sql) {
  // ALTER TABLE "schema"."table" ADD COLUMN "column" type...
  // Also handles: ALTER TABLE "table" ADD COLUMN "column" type...
  const tablePatterns = [
    /ALTER\s+TABLE\s+("[^"]+"\."[^"]+")\s+ADD\s+COLUMN/i, // "schema"."table"
    /ALTER\s+TABLE\s+("[^"]+")\s+ADD\s+COLUMN/i, // "table"
    /ALTER\s+TABLE\s+(\S+)\s+ADD\s+COLUMN/i, // unquoted
  ];

  let tableName = null;
  for (const pattern of tablePatterns) {
    const match = sql.match(pattern);
    if (match) {
      tableName = match[1];
      break;
    }
  }

  // Match quoted column name like "capabilities" or unquoted like capabilities
  const columnMatch = sql.match(/ADD\s+COLUMN\s+("[^"]+"|[^\s]+)/i);

  if (tableName && columnMatch) {
    return {
      table: tableName,
      column: columnMatch[1],
    };
  }
  return null;
}

// Extract constraint info
function extractConstraintInfo(sql) {
  // ALTER TABLE ... ADD CONSTRAINT "name" ...
  const tableMatch = sql.match(/ALTER\s+TABLE\s+("?[^"]+?"?\\.?"?[^"]+?"?)\s+ADD\s+CONSTRAINT/i);
  const constraintMatch = sql.match(/ADD\s+CONSTRAINT\s+("?[^"\s]+?"?)/i);

  if (tableMatch && constraintMatch) {
    return {
      table: tableMatch[1],
      constraint: constraintMatch[1],
    };
  }
  return null;
}

// Determine risk level based on operation type
function getRiskLevel(operations) {
  if (operations.some((op) => op.type === 'DROP TABLE' || op.type === 'DROP COLUMN')) {
    return 'HIGH';
  }
  if (
    operations.some((op) => op.type === 'DROP CONSTRAINT' || op.type === 'DROP TYPE' || op.type === 'ALTER COLUMN')
  ) {
    return 'MEDIUM';
  }
  return 'LOW';
}

// Check if rollback causes data loss
function hasDataLoss(operations) {
  return operations.some((op) => op.type === 'DROP TABLE' || op.type === 'DROP COLUMN');
}

// Parse migration and generate rollback operations
function generateRollbackOperations(content) {
  const operations = [];

  // Split by statement breakpoint marker, or by semicolons if no markers
  let statements;
  if (content.includes('--> statement-breakpoint')) {
    statements = content.split(/--> statement-breakpoint/);
  } else {
    // Split by semicolons, preserving the semicolon context
    statements = content.split(/;(?=\s*(?:--|ALTER|CREATE|DROP|UPDATE|DELETE|INSERT|$))/i).map((s) => s + ';');
  }

  for (const stmt of statements) {
    // Remove comment lines for pattern matching
    const withoutComments = stmt
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const trimmed = withoutComments.trim();
    if (!trimmed || trimmed === ';') continue;

    // CREATE TABLE -> DROP TABLE
    if (/CREATE\s+TABLE/i.test(trimmed)) {
      const tableName = extractName(trimmed, 'TABLE');
      if (tableName) {
        operations.push({
          type: 'DROP TABLE',
          sql: `DROP TABLE IF EXISTS ${tableName} CASCADE;`,
          comment: `Drops table ${tableName} (DATA LOSS)`,
        });
      }
    }

    // CREATE INDEX -> DROP INDEX
    else if (/CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(trimmed)) {
      const indexName = extractName(trimmed, 'INDEX');
      if (indexName) {
        operations.push({
          type: 'DROP INDEX',
          sql: `DROP INDEX IF EXISTS ${indexName};`,
          comment: `Drops index ${indexName}`,
        });
      }
    }

    // CREATE TYPE -> DROP TYPE
    else if (/CREATE\s+TYPE/i.test(trimmed)) {
      const typeName = extractName(trimmed, 'TYPE');
      if (typeName) {
        operations.push({
          type: 'DROP TYPE',
          sql: `DROP TYPE IF EXISTS ${typeName} CASCADE;`,
          comment: `Drops type ${typeName}`,
        });
      }
    }

    // ADD COLUMN -> DROP COLUMN
    else if (/ALTER\s+TABLE.*ADD\s+COLUMN/i.test(trimmed)) {
      const info = extractColumnInfo(trimmed);
      if (info) {
        operations.push({
          type: 'DROP COLUMN',
          sql: `ALTER TABLE ${info.table} DROP COLUMN IF EXISTS ${info.column};`,
          comment: `Drops column ${info.column} from ${info.table} (DATA LOSS)`,
        });
      }
    }

    // ADD CONSTRAINT -> DROP CONSTRAINT
    else if (/ALTER\s+TABLE.*ADD\s+CONSTRAINT/i.test(trimmed)) {
      const info = extractConstraintInfo(trimmed);
      if (info) {
        operations.push({
          type: 'DROP CONSTRAINT',
          sql: `ALTER TABLE ${info.table} DROP CONSTRAINT IF EXISTS ${info.constraint};`,
          comment: `Drops constraint ${info.constraint}`,
        });
      }
    }

    // ALTER COLUMN SET NOT NULL -> DROP NOT NULL
    else if (/ALTER\s+COLUMN.*SET\s+NOT\s+NULL/i.test(trimmed)) {
      const tableMatch = trimmed.match(/ALTER\s+TABLE\s+("?[^"]+?"?\\.?"?[^"]+?"?)/i);
      const columnMatch = trimmed.match(/ALTER\s+COLUMN\s+("?[^"\s]+?"?)/i);
      if (tableMatch && columnMatch) {
        operations.push({
          type: 'ALTER COLUMN',
          sql: `ALTER TABLE ${tableMatch[1]} ALTER COLUMN ${columnMatch[1]} DROP NOT NULL;`,
          comment: `Removes NOT NULL constraint from ${columnMatch[1]}`,
        });
      }
    }

    // ALTER COLUMN SET DEFAULT -> DROP DEFAULT
    else if (/ALTER\s+COLUMN.*SET\s+DEFAULT/i.test(trimmed)) {
      const tableMatch = trimmed.match(/ALTER\s+TABLE\s+("?[^"]+?"?\\.?"?[^"]+?"?)/i);
      const columnMatch = trimmed.match(/ALTER\s+COLUMN\s+("?[^"\s]+?"?)/i);
      if (tableMatch && columnMatch) {
        operations.push({
          type: 'ALTER COLUMN',
          sql: `ALTER TABLE ${tableMatch[1]} ALTER COLUMN ${columnMatch[1]} DROP DEFAULT;`,
          comment: `Removes default from ${columnMatch[1]}`,
        });
      }
    }

    // Note: Some operations cannot be easily reversed:
    // - DROP TABLE (data is gone)
    // - DROP COLUMN (data is gone)
    // - UPDATE statements (data transformed)
    // - TRUNCATE (data is gone)
    // For these, we add a warning comment
    else if (/DROP\s+TABLE/i.test(trimmed) || /DROP\s+COLUMN/i.test(trimmed)) {
      operations.push({
        type: 'MANUAL',
        sql: `-- WARNING: Original migration dropped data that cannot be restored\n-- Original: ${trimmed.slice(0, 100)}...`,
        comment: 'Requires manual data restoration from backup',
      });
    } else if (/UPDATE\s+/i.test(trimmed)) {
      operations.push({
        type: 'MANUAL',
        sql: `-- WARNING: Original migration transformed data\n-- Original: ${trimmed.slice(0, 100)}...`,
        comment: 'Requires manual data restoration or reverse transformation',
      });
    }
  }

  return operations;
}

// Generate rollback file content
function generateRollbackContent(migrationName, content) {
  const operations = generateRollbackOperations(content);

  if (operations.length === 0) {
    return null;
  }

  const riskLevel = getRiskLevel(operations);
  const dataLoss = hasDataLoss(operations);

  let rollback = `-- Rollback: ${migrationName.replace('.sql', '')}
-- Original migration: ${migrationName}
-- Risk level: ${riskLevel}
-- Data loss: ${dataLoss ? 'YES' : 'NO'}
-- Generated: ${new Date().toISOString().split('T')[0]}
--
-- Description:
-- Reverses the changes made by ${migrationName}
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
${riskLevel === 'HIGH' ? '-- [ ] Maintenance window scheduled\n' : ''}
-- Operations:
`;

  for (const op of operations) {
    rollback += `-- - ${op.comment}\n`;
  }

  rollback += '\n-- BEGIN ROLLBACK\n\n';

  for (const op of operations) {
    rollback += `-- ${op.comment}\n`;
    rollback += `${op.sql}\n\n`;
  }

  rollback += '-- END ROLLBACK\n';

  return rollback;
}

// Get migration files to process
function getMigrationFiles(options) {
  if (options.files.length > 0) {
    return options.files.map((f) => {
      // If just a filename, look in migrations dir
      if (!f.includes('/')) {
        return path.join(MIGRATIONS_DIR, f);
      }
      return path.resolve(process.cwd(), f);
    });
  }

  if (options.all) {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !f.includes('.rollback'));

    // If not forcing, filter out migrations that already have rollbacks
    if (!options.force) {
      return files
        .filter((f) => {
          const rollbackName = f.replace('.sql', '.rollback.sql');
          return !fs.existsSync(path.join(ROLLBACKS_DIR, rollbackName));
        })
        .map((f) => path.join(MIGRATIONS_DIR, f));
    }

    return files.map((f) => path.join(MIGRATIONS_DIR, f));
  }

  return [];
}

// Main execution
function main() {
  const options = parseArgs();

  // Ensure rollbacks directory exists
  if (!fs.existsSync(ROLLBACKS_DIR)) {
    fs.mkdirSync(ROLLBACKS_DIR, { recursive: true });
  }

  const files = getMigrationFiles(options);

  if (files.length === 0) {
    console.log('Usage: node scripts/generate-rollback.mjs [--all] [--force] [--dry-run] [migration-file]');
    console.log('\nNo migration files specified or all rollbacks already exist.');
    console.log('Use --all to generate rollbacks for all migrations.');
    console.log('Use --force to overwrite existing rollbacks.');
    process.exit(0);
  }

  console.log(`\nGenerating rollbacks for ${files.length} migration(s)...\n`);

  let generated = 0;
  let skipped = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const rollbackName = fileName.replace('.sql', '.rollback.sql');
    const rollbackPath = path.join(ROLLBACKS_DIR, rollbackName);

    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  File not found: ${fileName}`);
      skipped++;
      continue;
    }

    // Check if rollback already exists
    if (fs.existsSync(rollbackPath) && !options.force) {
      console.log(`⏭️  Skipping ${fileName} (rollback exists, use --force to overwrite)`);
      skipped++;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const rollbackContent = generateRollbackContent(fileName, content);

    if (!rollbackContent) {
      console.log(`⏭️  Skipping ${fileName} (no reversible operations found)`);
      skipped++;
      continue;
    }

    if (options.dryRun) {
      console.log(`\n--- ${rollbackName} ---`);
      console.log(rollbackContent);
      console.log('---\n');
    } else {
      fs.writeFileSync(rollbackPath, rollbackContent);
      console.log(`✅ Generated ${rollbackName}`);
    }

    generated++;
  }

  console.log(`\nSummary: ${generated} generated, ${skipped} skipped`);

  if (!options.dryRun && generated > 0) {
    console.log(`\nRollback files written to: ${path.relative(process.cwd(), ROLLBACKS_DIR)}/`);
  }
}

main();
