/**
 * Admin control API for test orchestration.
 *
 * Provides endpoints to inspect recorded requests, reset state,
 * and configure error simulation.
 */

import { Router, type Request, type Response } from 'express';
import { getRequests, resetState, addErrorRule, clearErrorRules } from '../state.js';

const router = Router();

/** GET /_admin/health */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/** POST /_admin/reset — clear all state */
router.post('/reset', (_req: Request, res: Response) => {
  resetState();
  res.json({ message: 'State reset' });
});

/** GET /_admin/requests — return all recorded requests */
router.get('/requests', (_req: Request, res: Response) => {
  res.json(getRequests());
});

/** GET /_admin/requests/:service — filter by service */
router.get('/requests/:service', (req: Request, res: Response) => {
  res.json(getRequests(req.params.service as string));
});

/** POST /_admin/errors — add error simulation rule */
router.post('/errors', (req: Request, res: Response) => {
  const { service, endpoint, status, body, count } = req.body ?? {};
  if (!service || !endpoint || !status) {
    res.status(400).json({ error: 'service, endpoint, and status are required' });
    return;
  }
  addErrorRule({ service, endpoint, status, body, count });
  res.json({ message: 'Error rule added' });
});

/** DELETE /_admin/errors — clear all error rules */
router.delete('/errors', (_req: Request, res: Response) => {
  clearErrorRules();
  res.json({ message: 'Error rules cleared' });
});

export default router;
