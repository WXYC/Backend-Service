import { db, rotation_thresholds, type RotationBin } from '@wxyc/database';
import type { RotationThresholdsPatch, RotationThresholdsWire } from '../utils/rotation-thresholds.js';

type ThresholdsRow = typeof rotation_thresholds.$inferSelect;

/** The stored column behind each bin's window. */
const WINDOW_COLUMN = {
  H: 'window_days_h',
  M: 'window_days_m',
  L: 'window_days_l',
  S: 'window_days_s',
} as const satisfies Record<RotationBin, keyof ThresholdsRow>;

function toWire(row: ThresholdsRow): RotationThresholdsWire {
  return {
    window_days: {
      H: row[WINDOW_COLUMN.H],
      M: row[WINDOW_COLUMN.M],
      L: row[WINDOW_COLUMN.L],
      S: row[WINDOW_COLUMN.S],
    },
    card_stale_days: row.card_stale_days,
  };
}

/** The station-wide rotation thresholds: one row, seeded by the migration that creates the table. */
export async function getRotationThresholds(): Promise<RotationThresholdsWire> {
  const [row] = await db.select().from(rotation_thresholds).limit(1);
  if (!row) throw new Error('rotation_thresholds row is missing: the migration seed did not run');
  return toWire(row);
}

/**
 * Apply a partial patch as one atomic `UPDATE` of only the supplied columns (no read-modify-write), and answer the
 * whole record after the write. An empty patch issues no UPDATE (drizzle rejects an empty `.set()`).
 */
export async function updateRotationThresholds(patch: RotationThresholdsPatch): Promise<RotationThresholdsWire> {
  const set: Partial<Pick<ThresholdsRow, (typeof WINDOW_COLUMN)[RotationBin] | 'card_stale_days'>> = {};
  for (const [bin, days] of Object.entries(patch.window_days ?? {}) as Array<[RotationBin, number]>) {
    set[WINDOW_COLUMN[bin]] = days;
  }
  if (patch.card_stale_days !== undefined) set.card_stale_days = patch.card_stale_days;
  if (Object.keys(set).length === 0) return getRotationThresholds();

  const [row] = await db.update(rotation_thresholds).set(set).returning();
  return toWire(row);
}
