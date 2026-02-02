#!/usr/bin/env node

/**
 * Migration Linter
 *
 * Static analysis tool for SQL migration files. Detects potentially dangerous
 * patterns and enforces best practices for safe deployments.
 *
 * Usage:
 *   node scripts/lint-migrations.js [options] [files...]
 *
 * Options:
 *   --changed-only    Only lint migrations changed in current git diff
 *   --fix-suggestions Show suggested fixes for warnings
 *   --json            Output results as JSON
 *   --strict          Treat warnings as errors
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - Errors found (blocks PR)
 *   2 - Warnings found (with --strict)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MIGRATIONS_DIR = 'shared/database/src/migrations';

// Rule definitions with patterns, severity, and suggestions
const RULES = [
  {
    name: 'concurrent-index',
    description: 'CREATE INDEX without CONCURRENTLY can lock tables',
    pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)(?!IF\s)/gi,
    severity: 'warning',
    suggestion: (match) => match.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+/i, 'CREATE $1INDEX CONCURRENTLY '),
    context: 'Index creation locks the table for writes. Use CONCURRENTLY for zero-downtime deployments.',
  },
  {
    name: 'missing-if-not-exists-table',
    description: 'CREATE TABLE without IF NOT EXISTS guard',
    pattern: /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi,
    severity: 'warning',
    suggestion: (match) => match.replace(/CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '),
    context: 'Adding IF NOT EXISTS makes migrations idempotent and safer to re-run.',
  },
  {
    name: 'missing-if-not-exists-index',
    description: 'CREATE INDEX without IF NOT EXISTS guard',
    pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)/gi,
    severity: 'warning',
    suggestion: (match) => {
      // Insert IF NOT EXISTS after CONCURRENTLY (if present) or after INDEX
      if (/CONCURRENTLY/i.test(match)) {
        return match.replace(/(CONCURRENTLY\s+)/i, '$1IF NOT EXISTS ');
      }
      return match.replace(/(INDEX\s+)/i, '$1IF NOT EXISTS ');
    },
    context: 'Adding IF NOT EXISTS makes migrations idempotent and safer to re-run.',
  },
  {
    name: 'missing-if-not-exists-type',
    description: 'CREATE TYPE without IF NOT EXISTS guard',
    pattern: /CREATE\s+TYPE\s+(?!IF\s+NOT\s+EXISTS)/gi,
    severity: 'warning',
    suggestion: (match) => match.replace(/CREATE\s+TYPE\s+/i, 'CREATE TYPE IF NOT EXISTS '),
    context: 'Adding IF NOT EXISTS makes migrations idempotent.',
  },
  {
    name: 'not-null-no-default',
    description: 'ADD COLUMN with NOT NULL but no DEFAULT (will fail on non-empty tables)',
    // Match ADD COLUMN ... NOT NULL where DEFAULT doesn't appear anywhere in the statement
    // Uses a custom checker function instead of regex alone
    pattern: /ADD\s+COLUMN\s+("[^"]+"|[^\s]+)\s+[^;]*\bNOT\s+NULL\b/gi,
    severity: 'error',
    suggestion: null,
    context: 'Adding a NOT NULL column without DEFAULT fails if the table has existing rows. Either add a DEFAULT or make the column nullable initially.',
    customCheck: (sql) => {
      // If DEFAULT appears anywhere in the statement, it's OK
      return !/\bDEFAULT\b/i.test(sql);
    },
  },
  {
    name: 'truncate-table',
    description: 'TRUNCATE TABLE is destructive and cannot be rolled back',
    pattern: /TRUNCATE\s+(?:TABLE\s+)?("[^"]+"|[^\s;]+)/gi,
    severity: 'error',
    suggestion: null,
    context: 'TRUNCATE removes all data and cannot be easily recovered. Consider using DELETE with a WHERE clause or document why this is necessary.',
  },
  {
    name: 'drop-table',
    description: 'DROP TABLE is destructive - ensure this is intentional',
    pattern: /DROP\s+TABLE\s+(?!IF\s+EXISTS)("[^"]+"|[^\s;]+)/gi,
    severity: 'error',
    suggestion: (match) => match.replace(/DROP\s+TABLE\s+/i, 'DROP TABLE IF EXISTS '),
    context: 'DROP TABLE permanently removes the table and all data. Add IF EXISTS for safety or document why the bare DROP is necessary.',
  },
  {
    name: 'delete-without-where',
    description: 'DELETE without WHERE clause removes all rows',
    pattern: /DELETE\s+FROM\s+("[^"]+"|[^\s]+)\s*;/gi,
    severity: 'error',
    suggestion: null,
    context: 'DELETE without WHERE removes all rows from the table. Add a WHERE clause or use TRUNCATE if removing all data is intentional.',
  },
  {
    name: 'alter-type-add-value',
    description: 'ALTER TYPE ADD VALUE cannot run in a transaction',
    pattern: /ALTER\s+TYPE\s+("[^"]+"|[^\s]+)\s+ADD\s+VALUE/gi,
    severity: 'warning',
    suggestion: null,
    context: 'Adding enum values cannot run inside a transaction. Drizzle may need special handling for this migration.',
  },
  {
    name: 'drop-column',
    description: 'DROP COLUMN permanently removes data',
    pattern: /ALTER\s+TABLE\s+("[^"]+"|[^\s]+)\s+DROP\s+COLUMN\s+(?!IF\s+EXISTS)/gi,
    severity: 'warning',
    suggestion: null,
    context: 'Dropping a column permanently removes that data. Ensure backups exist and this is intentional.',
  },
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    changedOnly: false,
    fixSuggestions: false,
    json: false,
    strict: false,
    files: [],
  };

  for (const arg of args) {
    if (arg === '--changed-only') {
      options.changedOnly = true;
    } else if (arg === '--fix-suggestions') {
      options.fixSuggestions = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (!arg.startsWith('-')) {
      options.files.push(arg);
    }
  }

  return options;
}

// Get list of changed migration files from git
function getChangedMigrations() {
  try {
    // Get files changed vs main branch, or staged files if no comparison branch
    let changedFiles;
    try {
      changedFiles = execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8' });
    } catch {
      // Fallback to staged + unstaged changes
      changedFiles = execSync('git diff --name-only HEAD', { encoding: 'utf8' });
    }

    return changedFiles
      .split('\n')
      .filter((f) => f.startsWith(MIGRATIONS_DIR) && f.endsWith('.sql'))
      .map((f) => path.resolve(process.cwd(), f));
  } catch {
    console.error('Warning: Could not determine changed files from git');
    return [];
  }
}

// Get all migration files
function getAllMigrations() {
  const migrationsPath = path.resolve(process.cwd(), MIGRATIONS_DIR);
  if (!fs.existsSync(migrationsPath)) {
    return [];
  }

  return fs
    .readdirSync(migrationsPath)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => path.join(migrationsPath, f));
}

// Extract line number from match position
function getLineNumber(content, position) {
  return content.substring(0, position).split('\n').length;
}

// Lint a single migration file
function lintFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(process.cwd(), filePath);
  const violations = [];

  for (const rule of RULES) {
    // Reset regex state
    rule.pattern.lastIndex = 0;

    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      const lineNumber = getLineNumber(content, match.index);
      const matchedText = match[0];

      // Get the full statement for custom checks (from match to semicolon)
      const statementEnd = content.indexOf(';', match.index);
      const fullStatement = statementEnd > 0 ? content.substring(match.index, statementEnd + 1) : matchedText;

      // If there's a custom check function, run it
      if (rule.customCheck && !rule.customCheck(fullStatement)) {
        continue; // Skip this match - custom check says it's OK
      }

      // Get context (surrounding lines)
      const lines = content.split('\n');
      const startLine = Math.max(0, lineNumber - 2);
      const endLine = Math.min(lines.length, lineNumber + 1);
      const contextLines = lines.slice(startLine, endLine);

      violations.push({
        rule: rule.name,
        severity: rule.severity,
        description: rule.description,
        file: relativePath,
        line: lineNumber,
        match: matchedText.trim(),
        context: rule.context,
        suggestion: rule.suggestion ? rule.suggestion(matchedText) : null,
        codeContext: contextLines.join('\n'),
      });
    }
  }

  return violations;
}

// Format violation for console output
function formatViolation(v, showSuggestions) {
  const severityIcon = v.severity === 'error' ? '❌' : '⚠️';
  const severityColor = v.severity === 'error' ? '\x1b[31m' : '\x1b[33m';
  const reset = '\x1b[0m';

  let output = `${severityColor}${severityIcon} ${v.severity.toUpperCase()}${reset}: ${v.rule}\n`;
  output += `   ${v.file}:${v.line}\n`;
  output += `   ${v.description}\n`;
  output += `   Match: ${v.match}\n`;
  output += `   ${v.context}\n`;

  if (showSuggestions && v.suggestion) {
    output += `   💡 Suggestion: ${v.suggestion}\n`;
  }

  return output;
}

// Main execution
function main() {
  const options = parseArgs();

  // Determine which files to lint
  let files;
  if (options.files.length > 0) {
    files = options.files.map((f) => path.resolve(process.cwd(), f));
  } else if (options.changedOnly) {
    files = getChangedMigrations();
    if (files.length === 0) {
      if (!options.json) {
        console.log('No changed migration files to lint.');
      }
      process.exit(0);
    }
  } else {
    files = getAllMigrations();
  }

  if (files.length === 0) {
    if (!options.json) {
      console.log('No migration files found.');
    }
    process.exit(0);
  }

  // Lint all files
  const allViolations = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      continue;
    }
    const violations = lintFile(file);
    allViolations.push(...violations);
  }

  // Count by severity
  const errors = allViolations.filter((v) => v.severity === 'error');
  const warnings = allViolations.filter((v) => v.severity === 'warning');

  // Output results
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          files: files.length,
          violations: allViolations,
          summary: {
            total: allViolations.length,
            errors: errors.length,
            warnings: warnings.length,
          },
        },
        null,
        2
      )
    );
  } else {
    console.log(`\nLinting ${files.length} migration file(s)...\n`);

    if (allViolations.length === 0) {
      console.log('✅ All migrations passed lint checks.\n');
    } else {
      for (const v of allViolations) {
        console.log(formatViolation(v, options.fixSuggestions));
      }

      console.log(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s)\n`);

      if (errors.length > 0) {
        console.log('❌ Migration lint failed. Fix errors before merging.\n');
      } else if (warnings.length > 0) {
        console.log('⚠️ Warnings found. Consider addressing before merging.\n');
        if (!options.fixSuggestions) {
          console.log('Run with --fix-suggestions to see suggested fixes.\n');
        }
      }
    }
  }

  // Determine exit code
  if (errors.length > 0) {
    process.exit(1);
  }
  if (options.strict && warnings.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

main();
