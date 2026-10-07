import type { RequestHandler } from 'express';
import * as fccNotesService from '../services/fcc-notes.service.js';
import { notifyFccNoteReported } from '../services/review-notices.service.js';
import WxycError from '../utils/error.js';
import { parseInt4PathId, parseInt4QueryParam } from '../utils/query-params.js';
import { parseRecordSubject } from '../utils/record-subject.js';
import { holdsReviewsManage, reviewsActor } from '../utils/review-grants.js';
import { validateTextField } from '../utils/text-fields.js';

/**
 * `/fcc-notes` (BS#2862): HTTP handling over `fcc-notes.service.ts`. Shapes follow `wxyc-shared`'s `FccNote` and
 * `NewFccNoteRequest` as private mirrors. Grants: `routes/fcc-notes.route.ts`.
 */

const STATUSES: readonly fccNotesService.FccNoteStatus[] = ['reported', 'confirmed'];

export const createFccNote: RequestHandler = async (req, res) => {
  const body = req.body ?? {};
  const subject = parseRecordSubject(body);
  // The contract declares no length bound on either, so only the request size limits them.
  const fields = {
    track: validateTextField(body.track, 'track', Infinity),
    note: validateTextField(body.note, 'note', Infinity),
  };
  const actor = reviewsActor(req);
  const result = await fccNotesService.createFccNote(subject, fields, actor);
  if (result.outcome === 'unknown_subject') {
    throw new WxycError(subject.intake_item_id !== undefined ? 'No such intake item' : 'No such library release', 400);
  }
  if (result.outcome === 'no_account') throw new WxycError('Your account has no name to report a note under', 403);
  // After the commit and not awaited, so a slow SES never holds the response; the notice logs and swallows its own
  // failures. A music director's own report tells the music directors nothing.
  if (!actor.manage) void notifyFccNoteReported(result.notice);
  res.json(result.note);
};

/**
 * A record's list sends exactly one subject (and optionally a `status`); the music directors' waiting list sends
 * `status=reported` and no subject and needs `reviews: manage`, which the route's `reviews: read` gate does not imply.
 * Every other combination is a 400, whatever the caller's grants.
 */
export const listFccNotes: RequestHandler = async (req, res) => {
  const album_id = parseInt4QueryParam(req.query.album_id, 'album_id');
  const intake_item_id = parseInt4QueryParam(req.query.intake_item_id, 'intake_item_id');
  const rawStatus = req.query.status;
  if (rawStatus !== undefined && !STATUSES.includes(rawStatus as fccNotesService.FccNoteStatus)) {
    throw new WxycError('status must be reported or confirmed', 400);
  }
  const status = rawStatus as fccNotesService.FccNoteStatus | undefined;
  if (album_id !== undefined && intake_item_id === undefined) {
    return void res.json(await fccNotesService.listFccNotes({ album_id, status }));
  }
  if (intake_item_id !== undefined && album_id === undefined) {
    return void res.json(await fccNotesService.listFccNotes({ intake_item_id, status }));
  }
  if (album_id === undefined && intake_item_id === undefined && status === 'reported') {
    if (!holdsReviewsManage(req)) throw new WxycError('Only a music director may list every unconfirmed note', 403);
    return void res.json(await fccNotesService.listReportedFccNotes());
  }
  throw new WxycError('Send exactly one of album_id and intake_item_id, or status=reported alone', 400);
};

export const confirmFccNote: RequestHandler<{ id: string }> = async (req, res) => {
  const result = await fccNotesService.confirmFccNote(parseInt4PathId(req.params.id, 'FCC note'), reviewsActor(req));
  if (result.outcome === 'no_account') throw new WxycError('Your account has no name to confirm a note under', 403);
  if (result.outcome === 'not_found') throw new WxycError('FCC note not found', 404);
  res.json(result.note);
};

export const deleteFccNote: RequestHandler<{ id: string }> = async (req, res) => {
  const result = await fccNotesService.deleteFccNote(parseInt4PathId(req.params.id, 'FCC note'), reviewsActor(req));
  if (result.outcome === 'not_found') throw new WxycError('FCC note not found', 404);
  if (result.outcome === 'forbidden') throw new WxycError('You may not delete this FCC note', 403);
  res.status(204).end();
};
