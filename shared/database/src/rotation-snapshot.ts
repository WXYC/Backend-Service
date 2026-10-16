/**
 * Width (in Unicode code points) of the three free-text `rotation` snapshot
 * columns: `artist_name`, `album_title`, `record_label`. Pure module (no
 * drizzle) so `schema.ts` and tests can both read it.
 *
 * `apps/backend/utils/text-fields.ts` `MAX_ALBUM_TEXT_LENGTH` is the app-side
 * validator limit for the same width; a unit test pins the two together.
 */
export const ROTATION_SNAPSHOT_MAX_LENGTH = 128;
