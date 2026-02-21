import { RequestHandler } from 'express';
import { getDJsInCurrentShow } from '../services/flowsheet.service.js';

export const showMemberMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const show_djs = await getDJsInCurrentShow();
    const user_id = req.auth?.id || req.auth?.sub || res.locals.decodedJWT?.id || res.locals.decodedJWT?.userId;
    const dj_in_show = show_djs.some((dj) => dj.id === user_id);

    if (dj_in_show) {
      next();
    } else {
      res.status(400).json({ message: 'Bad Request: DJ not a member of show' });
    }
  } catch {
    res.status(500).json({ message: 'Internal server error checking show membership' });
  }
};
