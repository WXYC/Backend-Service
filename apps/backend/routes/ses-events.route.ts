import * as Sentry from '@sentry/node';
import express, { Router } from 'express';
import {
  confirmSubscription,
  emitSesEventSpan,
  parseSesEvent,
  validateSnsMessage,
} from '../services/ses-events/index.js';

/**
 * POST /internal/ses-events
 *
 * SNS HTTPS subscriber for the `ses-delivery-events-prod` topic. Receives
 * Send/Delivery/Bounce/Complaint/Reject/DeliveryDelay events from the SES
 * Configuration Set attached to the `wxyc.org` sending identity, and emits
 * one Sentry span per event so `Send → Delivery` p50/p90/p99 is visible in
 * the trace explorer.
 *
 * Auth model: SNS X.509 signature validation IS the auth. We pin the topic
 * ARN via `SES_EVENTS_SNS_TOPIC_ARN`. We do NOT require X-Internal-Key here
 * because SES → SNS → BS cannot inject custom HTTP headers; the cert chain
 * is the trust root.
 *
 * Body parser: SNS sends `Content-Type: text/plain` (AWS historical choice),
 * so we attach a route-scoped `express.text({ type: 'wildcard' })`. The
 * global `app.use(express.json())` only handles `application/json` and never
 * touches these bodies, so mount order is irrelevant.
 */
export const ses_events_route = Router();

ses_events_route.post('/', express.text({ type: '*/*', limit: '64kb' }), async (req, res) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof req.body === 'string' ? req.body : '');
  } catch {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  let validated;
  try {
    validated = await validateSnsMessage(parsed);
  } catch (e) {
    Sentry.captureException(e, { tags: { subsystem: 'ses-events', stage: 'validate' } });
    res.status(400).json({ error: 'invalid signature or topic' });
    return;
  }

  if (validated.Type === 'SubscriptionConfirmation') {
    if (!validated.SubscribeURL) {
      Sentry.captureMessage('SES events: SubscriptionConfirmation missing SubscribeURL', {
        level: 'error',
        tags: { subsystem: 'ses-events', stage: 'confirm' },
      });
      res.status(400).json({ error: 'subscription confirmation missing SubscribeURL' });
      return;
    }
    try {
      await confirmSubscription(validated.SubscribeURL);
    } catch (e) {
      Sentry.captureException(e, { tags: { subsystem: 'ses-events', stage: 'confirm' } });
      res.status(500).json({ error: 'failed to confirm subscription' });
      return;
    }
    res.json({ ok: true, confirmed: true });
    return;
  }

  if (validated.Type === 'UnsubscribeConfirmation') {
    // Operator removed the subscription. Don't auto-reconfirm — that's an
    // explicit decision; just observe and 200.
    console.warn('[ses-events] received UnsubscribeConfirmation', { topicArn: validated.TopicArn });
    res.json({ ok: true });
    return;
  }

  // Type === 'Notification'
  let messagePayload: unknown;
  try {
    messagePayload = JSON.parse(validated.Message);
  } catch {
    Sentry.captureMessage('SES events: SNS Notification.Message is not JSON', {
      level: 'error',
      tags: { subsystem: 'ses-events', stage: 'parse' },
    });
    res.status(400).json({ error: 'unparseable ses event' });
    return;
  }

  let event;
  try {
    event = parseSesEvent(messagePayload);
  } catch (e) {
    Sentry.captureException(e, { tags: { subsystem: 'ses-events', stage: 'parse' } });
    res.status(400).json({ error: 'unparseable ses event' });
    return;
  }

  try {
    emitSesEventSpan(event);
  } catch (e) {
    // Observability must never break the receive path. SES will retry on
    // 5xx, so a Sentry-emit blip should still 200 to AWS.
    console.warn('[ses-events] failed to emit span', e);
  }

  res.json({ ok: true });
});
