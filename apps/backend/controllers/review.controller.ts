import { Request, RequestHandler } from 'express';
import * as reviewService from '../services/review.service.js';

export const getReview: RequestHandler = async (
  req: Request<object, object, object, { album_id?: string }>,
  res,
  next
) => {
  const { query } = req;
  if (query.album_id === undefined) {
    res.status(400).send('Bad Request, Missing Parameter: album_id');
  } else {
    try {
      const review = await reviewService.getReviewByAlbumId(parseInt(query.album_id));
      res.status(200).json(review ?? null);
    } catch (e) {
      console.error('Error retrieving review');
      console.error(e);
      next(e);
    }
  }
};

type UpsertReviewBody = {
  album_id?: number;
  review?: string;
  author?: string;
};

export const upsertReview: RequestHandler = async (req: Request<object, object, UpsertReviewBody>, res, next) => {
  const { body } = req;
  if (body.album_id === undefined || body.review === undefined) {
    res.status(400).send('Bad Request, Missing Parameters: album_id and review are required');
  } else {
    try {
      const result = await reviewService.upsertReview(body.album_id, body.review, body.author);
      res.status(200).json(result);
    } catch (e) {
      console.error('Error upserting review');
      console.error(e);
      next(e);
    }
  }
};
