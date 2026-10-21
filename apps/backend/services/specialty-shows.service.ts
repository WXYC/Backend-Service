import { asc, eq, max } from 'drizzle-orm';
import { db, specialty_shows } from '@wxyc/database';

// The `SpecialtyShow` wire shape (api.yaml, wxyc-shared#700): `name` is the `specialty_name` column.
export const getActiveSpecialtyShows = async () => {
  return await db
    .select({
      id: specialty_shows.id,
      slug: specialty_shows.slug,
      name: specialty_shows.specialty_name,
      short_name: specialty_shows.short_name,
      tagline: specialty_shows.tagline,
      logs_playcuts: specialty_shows.logs_playcuts,
      default_spotlight_role: specialty_shows.default_spotlight_role,
      default_request_mode: specialty_shows.default_request_mode,
      artwork: specialty_shows.artwork,
      accent_color: specialty_shows.accent_color,
      description: specialty_shows.description,
      slots: specialty_shows.slots,
      active: specialty_shows.active,
    })
    .from(specialty_shows)
    .where(eq(specialty_shows.active, true))
    .orderBy(asc(specialty_shows.id));
};

// Whole table, retired rows included, so retiring a program also moves the ETag. Null when the table is empty.
export const getCatalogLastModified = async (): Promise<Date | null> => {
  const [row] = await db.select({ last_modified: max(specialty_shows.last_modified) }).from(specialty_shows);
  return row?.last_modified ?? null;
};
