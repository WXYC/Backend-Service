/**
 * Source-grep guards for `getEntryCount` in `apps/backend/services/flowsheet.service.ts`.
 *
 * The pagination count was originally an exact `count(*)` over the
 * `wxyc_schema.flowsheet` table. With ~2.6M rows, that query was sequentially
 * scanning the heap on every `/flowsheet` page load, routinely exceeding the
 * 5s per-statement timeout under live RDS load and surfacing as 500 errors at
 * the endpoint. The fix swaps it for the planner's row-count estimate
 * (`pg_class.reltuples`), which is constant-time.
 *
 * These tests source-grep the implementation to lock in the new shape:
 * future refactors that accidentally revert to `count(*)` will trip the
 * guard, and the on-prod incident will not recur silently.
 */

import * as fs from 'fs';
import * as path from 'path';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/flowsheet.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

const extractGetEntryCountBody = (): string => {
  const match = serviceSource.match(/export const getEntryCount[\s\S]*?\n\};/);
  if (!match) throw new Error('getEntryCount not found in flowsheet.service.ts');
  return match[0];
};

describe('flowsheet.service: getEntryCount uses pg_class.reltuples', () => {
  const body = extractGetEntryCountBody();

  it('reads from pg_class instead of running count(*)', () => {
    // The whole point of the rewrite. If anything in the function body still
    // says count(*) on the flowsheet table, we are back to scanning 2.6M rows
    // and back to flowsheet-endpoint 500s.
    expect(body).toMatch(/pg_class/);
    expect(body).not.toMatch(/count\(\*\)/);
  });

  it('reads reltuples (the planner row-count estimate)', () => {
    // reltuples is maintained by autovacuum/ANALYZE; -1 is the never-analyzed
    // sentinel which we floor to 0 via GREATEST.
    expect(body).toMatch(/reltuples/);
    expect(body).toMatch(/GREATEST\(\s*reltuples/);
  });

  it('scopes the lookup to the configured schema, not just relname', () => {
    // Two tables named "flowsheet" in different schemas (dev + test workers
    // sharing a database, or a future tenant scheme) would otherwise return
    // an arbitrary row. Use relnamespace so the lookup is unambiguous.
    expect(body).toMatch(/relnamespace/);
    expect(body).toMatch(/WXYC_SCHEMA_NAME/);
    // And falls back to wxyc_schema when the env var is unset (matches client.ts).
    expect(body).toMatch(/['"]wxyc_schema['"]/);
  });

  it('treats a missing row as 0, not as an error', () => {
    // First page renders before autovacuum has had a chance to populate
    // reltuples on a freshly-restored DB. Returning 0 there is benign — the
    // page just shows totalPages=0 until ANALYZE runs.
    expect(body).toMatch(/\?\?\s*0/);
  });

  it('still exports getEntryCount with the same return type as before', () => {
    // The controller awaits a Promise<number>; downstream type-checking would
    // catch a signature change, but having an explicit guard here keeps the
    // intent obvious.
    expect(body).toMatch(/export const getEntryCount\s*=\s*async\s*\(\)\s*:\s*Promise<number>/);
  });
});
