import { reviewCreditEnum } from '@wxyc/database';
import type { RequestHandler } from 'express';
import * as reviewsService from '../services/reviews.service.js';
import { AUTHOR_MAX, type OnBehalf, type ReviewFields } from '../services/reviews.service.js';
import WxycError from '../utils/error.js';
import { notifyReviewSubmitted } from '../services/review-notices.service.js';
import {
  parseBooleanQueryParam,
  parseInt4BodyId,
  parseInt4PathId,
  parseInt4QueryParam,
} from '../utils/query-params.js';
import { reviewsActor } from '../utils/review-grants.js';
import { normalizeOptionalText, validateTextField } from '../utils/text-fields.js';

/**
 * `/reviews` (BS#2802): HTTP handling over `reviews.service.ts`. Shapes follow `wxyc-shared`'s
 * `NewReviewRequest` / `ReviewPatch` / `Review` as private mirrors (Backend-Service stays on
 * `@wxyc/shared` 5.x). Grants: `routes/reviews.route.ts`.
 */

const TEXT_FIELDS = ['buzzwords', 'artist_blurb', 'review', 'recommended_tracks', 'fcc'] as const;
const FLAG_FIELDS = ['publish_website', 'publish_apps', 'publish_instagram'] as const;

/** The on-behalf keys (slice 13e). Without `reviews: manage` any of them is a 403. */
const ON_BEHALF_KEYS = ['author', 'author_user_id', 'medium', 'accept'];

/** The `ReviewFields` in a body. The text columns are unbounded `text`, so only the request size limits them. */
const parseFields = (body: Record<string, unknown>): ReviewFields => {
  const fields: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) fields[key] = normalizeOptionalText(body[key], key, Infinity);
  for (const key of FLAG_FIELDS) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new WxycError(`${key} must be a boolean`, 400);
    fields[key] = body[key];
  }
  const credit = body.credit;
  if (credit !== undefined && credit !== null && !reviewCreditEnum.enumValues.includes(credit as never)) {
    throw new WxycError(`credit must be one of ${reviewCreditEnum.enumValues.join(', ')} or null`, 400);
  }
  fields.credit = credit;
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
};

const conflict = (
  res: Parameters<RequestHandler>[1],
  reason: 'subject_not_held' | 'not_draft' | 'in_use' | 'accepted_review',
  message: string
) => res.status(409).json({ message, reason });

/**
 * The on-behalf keys of a body: `author` is required and kept whole (a long one is a 400, never cut, because the
 * music director typed it), `medium` is `typed` (the default) or `handwritten`, and `accept` defaults to true
 * for an intake item and may not be sent for a release. Nothing may be ticked for publishing and `credit` stays null:
 * the author never saw the question.
 */
const parseOnBehalf = (body: Record<string, unknown>, hasItem: boolean): OnBehalf => {
  const author = validateTextField(body.author, 'author', AUTHOR_MAX);
  const { author_user_id, medium = 'typed', accept } = body;
  if (author_user_id !== undefined && (typeof author_user_id !== 'string' || author_user_id === '')) {
    throw new WxycError('author_user_id must be a non-empty string', 400);
  }
  if (medium !== 'typed' && medium !== 'handwritten') throw new WxycError('medium must be typed or handwritten', 400);
  if (accept !== undefined && typeof accept !== 'boolean') throw new WxycError('accept must be a boolean', 400);
  if (accept !== undefined && !hasItem) throw new WxycError('accept applies only to an intake_item_id subject', 400);
  if (FLAG_FIELDS.some((key) => body[key] === true) || (body.credit !== undefined && body.credit !== null)) {
    throw new WxycError('An on-behalf review starts with no publishing choice set', 400);
  }
  return { author, author_user_id, medium, accept: hasItem && accept !== false };
};

