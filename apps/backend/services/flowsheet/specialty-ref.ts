import type { SpecialtyShows } from '@wxyc/database';
import WxycError from '../../utils/error.js';
import { isSpecialtyShowTaggable } from '../flowsheet.service.js';

/** The public projection of a `specialty_shows` row (api.yaml `SpecialtyShowRef`). */
export type SpecialtyShowRef = {
  id: number;
  slug: string;
  name: string;
  short_name: string;
  tagline: string | null;
  logs_playcuts: boolean;
  default_spotlight_role: SpecialtyShows['default_spotlight_role'];
  artwork: SpecialtyShows['artwork'];
  accent_color: string | null;
};

/**
 * Projects a catalog row to `SpecialtyShowRef`, or `null` for an untagged show
 * (a LEFT JOIN that matched nothing). Retired rows project like any other: past
 * shows keep their identity.
 */
export const toSpecialtyShowRef = (row: SpecialtyShows | null | undefined): SpecialtyShowRef | null =>
  row == null
    ? null
    : {
        id: row.id,
        slug: row.slug,
        name: row.specialty_name,
        short_name: row.short_name,
        tagline: row.tagline ?? null,
        logs_playcuts: row.logs_playcuts,
        default_spotlight_role: row.default_spotlight_role ?? null,
        artwork: row.artwork ?? null,
        accent_color: row.accent_color ?? null,
      };

/**
 * 400 for a `specialty_id` that is unknown or retired, before any write (BS#3454, BS#3456). `null` and `undefined`
 * pass: a clear and an omission tag nothing. `currentSpecialtyId` is the show's own tag, which a DJ may keep sending
 * after its program is retired mid-show.
 */
export const assertSpecialtyTaggable = async (
  specialty_id: number | null | undefined,
  currentSpecialtyId?: number | null
): Promise<void> => {
  if (specialty_id == null) {
    return;
  }
  // The `number` type is compile-time only and no validator guards these bodies: a string, a fraction or an
  // out-of-range integer would reach Postgres as 22P02/22003 and surface as a 500.
  if (!Number.isInteger(specialty_id) || specialty_id <= 0 || specialty_id > 2147483647) {
    throw new WxycError('Bad Request: specialty_id must be a positive integer', 400);
  }
  if (specialty_id === currentSpecialtyId) {
    return;
  }
  if (!(await isSpecialtyShowTaggable(specialty_id))) {
    throw new WxycError('Bad Request: specialty_id is unknown or names a retired specialty show', 400);
  }
};
