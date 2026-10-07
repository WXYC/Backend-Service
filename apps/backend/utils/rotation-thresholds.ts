import { ROTATION_BINS, type RotationBin } from '@wxyc/database';
import WxycError from './error.js';

/** Wire shape of `RotationThresholds` (wxyc-shared), declared by hand: the pinned `@wxyc/shared` predates it. */
export type RotationThresholdsWire = { window_days: Record<RotationBin, number>; card_stale_days: number };

/** Parsed `UpdateRotationThresholdsRequest`: every key optional, at both levels. */
export type RotationThresholdsPatch = { window_days?: Partial<Record<RotationBin, number>>; card_stale_days?: number };

/** Request-side ceiling for a day count; the stored read shape is unbounded so this can be raised without a migration. */
export const ROTATION_THRESHOLD_MAX_DAYS = 365;

const TOP_LEVEL_FIELDS = ['window_days', 'card_stale_days'] as const;

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WxycError(`Bad Request: ${label} must be a JSON object`, 400);
  }
  return value as Record<string, unknown>;
}

function requireDays(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ROTATION_THRESHOLD_MAX_DAYS) {
    throw new WxycError(`Bad Request: ${label} must be an integer between 1 and ${ROTATION_THRESHOLD_MAX_DAYS}`, 400);
  }
  return value;
}

/**
 * Validate a `PATCH /library/rotation/thresholds` body. Partial at both levels: an omitted key stays out of the
 * result. An explicit `null`, an unknown key (named in the message) or a day count that is not an integer in 1..365
 * is a 400. Bin keys are matched exactly against `ROTATION_BINS`, not through `parseRotationBin`, which would accept
 * `"h"` and `" H"`.
 */
export function parseRotationThresholdsPatch(body: unknown): RotationThresholdsPatch {
  const record = requireObject(body ?? {}, 'body');
  const unknownKey = Object.keys(record).find((key) => !(TOP_LEVEL_FIELDS as readonly string[]).includes(key));
  if (unknownKey !== undefined) {
    throw new WxycError(
      `Bad Request: ${unknownKey} is not a recognized field (accepted: ${TOP_LEVEL_FIELDS.join(', ')})`,
      400
    );
  }

  const patch: RotationThresholdsPatch = {};
  if (record.card_stale_days !== undefined) {
    patch.card_stale_days = requireDays(record.card_stale_days, 'card_stale_days');
  }
  if (record.window_days !== undefined) {
    const windowDays = requireObject(record.window_days, 'window_days');
    const unknownBin = Object.keys(windowDays).find((key) => !(ROTATION_BINS as readonly string[]).includes(key));
    if (unknownBin !== undefined) {
      throw new WxycError(
        `Bad Request: window_days.${unknownBin} is not a recognized bin (accepted: ${ROTATION_BINS.join(', ')})`,
        400
      );
    }
    const days: Partial<Record<RotationBin, number>> = {};
    for (const bin of ROTATION_BINS) {
      if (windowDays[bin] !== undefined) days[bin] = requireDays(windowDays[bin], `window_days.${bin}`);
    }
    if (Object.keys(days).length > 0) patch.window_days = days;
  }
  return patch;
}
