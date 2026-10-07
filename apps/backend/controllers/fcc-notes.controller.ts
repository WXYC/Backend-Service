import type { RequestHandler } from 'express';
import * as fccNotesService from '../services/fcc-notes.service.js';
import WxycError from '../utils/error.js';
import { parseInt4QueryParam } from '../utils/query-params.js';
import { parseRecordSubject } from '../utils/record-subject.js';
import { reviewsActor } from '../utils/review-grants.js';
import { validateTextField } from '../utils/text-fields.js';

/**
 * `/fcc-notes` (BS#2862): HTTP handling over `fcc-notes.service.ts`. Shapes follow `wxyc-shared`'s `FccNote` and
 * `NewFccNoteRequest` as private mirrors. Grants: `routes/fcc-notes.route.ts`.
 */

export const createFccNote: RequestHandler = async (req, res) => {
  const body = req.body ?? {};
  const subject = parseRecordSubject(body);
  // The contract declares no length bound on either, so only the request size limits them.
  const fields = {
    track: validateTextField(body.track, 'track', Infinity),
    note: validateTextField(body.note, 'note', Infinity),
  };
  const result = await fccNotesService.createFccNote(subject, fields, reviewsActor(req));
  if (result.outcome === 'unknown_subject') {
    throw new WxycError(subject.intake_item_id !== undefined ? 'No such intake item' : 'No such library release', 400);
  }
  if (result.outcome === 'no_account') throw new WxycError('Your account has no name to report a note under', 403);
  // The notice to the music directors (BS#2863) is sent here, after the transaction has committed, as
  // `void notify…(result.notice)`, never awaited.
  res.json(result.note);
};

export const listFccNotes: RequestHandler = async (req, res) => {
  const album_id = parseInt4QueryParam(req.query.album_id, 'album_id');
  const intake_item_id = parseInt4QueryParam(req.query.intake_item_id, 'intake_item_id');
  if (album_id !== undefined && intake_item_id === undefined)
    return void res.json(await fccNotesService.listFccNotes({ album_id }));
  if (intake_item_id !== undefined && album_id === undefined) {
    return void res.json(await fccNotesService.listFccNotes({ intake_item_id }));
  }
  throw new WxycError('Send exactly one of album_id and intake_item_id', 400);
};
