import { db, user_activity } from '@wxyc/database';
import { eq, sql } from 'drizzle-orm';

/**
 * Records activity for a user, incrementing their request count and updating lastSeenAt.
 * Uses upsert to handle both new and existing users.
 *
 * @param userId - The user ID to record activity for
 */
export async function recordActivity(userId: string): Promise<void> {
  await db
    .insert(user_activity)
    .values({
      userId,
      requestCount: 1,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: user_activity.userId,
      set: {
        requestCount: sql`${user_activity.requestCount} + 1`,
        lastSeenAt: new Date(),
      },
    });
}

/**
 * Gets activity data for a user.
 *
 * @param userId - The user ID to get activity for
 * @returns The user activity record or null if not found
 */
export async function getActivity(userId: string) {
  const result = await db.select().from(user_activity).where(eq(user_activity.userId, userId)).limit(1);
  return result[0] || null;
}
