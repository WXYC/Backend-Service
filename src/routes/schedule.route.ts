import { Router } from 'express';
import * as scheduleController from '../controllers/schedule.controller';

export const schedule_route = Router();

schedule_route.get('/', scheduleController.getSchedule);

schedule_route.post('/', scheduleController.addToSchedule);

/*
schedule_route.delete('/', scheduleController.removeFromSchedule);

schedule_route.patch('/', scheduleController.updateSchedule);
*/
