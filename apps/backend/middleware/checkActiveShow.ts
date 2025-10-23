import { RequestHandler } from 'express';
import { getLatestShow } from '../services/flowsheet.service.js';

export const activeShow: RequestHandler = async (req, res, next) => {
  const latestShow = await getLatestShow();
  if (latestShow.end_time !== null) {
    res.status(400).json({ message: 'Bad Request: No active show' });
  } else {
    next();
  }
};
