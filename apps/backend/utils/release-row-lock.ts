import { db, library } from '@wxyc/database';
import { eq } from 'drizzle-orm';

/**
 * Locks a library row `FOR KEY SHARE`, so a concurrent `DELETE /library/{id}` waits; answers whether the row exists.
 * It is the first lock in that delete's order (library row, then intake items, then reviews), so every writer that
 * points a row at a release takes it first.
 *
 * A leaf module: `intake.service`, `library.service` and `reviews.service` all need it, and `library.service`
 * importing `intake.service` would close an import cycle through `library-filing.service`.
 */
export const lockReleaseRow = async (tx: Pick<typeof db, 'select'>, albumId: number) =>
  (await tx.select({ id: library.id }).from(library).where(eq(library.id, albumId)).for('key share')).length > 0;
