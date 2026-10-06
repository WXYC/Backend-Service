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
