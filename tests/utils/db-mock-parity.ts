/**
 * Pure comparison logic behind `npm run check:db-mock-sync` (BS#2448).
 *
 * Why this file is here and not in `scripts/`: the runner
 * (`scripts/check-db-mock-sync.mjs`) is deliberately thin, mirroring
 * `scripts/check-better-auth-mock-sync.ts` — whose docblock explains the split.
 * `scripts/**` is in ESLint's global ignore list and is not a workspace, so
 * nothing there is linted, typechecked, or unit-tested. `tests/utils/` is
 * linted and is reachable from the unit suite (see `tests/utils/render-sql.ts`
 * for the same arrangement), so the logic that decides whether the build fails
 * lives here and is covered by `tests/unit/scripts/db-mock-sync.test.ts`.
 *
 * ## What is being compared, and why a static parse
 *
 * `tests/mocks/database.mock.ts` is a hand-maintained double of
 * `shared/database/src/schema.ts`. Nothing kept them in sync, and the failure
 * is silent rather than loud: a column missing from a double reads as
 * `undefined`, and `expect(fn).toHaveBeenCalledWith({ format_id: undefined })`
 * **matches a call that omitted the key entirely**. The assertion is green
 * whether the production code writes the column or not.
 *
 * The schema side is read by importing the real module and asking drizzle for
 * each table's columns. The mock side is read by parsing the file's AST rather
 * than importing it, because `database.mock.ts` imports `@jest/globals`, which
 * throws on import outside a Jest environment. A static parse is also the
 * right tool for the question — "which property keys does this object literal
 * declare" is syntactic — and it lets the check see the sentinel *values*
 * without evaluating anything.
 */
import ts from 'typescript';

/** A mock table double: its declared columns, each mapped to its sentinel string. */
export type MockDouble = ReadonlyMap<string, string>;

/** Export name -> the double's declared columns. */
export type MockDoubles = ReadonlyMap<string, MockDouble>;

/** Export name -> the real table's drizzle property keys. */
export type SchemaTables = ReadonlyMap<string, readonly string[]>;

export type DbMockFindingKind =
  /** A schema table/view has no double at all, and is not allowlisted. */
  | 'missing-double'
  /** A double exists but lacks a column its table has, and it is not allowlisted. */
  | 'missing-column'
  /** A double exists for a name that is not a table/view in schema.ts. */
  | 'unknown-double'
  /** A sentinel is not `'<thisTable>.<column>'`. */
  | 'unqualified-sentinel'
  /** An allowlist entry that is no longer needed. The allowlist may only shrink. */
  | 'stale-allowlist';

export interface DbMockFinding {
  kind: DbMockFindingKind;
  table: string;
  detail: string;
}

/**
 * The recorded backlog of drift that predates this check.
 *
 * `missingDoubles` and `missingColumns` are **debt markers, not exemptions** —
 * see `tests/utils/db-mock-allowlist.ts`.
 */
export interface DbMockAllowlist {
  readonly missingDoubles: readonly string[];
  readonly missingColumns: Readonly<Record<string, readonly string[]>>;
}

/**
 * Extracts every `export const <name> = { ... }` object literal from the
 * mock's source text, with each property's key and (when it is a string
 * literal) its value.
 *
 * Only object-literal exports are collected: the file's other exports are
 * functions, `jest.fn()` stubs, classes, and re-exports, none of which are
 * table doubles.
 */
export function parseMockDoubles(source: string, fileName = 'database.mock.ts'): MockDoubles {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const doubles = new Map<string, MockDouble>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;

      const columns = new Map<string, string>();
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key =
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        if (key === undefined) continue;
        // A non-string value is not a sentinel. Recorded as the empty string so
        // the column still counts as "declared" (it is, for the `undefined`
        // hazard) while `unqualified-sentinel` still flags it.
        columns.set(key, ts.isStringLiteral(property.initializer) ? property.initializer.text : '');
      }
      doubles.set(declaration.name.text, columns);
    }
  }

  return doubles;
}

/**
 * Compares the doubles against the real schema, honouring the allowlist.
 *
 * Returns every finding rather than throwing on the first, so one run reports
 * the whole picture. An empty array means conformant.
 */
