import { RequestHandler } from 'express';
import { getDJsInCurrentShow } from '../services/flowsheet.service';

export const showMemberMiddleware: RequestHandler = async (req, res, next) => {
  const show_djs = await getDJsInCurrentShow();
  const dj_in_show = show_djs.filter((dj) => {
    return dj.cognito_user_name === res.locals.decodedJWT.username;
  }).length;

  if (dj_in_show > 0) {
    next();
  } else {
    res.status(400).json({ message: 'Bad Request: DJ not a member of show' });
  }
};
