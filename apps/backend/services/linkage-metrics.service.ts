/**
 * Observability surface for the LML-linkage path (B-3.2).
 *
 * Two readouts:
 *   - In-process counters keyed by outcome name. B-2.1 (forward) and B-2.2
 *     (backfill) both call `incrementLinkageMetric`. The counter map is
 *     readable via `getLinkageCounters` and resettable via
 *     `resetLinkageCounters` (used by tests; production never resets).
 *   - SQL-backed gauges over the `flowsheet` table:
 *       * `getCumulativeLinkageCoverage` — `count(*) FILTER (WHERE
 *         album_id IS NOT NULL) / count(*)` across all track rows. Surfaces
 *         on the dashboard so we can watch the gap close as B-2.2 sweeps run.
 *       * `getRecentLinkageRate(hours)` — proxy for forward-path health:
 *         of rows inserted in the last N hours, what fraction are linked?
 *         A falling ratio means B-2.1's worker is falling behind.
 *
 * Errors from the linkage path go through `reportLinkageError`, which tags
 * Sentry with `subsystem='lml-linkage'` so the operator can filter the issue
 * stream by subsystem instead of by stack trace.
 */
import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

export const LINKAGE_METRIC_NAMES = [
  'linked_high_conf',
  'gray_zone_review',
  'no_candidate',
  'lml_error',
  'lml_timeout',
] as const;

export type LinkageMetricName = (typeof LINKAGE_METRIC_NAMES)[number];

const counters: Record<LinkageMetricName, number> = {
  linked_high_conf: 0,
  gray_zone_review: 0,
  no_candidate: 0,
  lml_error: 0,
  lml_timeout: 0,
};

export const incrementLinkageMetric = (name: LinkageMetricName): void => {
  counters[name] += 1;
};

export const getLinkageCounters = (): Record<LinkageMetricName, number> => ({ ...counters });

export const resetLinkageCounters = (): void => {
  for (const name of LINKAGE_METRIC_NAMES) counters[name] = 0;
};

/**
 * Distinguish a transient LML timeout from a generic LML error. Timeouts are
 * usually transient (cold start, network blip) and the backfill retries on
 * the next sweep. Splitting the counters lets the operator tell those two
 * failure modes apart at a glance.
 */
export const classifyLinkageError = (error: unknown): 'lml_timeout' | 'lml_error' => {
  if (!error || typeof error !== 'object') return 'lml_error';
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'lml_timeout';
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED' || e.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'lml_timeout';
  }
  if (typeof e.message === 'string' && /timeout/i.test(e.message)) return 'lml_timeout';
  return 'lml_error';
};

export const reportLinkageError = (
  error: unknown,
  context?: Record<string, unknown>,
  extraTags?: Record<string, string>
): void => {
  Sentry.captureException(error, {
    tags: { subsystem: 'lml-linkage', ...(extraTags ?? {}) },
    extra: context,
  });
};

const toNumber = (value: unknown): number => {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

export type LinkageCoverage = { linked: number; total: number; ratio: number };

/**
 * Cumulative linkage coverage across the entire `flowsheet` table, scoped
 * to track entries (messages and breaks shouldn't move the gauge).
 */
export const getCumulativeLinkageCoverage = async (): Promise<LinkageCoverage> => {
  const rows = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE "album_id" IS NOT NULL) AS "linked",
      count(*) AS "total"
    FROM "wxyc_schema"."flowsheet"
    WHERE "entry_type" = 'track'
  `)) as unknown as Array<{ linked: number | string; total: number | string }>;

  const linked = toNumber(rows?.[0]?.linked);
  const total = toNumber(rows?.[0]?.total);
  return { linked, total, ratio: total === 0 ? 0 : linked / total };
};

export type RecentLinkageRate = { inserted: number; linked: number; ratio: number };

/**
 * Forward-path health proxy. Of rows inserted in the last `hours` hours,
 * what fraction are linked? B-2.1's worker should land linkage within
 * minutes of insert; a sustained drop in this ratio means the worker is
 * either erroring out or falling behind LML's rate budget.
 */
export const getRecentLinkageRate = async (hours: number): Promise<RecentLinkageRate> => {
  const rows = (await db.execute(sql`
    SELECT
      count(*) AS "inserted",
      count(*) FILTER (WHERE "album_id" IS NOT NULL) AS "linked"
    FROM "wxyc_schema"."flowsheet"
    WHERE "entry_type" = 'track'
      AND "add_time" >= now() - make_interval(hours => ${hours})
  `)) as unknown as Array<{ inserted: number | string; linked: number | string }>;

  const inserted = toNumber(rows?.[0]?.inserted);
  const linked = toNumber(rows?.[0]?.linked);
  return { inserted, linked, ratio: inserted === 0 ? 0 : linked / inserted };
};
