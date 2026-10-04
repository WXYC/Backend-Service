import { WXYCRoles, normalizeRole } from '@wxyc/authentication';
import { intakeItemStateEnum } from '@wxyc/database';
import type { Request, RequestHandler, Response } from 'express';
import * as intakeService from '../services/intake.service.js';
import type { IntakeFields, IntakeItemState } from '../services/intake.service.js';
import { INT4_MAX } from '../utils/constants.js';
import WxycError from '../utils/error.js';
import { parsePositiveInt } from '../utils/query-params.js';
import { normalizeOptionalText, validateTextField } from '../utils/text-fields.js';

/**
 * `/intake` (BS#2796): HTTP handling over `intake.service.ts`, which owns the
 * effective-state definition. Request/response shapes follow `wxyc-shared`'s
 * `NewIntakeItemRequest` / `IntakeItemPatch` / `IntakeItem`; Backend-Service
 * stays on `@wxyc/shared` 5.x, so they are private mirrors (the
 * `LibraryFilingRequestBody` precedent). Grants: `routes/intake.route.ts`.
 */

const TEXT_MAX = 128;

/** Callers holding `reviews: manage` see each item's `passes`; nobody else does. */
const holdsReviewsManage = (req: Pick<Request, 'auth'>): boolean => {
  const role = req.auth?.role && normalizeRole(req.auth.role);
  return !!role && WXYCRoles[role].authorize({ reviews: ['manage'] }).success;
};

/** `intake_items.id` is int4: past `INT4_MAX` the lookup would be a 22003 → 500, so it is the malformed-id 400. */
const parseId = (raw: string) => {
  const id = parsePositiveInt(raw, 'id');
  if (id > INT4_MAX) throw new WxycError('id must be a positive integer', 400);
  return id;
};

/** The integer body fields are int4 columns; past `INT4_MAX` they would be a 22003 → 500 at the UPDATE/INSERT. */
const intField = (value: unknown, field: string, nullable: boolean): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > INT4_MAX) {
    throw new WxycError(`${field} must be a positive integer${nullable ? ' or null' : ''}`, 400);
  }
  return value as number;
};

/** The varchar(128) trio plus the two nullable ids; `undefined` means "not supplied". */
const parseFields = (body: Record<string, unknown>, requireAll: boolean): Partial<IntakeFields> => {
  const required = (key: 'artist_name' | 'album_title') =>
    body[key] === undefined && !requireAll ? undefined : validateTextField(body[key], key, TEXT_MAX);
  const format_id = intField(body.format_id, 'format_id', false) as number | undefined;
  if (requireAll && format_id === undefined) throw new WxycError('format_id is required', 400);
  return {
    artist_name: required('artist_name'),
    album_title: required('album_title'),
    record_label: normalizeOptionalText(body.record_label, 'record_label', TEXT_MAX),
    label_id: intField(body.label_id, 'label_id', true),
    format_id,
    discogs_release_id: intField(body.discogs_release_id, 'discogs_release_id', true),
  };
};

const conflict = (res: Response, reason: 'already_filed') =>
  res.status(409).json({ message: 'Intake item is already filed', reason });

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
  // Citations are slice 7b; until then a key's presence (even null) is refused.
  if ('cited_album_id' in body || 'cited_submission_id' in body) {
    throw new WxycError('cited_album_id and cited_submission_id cannot be set yet', 400);
  }
  const patch = Object.fromEntries(Object.entries(parseFields(body, false)).filter(([, v]) => v !== undefined));
  if (Object.keys(patch).length === 0) throw new WxycError('No editable fields supplied', 400);
  const result = await intakeService.updateIntakeItem(parseId(req.params.id), patch);
  if (result.outcome === 'not_found') throw new WxycError('Intake item not found', 404);
  if (result.outcome === 'already_filed') return void conflict(res, 'already_filed');
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
