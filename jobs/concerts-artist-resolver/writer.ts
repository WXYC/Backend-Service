/**
 * Writer for jobs/concerts-artist-resolver (BS#1372).
 *
 * Idempotent single-row UPDATE that stamps a resolved canonical
 * `artists.id` onto a `concerts` row. The WHERE clause guards on
 * `headlining_artist_id IS NULL`, so a rerun is safe and a concurrent
 * pod cannot clobber an existing FK — that case manifests as a 0-row
 * UPDATE which the orchestrator reads via `written: false` and rolls
 * into its `raced` counter.
 *
 * The resolver is conservatively write-once-trust-forever per the
 * substrate intent (#1347): once a FK lands, no subsequent pass will
 * revisit the row even if alias-substrate growth would now produce a
 * different singleton match.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, concerts } from '@wxyc/database';

export const writeArtistId = async (concertId: number, artistId: number): Promise<{ written: boolean }> => {
  const updated = await db
    .update(concerts)
    .set({ headlining_artist_id: artistId })
    .where(and(eq(concerts.id, concertId), isNull(concerts.headlining_artist_id)))
    .returning({ id: concerts.id });
  return { written: updated.length === 1 };
};
