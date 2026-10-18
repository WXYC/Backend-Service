import { Request, RequestHandler, Response } from 'express';
import { getDJsInCurrentShow } from '../services/flowsheet.service.js';

const isDevAuthBypass = () => process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV === 'development';

const callerId = (req: Pick<Request, 'auth'>, res: Pick<Response, 'locals'>) =>
  req.auth?.id || req.auth?.sub || res.locals.decodedJWT?.id || res.locals.decodedJWT?.userId;

/**
 * The caller identity for the row-scoped write gate (BS#3438): the DJ id (empty when none resolves, which matches
 * no member), or null under the same development-only AUTH_BYPASS the middleware honors below.
 */
export const rowWriteCaller = (req: Pick<Request, 'auth'>, res: Pick<Response, 'locals'>): string | null =>
  isDevAuthBypass() ? null : (callerId(req, res) ?? '');

export const showMemberMiddleware: RequestHandler = async (req, res, next) => {
  // Positive-list gate (BS#1097): bypass requires explicit NODE_ENV=development.
  // Previously this middleware had no NODE_ENV gate at all, so a stray
  // `AUTH_BYPASS=true` in any environment would skip show-membership checks.
  // NODE_ENV=test was dropped from the list (BS#1533): the integration env
  // runs with AUTH_BYPASS=true, and short-circuiting here left the deployed
  // membership chain untested. The auth bypass still populates req.auth.id
  // (JWT decode or raw user-id fallback), so the check below runs correctly
  // under bypass; only local dev keeps the hatch.
  if (isDevAuthBypass()) {
    return next();
  }

  try {
    const show_djs = await getDJsInCurrentShow();
    const user_id = callerId(req, res);
    const dj_in_show = show_djs.some((dj) => dj.id === user_id);

    if (!dj_in_show) {
      res.status(400).json({ message: 'Bad Request: DJ not a member of show' });
      return;
    }
    next();
  } catch (e) {
    next(e);
  }
};
