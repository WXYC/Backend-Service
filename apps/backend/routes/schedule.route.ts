import { Router } from 'express';
import * as scheduleController from '../controllers/schedule.controller.js';
import { authMiddleware, requireStationManagement } from '@wxyc/auth-middleware';

export const schedule_route = Router();

// View schedule - public access
schedule_route.get('/', scheduleController.getSchedule);

// Modify schedule - Station Management only
schedule_route.post('/', authMiddleware(), 
  requireStationManagement, scheduleController.addToSchedule);

/*
// Future schedule management routes - Station Management only
schedule_route.delete('/', authMiddleware(), 
  requireStationManagement, scheduleController.removeFromSchedule);

schedule_route.patch('/', authMiddleware(), 
  requireStationManagement, scheduleController.updateSchedule);
*/
