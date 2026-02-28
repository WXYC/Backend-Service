import { eq, sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { reviews } from '@wxyc/database';

export const getReviewByAlbumId = async (albumId: number) => {
  const result = await db
    .select()
    .from(reviews)
    .where(eq(reviews.album_id, albumId))
    .limit(1);
  return result[0];
};

export const upsertReview = async (albumId: number, review: string, author?: string) => {
  const result = await db
    .insert(reviews)
    .values({
      album_id: albumId,
      review,
      author: author ?? null,
    })
    .onConflictDoUpdate({
      target: reviews.album_id,
      set: {
        review,
        author: author ?? null,
        last_modified: sql`now()`,
      },
    })
    .returning();
  return result[0];
};
