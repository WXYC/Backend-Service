import { RequestHandler } from 'express';
import { getDJsInCurrentShow } from '../services/flowsheet.service.js';

export const showMemberMiddleware: RequestHandler = async (req, res, next) => {
  const show_djs = await getDJsInCurrentShow();
  // Get user ID from JWT - check both req.auth (from better-auth middleware) and res.locals (legacy)
  const user_id = req.auth?.id || req.auth?.sub || res.locals.decodedJWT?.id || res.locals.decodedJWT?.userId;
  const dj_in_show = show_djs.filter((dj) => {
    return dj.id === user_id;
  }).length;

  if (dj_in_show > 0) {
    next();
  } else {
    res.status(400).json({ message: 'Bad Request: DJ not a member of show' });
  }
};
