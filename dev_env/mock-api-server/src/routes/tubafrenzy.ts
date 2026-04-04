/**
 * Mock tubafrenzy mirror routes.
 *
 * Simulates the /playlists/api/flowsheetEntry endpoint that the
 * Backend-Service's HTTP mirror calls via POST/PATCH.
 */

import { Router, type Request, type Response } from 'express';
import { recordRequest, checkErrorRule } from '../state.js';

const router = Router();
let nextId = 1000;

/** Middleware: record requests and check error rules. */
router.use((req: Request, res: Response, next) => {
  recordRequest({
    service: 'tubafrenzy',
    method: req.method,
    path: req.path,
    query: req.query as Record<string, string>,
    body: req.body,
    timestamp: new Date().toISOString(),
  });

  const error = checkErrorRule('tubafrenzy', req.path);
  if (error) {
    res.status(error.status).json(error.body ?? { error: `Simulated ${error.status}` });
    return;
  }

  next();
});

/** POST /playlists/api/flowsheetEntry — create a mirror entry */
router.post('/playlists/api/flowsheetEntry', (req: Request, res: Response) => {
  const id = nextId++;
  res.status(201).json({ id, ...req.body });
});

/** PATCH /playlists/api/flowsheetEntry — update a mirror entry */
router.patch('/playlists/api/flowsheetEntry', (req: Request, res: Response) => {
  res.status(200).json(req.body);
});

export default router;
