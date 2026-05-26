import { RequestHandler } from 'express';
import { getDJsInCurrentShow } from '../services/flowsheet.service.js';

export const showMemberMiddleware: RequestHandler = async (req, res, next) => {
  // Positive-list gate (BS#1097): bypass requires explicit dev/test NODE_ENV.
  // Previously this middleware had no NODE_ENV gate at all, so a stray
  // `AUTH_BYPASS=true` in any environment would skip show-membership checks.
  if (
    process.env.AUTH_BYPASS === 'true' &&
    (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
  ) {
    return next();
  }

  try {
    const show_djs = await getDJsInCurrentShow();
    const user_id = req.auth?.id || req.auth?.sub || res.locals.decodedJWT?.id || res.locals.decodedJWT?.userId;
    const dj_in_show = show_djs.some((dj) => dj.id === user_id);

    if (dj_in_show) {
      next();
    } else {
      res.status(400).json({ message: 'Bad Request: DJ not a member of show' });
    }
  } catch (e) {
    next(e);
  }
};
