import { Router } from 'express';
import * as djsController from '../contollers/djs.controller';

export const dj_route = Router();

//secure: mgmt
dj_route.post('/register', djsController.register);

//secure: mgmt & individual dj
dj_route.get('/info', djsController.info);
