/**
 * Probe `flowsheet` for any track row inserted within the lookback window
 * — `true` while a DJ is actively adding tracks. Backed by migration 0050's
 * partial index `flowsheet_track_add_time_idx ON (add_time DESC) WHERE
 * entry_type='track'` for an index-only single-leaf-page read. The literal
 * `'track'` predicate is what lets the planner match the partial index;
 * keep it inline rather than parameterised.
 */
import { sql } from 'drizzle-orm';
import { db } from './client.js';

export const LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT = 60;
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

export type CheckLiveActivityFn = (lookbackSeconds: number) => Promise<boolean>;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);

export const checkLiveActivity: CheckLiveActivityFn = async (lookbackSeconds) => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ${FLOWSHEET_TABLE}
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
};
