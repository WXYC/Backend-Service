import { Request, RequestHandler } from 'express';
import * as labelsService from '../services/labels.service.js';
import WxycError from '../utils/error.js';

type CreateLabelRequest = {
  label_name: string;
  parent_label_id?: number;
};

type UpdateLabelRequest = {
  label_name?: string;
  parent_label_id?: number | null;
};

export const getLabels: RequestHandler = async (req, res) => {
  const labels = await labelsService.getAllLabels();
  res.status(200).json(labels);
};

export const getLabel: RequestHandler<object, unknown, unknown, { id: string }> = async (req, res) => {
  const id = parseInt(req.query.id);
  if (isNaN(id)) throw new WxycError('Missing or invalid label id', 400);

  const label = await labelsService.getLabelById(id);
  if (label) {
    res.status(200).json(label);
  } else {
    res.status(404).json({ message: 'Label not found' });
  }
};

export const createLabel: RequestHandler = async (req: Request<object, object, CreateLabelRequest>, res) => {
  const { body } = req;
  if (!body.label_name) throw new WxycError('Missing required parameter: label_name', 400);

  const label = await labelsService.createLabel(body.label_name, body.parent_label_id);
  res.status(200).json(label);
};

export const searchLabelsEndpoint: RequestHandler<object, unknown, unknown, { q: string; limit?: string }> = async (
  req,
  res
) => {
  const query = req.query.q;
  if (!query) throw new WxycError('Missing required query parameter: q', 400);

  const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
  const labels = await labelsService.searchLabels(query, limit);
  res.status(200).json(labels);
};

const MAX_LABEL_ID = 2147483647; // labels.id is a 32-bit serial; anything larger would reach Postgres as an overflow.
const isLabelId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LABEL_ID;

const parseLabelId = (raw: string): number => {
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!isLabelId(id)) throw new WxycError('Missing or invalid label id', 400);
  return id;
};

const NOT_FOUND = () => new WxycError('Label not found', 404);

export const getLabelWithReferences: RequestHandler<{ id: string }> = async (req, res) => {
  const label = await labelsService.getLabelWithReferences(parseLabelId(req.params.id));
  if (!label) throw NOT_FOUND();
  res.status(200).json(label);
};

export const updateLabel: RequestHandler<{ id: string }, unknown, UpdateLabelRequest> = async (req, res) => {
  const id = parseLabelId(req.params.id);
  const { label_name, parent_label_id } = req.body ?? {};
  const edits: UpdateLabelRequest = {};
  if (label_name !== undefined) {
    if (typeof label_name !== 'string' || !label_name.trim() || label_name.trim().length > 128) {
      throw new WxycError('label_name must be a non-empty string of at most 128 characters', 400);
    }
    edits.label_name = label_name.trim();
  }
  if (parent_label_id !== undefined) {
    if (parent_label_id !== null && !isLabelId(parent_label_id)) {
      throw new WxycError('parent_label_id must be an integer or null', 400);
    }
    edits.parent_label_id = parent_label_id;
  }
  if (Object.keys(edits).length === 0) throw new WxycError('Provide label_name or parent_label_id', 400);

  const result = await labelsService.updateLabel(id, edits);
  if (!result) throw NOT_FOUND();
  res.status(200).json(result);
};

export const deleteLabel: RequestHandler<{ id: string }> = async (req, res) => {
  if (!(await labelsService.deleteLabel(parseLabelId(req.params.id)))) throw NOT_FOUND();
  res.status(204).end();
};
