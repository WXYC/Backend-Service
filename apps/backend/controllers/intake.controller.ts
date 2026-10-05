import { roleGrants } from '@wxyc/authentication';
import { intakeItemStateEnum } from '@wxyc/database';
import type { RequestHandler, Response } from 'express';
import * as intakeService from '../services/intake.service.js';
import type { IntakeAction, IntakeCitations, IntakeFields, IntakeItemState } from '../services/intake.service.js';
import WxycError from '../utils/error.js';
import { parseInt4BodyId, parseInt4PathId } from '../utils/query-params.js';
import { holdsReviewsManage, reviewsActor } from '../utils/review-grants.js';
import { normalizeOptionalText, validateTextField } from '../utils/text-fields.js';

/**
 * `/intake` (BS#2796): HTTP handling over `intake.service.ts`, which owns the
 * effective-state definition. Request/response shapes follow `wxyc-shared`'s
 * `NewIntakeItemRequest` / `IntakeItemPatch` / `IntakeItem`; Backend-Service
 * stays on `@wxyc/shared` 5.x, so they are private mirrors (the
 * `LibraryFilingRequestBody` precedent). Grants: `routes/intake.route.ts`.
 */

const TEXT_MAX = 128;

const parseId = (raw: string) => parseInt4PathId(raw, 'intake item');

/** The varchar(128) trio plus the two nullable ids; `undefined` means "not supplied". */
const parseFields = (body: Record<string, unknown>, requireAll: boolean): Partial<IntakeFields> & IntakeCitations => {
  const required = (key: 'artist_name' | 'album_title') =>
    body[key] === undefined && !requireAll ? undefined : validateTextField(body[key], key, TEXT_MAX);
  const format_id = parseInt4BodyId(body.format_id, 'format_id');
  if (requireAll && format_id === undefined) throw new WxycError('format_id is required', 400);
  return {
    artist_name: required('artist_name'),
    album_title: required('album_title'),
    record_label: normalizeOptionalText(body.record_label, 'record_label', TEXT_MAX),
    label_id: parseInt4BodyId(body.label_id, 'label_id', { nullable: true }),
    format_id,
    discogs_release_id: parseInt4BodyId(body.discogs_release_id, 'discogs_release_id', { nullable: true }),
    // Citations are set by PATCH only; a new item starts uncited.
    ...(!requireAll && {
      cited_album_id: parseInt4BodyId(body.cited_album_id, 'cited_album_id', { nullable: true }),
      cited_submission_id: parseInt4BodyId(body.cited_submission_id, 'cited_submission_id', { nullable: true }),
    }),
  };
};

const CONFLICT_MESSAGES = {
  already_filed: 'Intake item is already filed',
  invalid_citation: 'The cited release or submission is not a valid citation',
  state_changed: 'Intake item is no longer in the state this action needs',
};
const conflict = (res: Response, reason: keyof typeof CONFLICT_MESSAGES) =>
  res.status(409).json({ message: CONFLICT_MESSAGES[reason], reason });

export const listIntake: RequestHandler = async (req, res) => {
  const { state } = req.query;
  if (state !== undefined && !intakeItemStateEnum.enumValues.includes(state as IntakeItemState)) {
    throw new WxycError(`Invalid Parameter: state must be one of ${intakeItemStateEnum.enumValues.join(', ')}`, 400);
  }
  res.json(
    await intakeService.listIntakeItems({
      state: state as IntakeItemState | undefined,
      includePasses: holdsReviewsManage(req),
    })
  );
};

export const getIntake: RequestHandler<{ id: string }> = async (req, res) => {
  const item = await intakeService.getIntakeItem(parseId(req.params.id), holdsReviewsManage(req));
  if (!item) throw new WxycError('Intake item not found', 404);
  res.json(item);
};

export const logIntake: RequestHandler = async (req, res) => {
  const fields = parseFields(req.body ?? {}, true) as IntakeFields;
  const result = await intakeService.logIntakeItem(fields, (req.auth?.id ?? req.auth?.sub) as string);
  if (result.outcome === 'unknown_reference') throw new WxycError('format_id or label_id does not exist', 400);
  res.json(result.item);
};

export const patchIntake: RequestHandler<{ id: string }> = async (req, res) => {
  const body = req.body ?? {};
  const patch = Object.fromEntries(Object.entries(parseFields(body, false)).filter(([, v]) => v !== undefined));
  if (patch.cited_album_id != null && patch.cited_submission_id != null) {
    throw new WxycError('cited_album_id and cited_submission_id cannot both be set', 400);
  }
  if (Object.keys(patch).length === 0) throw new WxycError('No editable fields supplied', 400);
  const result = await intakeService.updateIntakeItem(parseId(req.params.id), patch);
  if (result.outcome === 'not_found') throw new WxycError('Intake item not found', 404);
  if (result.outcome === 'already_filed') return void conflict(res, 'already_filed');
  if (result.outcome === 'invalid_citation') return void conflict(res, 'invalid_citation');
  if (result.outcome === 'unknown_reference') throw new WxycError('format_id or label_id does not exist', 400);
  res.json(result.item);
};

export const deleteIntake: RequestHandler<{ id: string }> = async (req, res) => {
  const { outcome } = await intakeService.deleteIntakeItem(parseId(req.params.id));
  if (outcome === 'not_found') throw new WxycError('Intake item not found', 404);
  if (outcome === 'already_filed') return void conflict(res, 'already_filed');
  // Reviews can't attach to an item until slice 9; slice 10 names their authors here.
  res.json({ deleted_review_authors: [] });
};

/** `/request`'s `dj_id` must name an account whose membership role can accept, or the request would sit in `requested` with nobody able to answer it. */
const parseRequestedDj = async (raw: unknown) => {
  if (typeof raw !== 'string' || raw === '') throw new WxycError('dj_id is required', 400);
  const roles = await intakeService.memberRoles(raw);
  if (!roles.some((role) => roleGrants(role, { reviews: ['write'] }))) {
    throw new WxycError('dj_id must name an account that can review', 400);
  }
  return raw;
};

/** The six `/intake/:id/<action>` transitions. Route grants run first (403), then the UPDATE's own state precondition (409), then identity (403). */
const transition =
  (action: IntakeAction): RequestHandler<{ id: string }> =>
  async (req, res) => {
    const id = parseId(req.params.id);
    const djId = action === 'request' ? await parseRequestedDj(req.body?.dj_id) : undefined;
    const actor = reviewsActor(req);
    const result = await intakeService.transitionIntakeItem(action, id, actor, djId);
    if (result.outcome === 'not_found') throw new WxycError('Intake item not found', 404);
    if (result.outcome === 'forbidden') throw new WxycError('This intake item belongs to another DJ', 403);
    if (result.outcome === 'already_filed' || result.outcome === 'state_changed') {
      return void conflict(res, 'state_changed');
    }
    res.json(result.item);
  };

export const checkoutIntake = transition('checkout');
export const releaseIntake = transition('release');
export const requestIntake = transition('request');
export const cancelIntakeRequest = transition('cancel_request');
export const acceptIntake = transition('accept');
export const passIntake = transition('pass');
