import { ScheduleEntry } from '../controllers/schedule.controller';
import { db } from '../db/drizzle_client';
import { schedule } from '../db/schema';

export const getSchedule = async () => {
  const response = await db.select().from(schedule);

  return response;
};