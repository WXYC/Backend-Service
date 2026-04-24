import { Request, RequestHandler } from 'express';
import * as labelsService from '../services/labels.service.js';
import WxycError from '../utils/error.js';

type CreateLabelRequest = {
  label_name: string;
  parent_label_id?: number;
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
