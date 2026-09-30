/**
 * Genuinely-rendered-SQL pin for `rotation_bin` at every statement that
 * selects it.
 *
 * The expression lives in `apps/backend/utils/sql-rotation-bin.ts` and reaches
 * the four flowsheet read paths through `FSEntryFieldsRaw.rotation_bin`. Two
 * things can go wrong at a call site that no test of the fragment alone can
 * see, and this file pins both on each statement as actually sent:
 *
 *   1. Drift. `tests/fixtures/rotation-bin-fragment-baseline.json` is the
 *      fragment exactly as the four statements rendered it on main before the
 *      expression left `flowsheet.service.ts` (provenance in the fixture). A
 *      tweaked copy pasted back inline — `btrim` for `trim`, a reordered arm —
 *      fails here even though `schema.rotation-bin-fallback-idx.test.ts`, which
 *      reads the module's source text, would stay green. That drift silently
 *      moves the served SQL off migration 0145's index expressions.
 *   2. A dropped `rotation` join. The fragment reads `rotation.rotation_bin`
 *      from the caller's join and embeds none of its own, so omitting the join
 *      is a request-time Postgres error, not a compile error.
 *
 * The last test keeps the list of call sites honest: any module that starts
 * importing the fragment fails it until its statement is added here.
 *
 * Mechanism: the explicit `jest.mock` factory overrides `jest.unit.config.ts`'s
 * `@wxyc/database` redirect (whose tables are plain string maps) with the REAL
 * schema and a real drizzle instance over a client that records each statement
 * and returns no rows — the pattern `flowsheet.getOpenShows.sql.test.ts`
 * established, extended to capture statements the service executes itself.
 */
/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path here is built from __dirname and fixed segments. There is no
 * caller-supplied input in this file. */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const realDjName = jest.requireActual('../../../shared/database/src/dj-name');
  const realOrderBy = jest.requireActual('../../../shared/database/src/last-logged-show-entry');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const capturedStatements: string[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (statement: string) => {
      capturedStatements.push(statement);
      return { values: () => Promise.resolve([]) };
    },
  };
  return {
    ...realSchema,
    ...realDjName,
    ...realOrderBy,
    db: drizzle({ client }),
    capturedStatements,
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  getEntriesByPage,
  getEntriesByRange,
  getEntriesByShow,
  getEntriesInTimeWindow,
} from '../../../apps/backend/services/flowsheet.service';
import { rotationBinExpr } from '../../../apps/backend/utils/sql-rotation-bin';
import baseline from '../../fixtures/rotation-bin-fragment-baseline.json';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// The baseline was rendered with the default schema name.
const PINNED_FRAGMENT = baseline.fragment.split('"wxyc_schema".').join(`"${SCHEMA}".`);
const ROTATION_JOIN = `left join "${SCHEMA}"."rotation" on "${SCHEMA}"."rotation"."id" = "${SCHEMA}"."flowsheet"."rotation_id"`;

const { capturedStatements } = jest.requireMock<{ capturedStatements: string[] }>('@wxyc/database');

async function statementOf(run: () => Promise<unknown>): Promise<string> {
  capturedStatements.length = 0;
  await run();
  expect(capturedStatements).toHaveLength(1);
  return capturedStatements[0];
}

const callSites: Array<[string, () => Promise<unknown>]> = [
  ['getEntriesByPage', () => getEntriesByPage(0, 50)],
  ['getEntriesByRange', () => getEntriesByRange(1000, 1050)],
  [
    'getEntriesInTimeWindow',
    () => getEntriesInTimeWindow(new Date('2026-08-14T04:00:00.000Z'), new Date('2026-08-15T04:00:00.000Z')),
  ],
  ['getEntriesByShow', () => getEntriesByShow(10, 11)],
];

describe('rotation_bin at each FSEntryFieldsRaw call site — rendered statement', () => {
  it('the pinned baseline is what the shared fragment renders', () => {
    // Guards the guard: ties the fixture to the module, so the per-site
    // comparisons below are checking the expression that actually ships.
    expect(new PgDialect().sqlToQuery(rotationBinExpr()).sql).toBe(PINNED_FRAGMENT);
  });

  it.each(callSites)('%s serves the pre-extraction rotation_bin SQL byte for byte', async (_name, run) => {
    const statement = await statementOf(run);
    expect(statement.split(PINNED_FRAGMENT)).toHaveLength(2);
  });

  it.each(callSites)('%s left-joins rotation on flowsheet.rotation_id', async (_name, run) => {
    expect(await statementOf(run)).toContain(ROTATION_JOIN);
  });

  it('no module outside this list selects the fragment', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const walk = (dir: string, out: string[]): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const importers = walk(path.join(repoRoot, 'apps'), [])
      .filter((file) => /['"][^'"\n]*\/sql-rotation-bin(?:\.js)?['"]/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(repoRoot, file));

    // A new caller belongs in `callSites` above, with its own join assertion,
    // before it belongs in this list.
    expect(importers).toEqual(['apps/backend/services/flowsheet.service.ts']);
  });
});
