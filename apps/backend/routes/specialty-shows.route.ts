import { Router } from 'express';
import * as specialtyShowsController from '../controllers/specialty-shows.controller.js';

export const specialty_shows_route = Router();

// GET /specialty-shows - unauthenticated catalog (BS#3453)
specialty_shows_route.get('/', specialtyShowsController.getSpecialtyShows);
