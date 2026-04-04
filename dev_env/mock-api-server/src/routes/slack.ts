/**
 * Mock Slack webhook routes.
 *
 * Accepts POST to /services/* and records the payload.
 */

import { Router, type Request, type Response } from 'express';
import { recordRequest, checkErrorRule } from '../state.js';

const router = Router();

/** POST /services/* — Slack webhook receiver */
router.post('/services/*path', (req: Request, res: Response) => {
  recordRequest({
    service: 'slack',
    method: 'POST',
    path: req.path,
    query: req.query as Record<string, string>,
    body: req.body,
    timestamp: new Date().toISOString(),
  });

  const error = checkErrorRule('slack', req.path);
  if (error) {
    res.status(error.status).send(error.body ?? 'simulated error');
    return;
  }

  res.status(200).send('ok');
});

export default router;