export const createReview: RequestHandler = async (req, res) => {
  const body = req.body ?? {};
  const actor = reviewsActor(req);
  const onBehalf = ON_BEHALF_KEYS.some((key) => key in body);
  if (onBehalf && !actor.manage)
    throw new WxycError('author, author_user_id, medium and accept require reviews: manage', 403);
  const intake_item_id = parseInt4BodyId(body.intake_item_id, 'intake_item_id');
  const album_id = parseInt4BodyId(body.album_id, 'album_id');
  if ((intake_item_id === undefined) === (album_id === undefined)) {
    throw new WxycError('Send exactly one of intake_item_id and album_id', 400);
  }
  const subject = { intake_item_id, album_id };
  const fields = parseFields(body);
  const result = onBehalf
    ? await reviewsService.recordReview(subject, fields, parseOnBehalf(body, intake_item_id !== undefined), actor)
    : await reviewsService.createReview(subject, fields, actor);
  if (result.outcome === 'subject_not_held') {
    return void conflict(res, 'subject_not_held', 'You do not hold this intake item, or the subject does not exist');
  }
  if (result.outcome === 'text_required') throw new WxycError('A typed review needs text to be accepted', 400);
  if (result.outcome === 'unknown_author') throw new WxycError('author_user_id names no account', 400);
  // The notice to a linked DJ (BS#2864) is sent here, after the transaction has committed.
  res.json(result.review);
};

export const patchReview: RequestHandler<{ id: string }> = async (req, res) => {
  const id = parseInt4PathId(req.params.id, 'review');
  const patch = parseFields(req.body ?? {});
  if (Object.keys(patch).length === 0) throw new WxycError('No editable fields supplied', 400);
  const result = await reviewsService.updateReview(id, patch, reviewsActor(req));
  if (result.outcome === 'not_found') throw new WxycError('Review not found', 404);
  if (result.outcome === 'forbidden') throw new WxycError('You may not edit this review', 403);
  if (result.outcome === 'consent_forbidden')
    throw new WxycError("Only the review's author may set its publishing choices", 403);
  if (result.outcome === 'text_required')
    throw new WxycError('A submitted typed review must keep its review text', 400);
  res.json(result.review);
};

export const submitReview: RequestHandler<{ id: string }> = async (req, res) => {
  const result = await reviewsService.submitReview(parseInt4PathId(req.params.id, 'review'), reviewsActor(req));
  if (result.outcome === 'not_found') throw new WxycError('Review not found', 404);
  if (result.outcome === 'not_draft') return void conflict(res, 'not_draft', 'This review is already submitted');
  if (result.outcome === 'text_required') throw new WxycError('A typed review needs text to be submitted', 400);
  if (result.outcome !== 'submitted') throw new WxycError('You may not submit this review', 403);
  // After the commit and not awaited: a slow or hung SES must not hold a committed submit's response, or a client's
  // retry would meet 409 not_draft. The notice logs and reports its own failures and never rejects.
  if (result.notice) void notifyReviewSubmitted(result.notice);
  res.json(result.review);
};

export const deleteReview: RequestHandler<{ id: string }> = async (req, res) => {
  const result = await reviewsService.deleteReview(parseInt4PathId(req.params.id, 'review'), reviewsActor(req));
  if (result.outcome === 'not_found') throw new WxycError('Review not found', 404);
  if (result.outcome === 'in_use') {
    return void conflict(res, 'in_use', 'This review is accepted for an item or is the latest print of a copy');
  }
  if (result.outcome === 'accepted_review') {
    return void conflict(res, 'accepted_review', 'This is the accepted review of a filed item');
  }
  if (result.outcome !== 'deleted') throw new WxycError('You may not delete this review', 403);
  res.status(204).end();
};

export const getReview: RequestHandler<{ id: string }> = async (req, res) => {
  const review = await reviewsService.getReview(parseInt4PathId(req.params.id, 'review'), reviewsActor(req));
  if (!review) throw new WxycError('Review not found', 404);
  res.json(review);
};

export const listReviews: RequestHandler = async (req, res) => {
  const filters = {
    album_id: parseInt4QueryParam(req.query.album_id, 'album_id'),
    intake_item_id: parseInt4QueryParam(req.query.intake_item_id, 'intake_item_id'),
    mine: parseBooleanQueryParam(req.query.mine, 'mine'),
  };
  res.json(await reviewsService.listReviews(filters, reviewsActor(req)));
};

export const listReviewRevisions: RequestHandler<{ id: string }> = async (req, res) => {
  const revisions = await reviewsService.listReviewRevisions(
    parseInt4PathId(req.params.id, 'review'),
    reviewsActor(req)
  );
  if (!revisions) throw new WxycError('Review not found', 404);
  res.json(revisions);
};
