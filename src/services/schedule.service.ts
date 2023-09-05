import { db } from '../db/drizzle_client';
import { NewShift, schedule } from '../db/schema';

export const getSchedule = async () => {
  const response = await db.select().from(schedule);

  return response;
};

export const addToSchedule = async (new_show: NewShift) => {
  const response = await db.insert(schedule).values(new_show).returning();
  return response[0];
};