export function compareDbMock(
  schemaTables: SchemaTables,
  mockDoubles: MockDoubles,
  allowlist: DbMockAllowlist
): DbMockFinding[] {
  const findings: DbMockFinding[] = [];
  const allowedMissingDoubles = new Set(allowlist.missingDoubles);

  // --- drift: the schema has something the double does not ---
  for (const [table, columns] of schemaTables) {
    const double = mockDoubles.get(table);
    if (double === undefined) {
      if (!allowedMissingDoubles.has(table)) {
        findings.push({
          kind: 'missing-double',
          table,
          detail: `schema.ts declares \`${table}\` but tests/mocks/database.mock.ts has no double for it`,
        });
      }
      continue;
    }

    const allowedColumns = new Set(allowlist.missingColumns[table] ?? []);
    for (const column of columns) {
      if (double.has(column)) continue;
      if (allowedColumns.has(column)) continue;
      findings.push({
        kind: 'missing-column',
        table,
        detail: `\`${table}.${column}\` exists in schema.ts but not on the double`,
      });
    }
  }

  // --- drift: the double has something the schema does not, or is malformed ---
  for (const [table, double] of mockDoubles) {
    if (!schemaTables.has(table)) {
      findings.push({
        kind: 'unknown-double',
        table,
        detail: `tests/mocks/database.mock.ts exports a double named \`${table}\`, which is not a table or view in schema.ts (typo, or a table that was renamed/dropped)`,
      });
      continue;
    }
    for (const [column, sentinel] of double) {
      // The suffix is the DB column name and need not equal the key (the `user`
      // double maps camelCase keys to snake_case names); only the qualifier is
      // pinned. See the header of tests/mocks/database.mock.ts.
      if (sentinel.startsWith(`${table}.`) && sentinel.length > table.length + 1) continue;
      findings.push({
        kind: 'unqualified-sentinel',
        table,
        detail: `\`${table}.${column}\` is \`${JSON.stringify(sentinel)}\`; sentinels must read \`'${table}.<column>'\` so a same-named column on another table is a different value`,
      });
    }
  }

  // --- the allowlist may only shrink ---
  for (const table of allowlist.missingDoubles) {
    if (!schemaTables.has(table)) {
      findings.push({
        kind: 'stale-allowlist',
        table,
        detail: `missingDoubles lists \`${table}\`, which is no longer a table or view in schema.ts — drop the entry`,
      });
      continue;
    }
    if (mockDoubles.has(table)) {
      findings.push({
        kind: 'stale-allowlist',
        table,
        detail: `missingDoubles lists \`${table}\`, but the double now exists — drop the entry`,
      });
    }
    if (allowlist.missingColumns[table] !== undefined) {
      findings.push({
        kind: 'stale-allowlist',
        table,
        detail: `\`${table}\` is in BOTH missingDoubles and missingColumns; a table with no double has no columns to enumerate — drop its missingColumns entry`,
      });
    }
  }

  for (const [table, columns] of Object.entries(allowlist.missingColumns)) {
    const schemaColumns = schemaTables.get(table);
    if (schemaColumns === undefined) {
      if (!allowedMissingDoubles.has(table)) {
        findings.push({
          kind: 'stale-allowlist',
          table,
          detail: `missingColumns lists \`${table}\`, which is no longer a table or view in schema.ts — drop the entry`,
        });
      }
      continue;
    }
    const double = mockDoubles.get(table);
    // Nothing to reconcile while the double itself is absent; the
    // missingDoubles pass above already reported the redundancy.
    if (double === undefined) continue;

    const schemaColumnSet = new Set(schemaColumns);
    for (const column of columns) {
      if (!schemaColumnSet.has(column)) {
        findings.push({
          kind: 'stale-allowlist',
          table,
          detail: `missingColumns lists \`${table}.${column}\`, which schema.ts no longer declares — drop the entry`,
        });
        continue;
      }
      if (double.has(column)) {
        findings.push({
          kind: 'stale-allowlist',
          table,
          detail: `missingColumns lists \`${table}.${column}\`, but the double now declares it — drop the entry`,
        });
      }
    }
  }

  return findings;
}

/** Groups findings by kind, preserving input order within each group. */
export function groupFindings(findings: readonly DbMockFinding[]): Map<DbMockFindingKind, DbMockFinding[]> {
  const grouped = new Map<DbMockFindingKind, DbMockFinding[]>();
  for (const finding of findings) {
    grouped.set(finding.kind, [...(grouped.get(finding.kind) ?? []), finding]);
  }
  return grouped;
}
