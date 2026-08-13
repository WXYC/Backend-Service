/**
 * Build a `legacy_show_id -> Backend shows.id` map.
 *
 * Extracted from jobs/flowsheet-etl/job.ts (BS#2119 PR 0), where it existed
 * as two copies — `buildShowIdMap` in the bulk-load path and an inline
 * rebuild in `runIncremental` — now consolidated onto this one helper. Lives
 * in its own module rather than jobs/flowsheet-etl/transform.ts because it
 * takes a `DbClient` and queries `shows`; transform.ts is deliberately pure
 * and DB-free. Importing job.ts itself is not an option here: it invokes
 * `run()` at module scope, so any import starts the ETL and trips the
 * backwards-write refusal (see jobs/flowsheet-etl/backwards-write-guard.ts).
 */
import { db, shows } from '@wxyc/database';

export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const buildShowIdMap = async (dbClient: DbClient): Promise<Map<number, number>> => {
  const showRows = await dbClient.select({ id: shows.id, legacyId: shows.legacy_show_id }).from(shows);
  const map = new Map<number, number>();
  for (const row of showRows) {
    if (row.legacyId != null) {
      map.set(row.legacyId, row.id);
    }
  }
  return map;
};
