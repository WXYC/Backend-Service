/**
 * DB writer for album-critic-reviews-etl (BS#1830). Same discipline as
 * `jobs/album-reviews-etl/writer.ts` (structural donor): a typed insert,
 * UPSERTing on the table's real unique index — here `(album_id,
 * source_url)` (migration 0125's `album_critic_reviews_album_id_source_url_uq`),
 * not a synthetic key.
 *
 * `setWhere` carries an IS DISTINCT FROM guard over every content column, so
 * a no-op weekly run against an unchanged manifest skips the UPDATE
 * entirely and `last_modified` stays an honest audit signal — the row is
 * reported `unchanged`. In practice this only fires on a race (a row
 * written out-of-band since the anti-join read), since the anti-join
 * already filters out existing pairs before extraction ever runs.
 *
 * SINGLE SOURCE OF TRUTH: `SET_CONTENT_COLUMNS` drives BOTH the ON CONFLICT
 * `set` object and the `setWhere` arms by construction, so a column added to
 * one but not the other can't silently freeze its propagation or churn
 * `last_modified` on unchanged rows.
 *
 * `xmax = 0` in `returning` distinguishes inserted from updated, matching
 * the donor.
 */
import { db, album_critic_reviews } from '@wxyc/database';
import { sql, type SQL } from 'drizzle-orm';

type Row = typeof album_critic_reviews.$inferInsert;

export type UpsertOutcome = {
  inserted: boolean;
  updated: boolean;
  unchanged: boolean;
};

/** The content columns the ON CONFLICT `set` refreshes and the `setWhere`
 *  guard compares — every `Row` key except `album_id`/`source_url` (the
 *  conflict target, equal on both sides by definition). */
export const SET_CONTENT_COLUMNS = [
  'source',
  'snippet',
  'author',
  'published_at',
  'rating',
  'discogs_release_id',
  'source_key',
] as const satisfies readonly (keyof Row)[];

type ContentColumn = (typeof SET_CONTENT_COLUMNS)[number];

const buildConflictSet = (row: Row): { [K in ContentColumn]: Row[K] } & { last_modified: SQL } => ({
  ...(Object.fromEntries(SET_CONTENT_COLUMNS.map((col) => [col, row[col]])) as {
    [K in ContentColumn]: Row[K];
  }),
  last_modified: sql`now()`,
});

const distinctFromArm = (col: ContentColumn, row: Row): SQL => {
  const column = album_critic_reviews[col];
  return sql`${column} IS DISTINCT FROM ${row[col]}`;
};

/** OR-join of the per-column arms, built by reduction rather than
 *  `sql.join` — the alias-consumer/album-reviews-etl writer tests document
 *  that drizzle's compiled `sql.join` doesn't survive ts-jest's transform. */
const buildSetWhere = (row: Row): SQL =>
  SET_CONTENT_COLUMNS.map((col) => distinctFromArm(col, row)).reduce((acc, arm) => sql`${acc} OR ${arm}`);

/**
 * UPSERT one built row. Idempotent on `(album_id, source_url)`; see the
 * module docstring for the set/setWhere discipline.
 */
export const upsertRow = async (row: Row): Promise<UpsertOutcome> => {
  const t = album_critic_reviews;

  const result = await db
    .insert(t)
    .values(row)
    .onConflictDoUpdate({
      target: [t.album_id, t.source_url],
      set: buildConflictSet(row),
      setWhere: buildSetWhere(row),
    })
    .returning({
      id: t.id,
      inserted: sql<boolean>`xmax = 0`,
    });

  if (result.length === 0) {
    return { inserted: false, updated: false, unchanged: true };
  }
  return result[0].inserted
    ? { inserted: true, updated: false, unchanged: false }
    : { inserted: false, updated: true, unchanged: false };
};
