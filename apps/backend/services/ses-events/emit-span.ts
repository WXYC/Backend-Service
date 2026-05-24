import * as Sentry from '@sentry/node';
import type { SesEvent } from './types.js';

/**
 * Emit a Sentry span for one SES event. The span has:
 *
 *   name: 'ses.event'
 *   op:   'email.ses'
 *
 *   attributes:
 *     email.event_type:       'Send' | 'Delivery' | 'Bounce' | ...
 *     email.message_id:       SES mail.messageId
 *     email.recipient_domain: the part after '@' in the first recipient
 *                             (NEVER the local-part — PII)
 *     email.smtp_response:    (Delivery only) trimmed to 500 chars
 *     email.bounce_type:      (Bounce only)
 *     email.bounce_subtype:   (Bounce only)
 *     email.delay_type:       (DeliveryDelay only)
 *     email.reject_reason:    (Reject only) trimmed to 500 chars
 *
 *   measurements:
 *     ses.delivery_latency_ms: (Delivery only) ms from mail.timestamp to delivery.timestamp
 *     ses.processing_time_ms:  (Delivery only) delivery.processingTimeMillis
 *
 *   span status:
 *     ok                 on Send/Delivery
 *     failed_precondition on Bounce/Complaint/Reject
 *     deadline_exceeded   on DeliveryDelay
 *
 * Span lifetime is synchronous. We open it, set everything, end it. No
 * fetch to wrap — this is pure projection of an already-completed event
 * onto a span the trace explorer can search and aggregate.
 */
export function emitSesEventSpan(event: SesEvent): void {
  Sentry.startSpan(
    {
      name: 'ses.event',
      op: 'email.ses',
      attributes: buildAttributes(event),
    },
    (span) => {
      const measurements = buildMeasurements(event);
      for (const [name, value] of Object.entries(measurements)) {
        // Sentry's setAttribute is the supported v10 path; measurements
        // surface in the trace explorer the same way once attributes start
        // with a known numeric metric key. We accept the slight loss of
        // dedicated "measurements" semantics in exchange for an API that
        // does not require us to chase SDK-internal types.
        span.setAttribute(name, value);
      }
      span.setStatus(buildStatus(event));
    }
  );
}

function buildAttributes(event: SesEvent): Record<string, string | number> {
  const recipientDomain = extractDomain(firstRecipient(event));
  const base: Record<string, string | number> = {
    'email.event_type': event.kind,
    'email.message_id': event.messageId,
    'email.recipient_domain': recipientDomain,
  };

  if (event.kind === 'Delivery') {
    base['email.smtp_response'] = trim(event.smtpResponse, 500);
    return base;
  }
  if (event.kind === 'Bounce') {
    base['email.bounce_type'] = event.bounceType;
    base['email.bounce_subtype'] = event.bounceSubType;
    return base;
  }
  if (event.kind === 'Reject') {
    base['email.reject_reason'] = trim(event.reason, 500);
    return base;
  }
  if (event.kind === 'DeliveryDelay') {
    base['email.delay_type'] = event.delayType;
    return base;
  }
  return base;
}

function buildMeasurements(event: SesEvent): Record<string, number> {
  if (event.kind !== 'Delivery') return {};
  const latency = event.deliveredAt.getTime() - event.sendTimestamp.getTime();
  // Clock skew between SES and the receiving MTA can in principle produce a
  // negative delta; clamp to 0 rather than emit a garbage measurement.
  const latencyMs = latency < 0 ? 0 : latency;
  return {
    'ses.delivery_latency_ms': latencyMs,
    'ses.processing_time_ms': event.processingTimeMillis,
  };
}

// Sentry encodes span status as a numeric enum: 0 = UNSET, 1 = OK, 2 = ERROR.
// The constants ship as `Sentry.SPAN_STATUS_OK` / `SPAN_STATUS_ERROR`; we
// inline the literals here so this module doesn't depend on a stable name
// for an SDK-internal export that has churned across recent versions.
const STATUS_OK = 1 as const;
const STATUS_ERROR = 2 as const;

function buildStatus(event: SesEvent): { code: typeof STATUS_OK | typeof STATUS_ERROR; message?: string } {
  switch (event.kind) {
    case 'Send':
    case 'Delivery':
      return { code: STATUS_OK };
    case 'Bounce':
    case 'Complaint':
    case 'Reject':
      return { code: STATUS_ERROR, message: 'failed_precondition' };
    case 'DeliveryDelay':
      return { code: STATUS_ERROR, message: 'deadline_exceeded' };
  }
}

function firstRecipient(event: SesEvent): string {
  if (event.kind === 'Send') return event.recipients[0] ?? '';
  if (event.kind === 'Reject') return '';
  return event.recipient;
}

function extractDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return 'unknown';
  return address.slice(at + 1).toLowerCase();
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
