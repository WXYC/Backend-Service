/**
 * Unit tests for `shared/database/src/client.ts` — verify the postgres-js
 * client is configured with a server-side `statement_timeout` to prevent
 * orphan-query accumulation when an HTTP request handler times out
 * (incident #511).
 *
 * Two-pronged strategy:
 *   1. Test the pure `resolveStatementTimeoutMs` helper for parsing edge
 *      cases. The helper is exported specifically so tests can reach it
 *      without going through the moduleNameMapper that maps
 *      `@wxyc/database` and `**\/shared/database/src/client` to the in-memory
 *      mock.
 *   2. Source-grep client.ts to assert the postgres() call passes
 *      `connection.statement_timeout` and `connection.application_name`
 *      derived from the helper. Catches refactors that reshape the call.
 */

// Stub out the heavy module-level work in client.ts (postgres-js connection
// + drizzle schema introspection) so requiring the real file via its
// absolute .ts path is side-effect-free.
jest.mock('postgres', () => jest.fn(() => ({ end: jest.fn().mockResolvedValue(undefined) })));
jest.mock('drizzle-orm/postgres-js', () => ({ drizzle: jest.fn(() => ({})) }));

import * as fs from 'fs';
import * as path from 'path';

const clientSourcePath = path.resolve(__dirname, '../../../shared/database/src/client.ts');
const clientSource = fs.readFileSync(clientSourcePath, 'utf-8');

/**
 * Reach into the helper without going through moduleNameMapper. Resolving
 * the file by absolute path with the .ts extension bypasses both the
 * `^@wxyc/database$` and `**\/shared/database/src/client(.js)?$` regex
 * mappings (the latter does not match `.ts`).
 */
const loadResolver = (): ((raw?: string) => number) => {
  // Bare `require` re-runs the module top-level once per resolved path, but
  // this module's only top-level effect is the env-var validation block.
  // That block reads `DB_HOST` etc. at import time, so we provide minimal
  // values to satisfy it. The validation has already passed by the time
  // resolveStatementTimeoutMs is called, so we then clear DB_HOST again to
  // avoid leaking into other tests that depend on its absence.
  const prev = { ...process.env };
  process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
  process.env.DB_NAME = process.env.DB_NAME ?? 'wxyc_db';
  process.env.DB_USERNAME = process.env.DB_USERNAME ?? 'wxyc_admin';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'pw';

  // Silence the bootstrap log line.
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  try {
    // ts-jest resolves .ts files; this absolute path doesn't match the
    // moduleNameMapper regex above, so we get the real module. Using
    // jest.requireActual rather than the bare require keyword (which
    // @typescript-eslint/no-require-imports forbids) preserves the same
    // resolution semantics while staying within the lint rules.
    const mod: { resolveStatementTimeoutMs: (raw?: string) => number } = jest.requireActual(clientSourcePath);
    return mod.resolveStatementTimeoutMs;
  } finally {
    logSpy.mockRestore();
    Object.keys(process.env).forEach((k) => {
      if (!(k in prev)) delete process.env[k];
    });
    Object.assign(process.env, prev);
  }
};

describe('resolveStatementTimeoutMs', () => {
  let resolveStatementTimeoutMs: (raw?: string) => number;

  beforeAll(() => {
    resolveStatementTimeoutMs = loadResolver();
  });

  it('defaults to 5000ms when the env var is unset', () => {
    // 5s catches the orphan-query class without affecting normal endpoints,
    // which finish in milliseconds. Migrations and backfills opt into a
    // longer timeout via DB_STATEMENT_TIMEOUT_MS.
    expect(resolveStatementTimeoutMs(undefined)).toBe(5000);
  });

  it('parses a custom millisecond value', () => {
    // Migrations set 5min so DDL on contended tables can wait for the lock.
    expect(resolveStatementTimeoutMs('300000')).toBe(300000);
  });

  it('treats "0" as disabled (no server-side timeout)', () => {
    // Escape hatch for unit-test fixtures and one-off scripts where any
    // server-side timeout would mask test failures.
    expect(resolveStatementTimeoutMs('0')).toBe(0);
  });

  it('throws on negative values', () => {
    expect(() => resolveStatementTimeoutMs('-1')).toThrow(/DB_STATEMENT_TIMEOUT_MS=.*must be a non-negative integer/);
  });

  it('throws on non-numeric values', () => {
    expect(() => resolveStatementTimeoutMs('soon')).toThrow(/DB_STATEMENT_TIMEOUT_MS=.*must be a non-negative integer/);
  });

  it('throws on NaN', () => {
    expect(() => resolveStatementTimeoutMs('NaN')).toThrow(/DB_STATEMENT_TIMEOUT_MS=.*must be a non-negative integer/);
  });
});

describe('client.ts: postgres() call shape', () => {
  it('passes connection.statement_timeout sourced from the helper', () => {
    // Source-grep guard: catches refactors that reshape the postgres() call
    // and accidentally drop the timeout. The exact value is the helper's
    // responsibility (covered above) — this test just verifies the wiring.
    expect(clientSource).toMatch(
      /postgres\(\{[\s\S]*connection:\s*\{[\s\S]*statement_timeout:\s*statementTimeoutMs[\s\S]*\}/
    );
  });

  it('passes connection.application_name with a wxyc-* default', () => {
    // pg_stat_activity's application_name column is the only fast way to
    // tell at incident time which subsystem is holding a runaway query.
    // Default + override pattern lets backfills and migrations identify
    // themselves without code changes.
    expect(clientSource).toMatch(/application_name:\s*process\.env\.DB_APPLICATION_NAME\s*\?\?\s*'wxyc-/);
  });

  it('logs the resolved timeout at startup so operators can verify config', () => {
    // Prevents silent misconfiguration: if a deploy ships without the var,
    // the log line surfaces the actual default (5000ms) on the first run
    // rather than waiting for an orphan to accumulate.
    expect(clientSource).toMatch(/console\.log\([\s\S]*statement_timeout=\$\{statementTimeoutMs\}/);
  });
});
