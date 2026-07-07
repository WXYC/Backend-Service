import { RequestHandler } from 'express';
import { getDJsInCurrentShow } from '../services/flowsheet.service.js';

export const showMemberMiddleware: RequestHandler = async (req, res, next) => {
  // Positive-list gate (BS#1097): bypass requires explicit NODE_ENV=development.
  // Previously this middleware had no NODE_ENV gate at all, so a stray
  // `AUTH_BYPASS=true` in any environment would skip show-membership checks.
  // NODE_ENV=test was dropped from the list (BS#1533): the integration env
  // runs with AUTH_BYPASS=true, and short-circuiting here left the deployed
  // membership chain untested. The auth bypass still populates req.auth.id
  // (JWT decode or raw user-id fallback), so the check below runs correctly
  // under bypass; only local dev keeps the hatch.
  if (process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV === 'development') {
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
