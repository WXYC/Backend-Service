import { artists, library, rotation } from '@wxyc/database';
import { sql, type Column, type SQL } from 'drizzle-orm';

/**
 * Reference the OUTER row's column from a correlated subquery that is a select field.
 *
 * drizzle-orm's `buildSelection` rewrites every column sitting directly in a select field's SQL chunks to a bare
 * identifier when the select has one table and no joins. Inside a correlated subquery a bare `"id"` binds to the
 * subquery's own table first, so `... WHERE review_revisions.review_id = ${reviews.id}` silently compares against
 * `review_revisions.id` and raises no error. Columns inside a nested `sql` are left alone, so wrapping the column
 * once keeps it table-qualified. Rule: inside a select-field fragment, reference the outer row only through this.
 */
export const outerRef = (column: Column): SQL => sql`${column}`;

/**
 * The subquery of rotation rows that name the outer rotation row in `moved_from_rotation_id` (BS#3007): the row was
 * moved to another bin, so it is not the newest in its chain. Pass it to `exists` / `notExists`.
 */
export const rotationSuccessorSql = (): SQL =>
  sql`(SELECT 1 FROM ${rotation} AS successor WHERE successor.moved_from_rotation_id = ${outerRef(rotation.id)})`;

/**
 * `isVariousArtists` (`services/requestLine/types.ts`) over `artists.code_letters`, in SQL: `V/A` ignoring case and
 * surrounding spaces, or a case-sensitive `Z-` prefix. The two are pinned together over one table of code letters
 * (`tests/utils/various-artists-code-letters.js`), so change them together.
 */
export const isCompilationArtistSql: SQL<boolean> = sql<boolean>`(upper(trim(${artists.code_letters})) = 'V/A' OR trim(${artists.code_letters}) LIKE 'Z-%')`;

/**
 * The displayed artist of a release (BS#3284, BS#3286), the one home of the rule: the trimmed `alternate_artist_name`
 * unless it is null, empty or whitespace, else the filed artist's name, so a compilation under a V/A bucket names its
 * own artist. On a compilation (`isCompilationArtistSql`) the alternate name reads `V/A <name>`, so it is not mistaken
 * for a record by that artist. Needs `library` and `artists` in the select's joins. Read by the release print and the
 * review notices (`selectReleaseRecord`) and by FCC notes (`fccNoteSelection`).
 */
export const displayedArtistName: SQL<string> = sql<string>`coalesce(CASE WHEN ${isCompilationArtistSql} THEN 'V/A ' ELSE '' END || nullif(trim(${library.alternate_artist_name}), ''), ${artists.artist_name})`;
