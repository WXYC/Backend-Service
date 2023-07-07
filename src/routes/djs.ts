import { Router, Request, Response } from 'express';
import { /*raise_error,*/ insertNewDJ } from '../services/djs_service';
import { NewDJ, DJ, djs } from '../db/schema';
import { db } from '../db/drizzle_client';
import { sql } from 'drizzle-orm';
import * as djsController from '../contollers/djs.controller';

export const router = Router();

//secure: mgmt
router.post('/register', djsController.register);

//secure: mgmt
router.get('/info', djsController.info);
