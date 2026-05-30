/**
 * Cooperative-pause primitives shared by jobs and the rotation-tracks-cache
 * warm walker (BS#1241).
 *
 * `checkLiveActivity` probes `flowsheet` for any track row inserted within
 * the lookback window. Returns `true` while a DJ is actively adding tracks
 * — the highest UX-sensitivity moment, when backfills / boot warmers should
 * yield. Uses the partial index from migration 0050
 * (`flowsheet_track_add_time_idx ON (add_time DESC) WHERE
 * entry_type='track'`) for an index-only single-leaf-page check. Cost is
 * negligible.
 *
 * `LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT` and `LIVE_ACTIVITY_PAUSE_MS_DEFAULT`
 * are the canonical defaults; callers that need a stricter window (e.g.,
 * `jobs/album-level-backfill`'s long-transaction post-pass at 300 s) override
 * locally.
 *
 * Resolver functions stay per-caller because the throw-vs-warn policy is
 * legitimately different: jobs throw on misconfig (cron exits, operator
 * notices); the API-boot warm walker warns and defaults (boot must succeed
 * for the API to serve traffic). Both shapes are visible in the call sites
 * for that reason.
 */
import { sql } from 'drizzle-orm';
import { db } from './client.js';

/** Default lookback window (seconds) for the cooperative-pause probe. */
export const LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT = 60;

/** Default sleep (ms) between re-probes when DJ activity is detected. */
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
