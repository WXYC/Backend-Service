import { Router } from 'express';
import * as djsController from '../controllers/djs.controller';

export const dj_route = Router();

//secure: mgmt
dj_route.post('/register', djsController.register);

//secure: mgmt & individual dj
dj_route.get('/info', djsController.info);

dj_route.post('bin', djsController.binUpdater);

//dj_route.get('bin', djsController.getBin)
