import type { SpecialtyShows } from '@wxyc/database';

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
