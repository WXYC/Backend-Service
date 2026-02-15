import { Request, RequestHandler } from 'express';
import * as labelsService from '../services/labels.service.js';

type CreateLabelRequest = {
  label_name: string;
  parent_label_id?: number;
};

export const getLabels: RequestHandler = async (req, res, next) => {
  try {
    const labels = await labelsService.getAllLabels();
    res.status(200).json(labels);
  } catch (e) {
    console.error('Error retrieving labels');
    console.error(e);
    next(e);
  }
};

export const getLabel: RequestHandler<object, unknown, unknown, { id: string }> = async (req, res, next) => {
  const id = parseInt(req.query.id);
  if (isNaN(id)) {
    res.status(400).json({ message: 'Missing or invalid label id' });
  } else {
    try {
      const label = await labelsService.getLabelById(id);
      if (label) {
        res.status(200).json(label);
      } else {
        res.status(404).json({ message: 'Label not found' });
      }
    } catch (e) {
      console.error('Error retrieving label');
      console.error(e);
      next(e);
    }
  }
};

export const createLabel: RequestHandler = async (
  req: Request<object, object, CreateLabelRequest>,
  res,
  next
) => {
  const { body } = req;
  if (!body.label_name) {
    res.status(400).json({ message: 'Missing required parameter: label_name' });
  } else {
    try {
      const label = await labelsService.createLabel(body.label_name, body.parent_label_id);
      res.status(200).json(label);
    } catch (e) {
      console.error('Error creating label');
      console.error(e);
      next(e);
    }
  }
};

export const searchLabelsEndpoint: RequestHandler<object, unknown, unknown, { q: string; limit?: string }> = async (
  req,
  res,
  next
) => {
  const query = req.query.q;
  if (!query) {
    res.status(400).json({ message: 'Missing required query parameter: q' });
  } else {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
      const labels = await labelsService.searchLabels(query, limit);
      res.status(200).json(labels);
    } catch (e) {
      console.error('Error searching labels');
      console.error(e);
      next(e);
    }
  }
};
