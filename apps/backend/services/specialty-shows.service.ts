import { and, asc, eq, max } from 'drizzle-orm';
import { db, specialty_shows, type SpecialtyShows } from '@wxyc/database';
import WxycError from '../utils/error.js';
import { SpecialtyShowRef, toSpecialtyShowRef } from './flowsheet/specialty-ref.js';

/** The `SpecialtyShow` wire shape (api.yaml, wxyc-shared#700): the ref plus the three catalog-only fields. */
export const toSpecialtyShow = (row: SpecialtyShows) => ({
  ...(toSpecialtyShowRef(row) as SpecialtyShowRef),
  default_request_mode: row.default_request_mode,
  description: row.description,
  slots: row.slots,
  active: row.active,
});

export const getActiveSpecialtyShows = async () => {
  const rows = await db
    .select()
    .from(specialty_shows)
    .where(eq(specialty_shows.active, true))
    .orderBy(asc(specialty_shows.id));
  return rows.map(toSpecialtyShow);
};

// Whole table, retired rows included, so retiring a program also moves the ETag. Null when the table is empty.
export const getCatalogLastModified = async (): Promise<Date | null> => {
  const [row] = await db.select({ last_modified: max(specialty_shows.last_modified) }).from(specialty_shows);
  return row?.last_modified ?? null;
};

/** The public ref for a catalog program (retired ones included), or `null` for an unknown id. */
export const getSpecialtyShowRef = async (id: number): Promise<SpecialtyShowRef | null> => {
  const [row] = await db.select().from(specialty_shows).where(eq(specialty_shows.id, id)).limit(1);
  return toSpecialtyShowRef(row);
};

/** Whether `id` names a catalog program that may still be tagged onto a new show (known and not retired). */
export const isSpecialtyShowTaggable = async (id: number): Promise<boolean> => {
  const rows = await db
    .select({ id: specialty_shows.id })
    .from(specialty_shows)
    .where(and(eq(specialty_shows.id, id), eq(specialty_shows.active, true)))
    .limit(1);
  return rows.length > 0;
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
