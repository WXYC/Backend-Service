/**
 * Writer for jobs/concerts-poster-enrichment (BS#1743).
 *
 * Per-artist UPDATE of `concerts.image_url`, scoped to the concert rows a
 * headliner is billed on. The WHERE clause guards on `image_url IS NULL` —
 * belt-and-suspenders on top of the candidate query's own `image_url IS
 * NULL` filter — so a concert that a concurrent scrape (or a concurrent run
 * of this same job) filled in the window between candidate load and write
 * can never be clobbered. This is the same idempotent-single-row-UPDATE
 * shape as `jobs/concerts-artist-resolver/writer.ts`, generalized to an
 * array of concert ids so one Discogs artist-details fetch can fan out to
 * every concert that shares the headliner.
 *
 * Depends on WXYC/Backend-Service#1742 (preserve-on-null COALESCE in the
 * scrape writers) being deployed first: without it, the NEXT scrape cycle's
 * image-less pass would overwrite the poster this job just wrote. This
 * writer's own `image_url IS NULL` guard only protects against a write
 * ordered BEFORE a null-image write from the same instant — it can't protect
 * against a straight `image_url: values.image_url` overwrite on the next
 * scrape tick. See BS#1743 for the full dependency note.
 */

import { and, inArray, isNull } from 'drizzle-orm';
import { concerts, db } from '@wxyc/database';

/** One artist's resolved poster image, ready to fan out to every concert row it headlines. */
export type ConcertImageRow = {
  discogs_artist_id: number;
  concert_ids: number[];
  image_url: string;
};

/**
 * Write the batch, one UPDATE per artist row (each internally scoped to that
 * artist's concert ids). Returns the count of concert rows actually updated —
 * a concert whose `image_url` was no longer NULL by write time (raced by a
 * concurrent write) silently drops out of the count rather than erroring.
 */
export const writeConcertImages = async (rows: ConcertImageRow[]): Promise<{ updated: number }> => {
  if (rows.length === 0) return { updated: 0 };

  let updated = 0;
  for (const row of rows) {
    if (row.concert_ids.length === 0) continue;
    const result = await db
      .update(concerts)
      .set({ image_url: row.image_url })
      .where(and(inArray(concerts.id, row.concert_ids), isNull(concerts.image_url)))
      .returning({ id: concerts.id });
    updated += result.length;
  }
  return { updated };
};
