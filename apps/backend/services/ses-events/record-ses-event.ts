import { logCounter } from '@wxyc/observability';
import type { SesEvent } from './types.js';

/**
 * Log one `ses.event` counter line for an SES event (BS#3402). Fields:
 *
 *     email.event_type:       'Send' | 'Delivery' | 'Bounce' | ...
 *     email.message_id:       SES mail.messageId
 *     email.recipient_domain: the part after '@' in the first recipient
 *                             (NEVER the local-part — PII)
 *     email.smtp_response:    (Delivery only) email addresses redacted,
 *                             then trimmed to 500 chars
 *     email.bounce_type:      (Bounce only)
 *     email.bounce_subtype:   (Bounce only)
 *     email.delay_type:       (DeliveryDelay only)
 *     email.reject_reason:    (Reject only) email addresses redacted,
 *                             then trimmed to 500 chars
 *     ses.delivery_latency_ms: (Delivery only) ms from mail.timestamp to
 *                             delivery.timestamp
 *     ses.processing_time_ms:  (Delivery only) delivery.processingTimeMillis
 *
 * The two free-text fields are raw MTA/SES text, and some receiving MTAs
 * echo the recipient address in their SMTP reply, so anything email-shaped
 * in them is replaced with `<redacted>` before the line is written.
 */
export function recordSesEvent(event: SesEvent): void {
  logCounter('ses.event', 1, { ...buildAttributes(event), ...buildMeasurements(event) });
}

function buildAttributes(event: SesEvent): Record<string, string | number> {
  const recipientDomain = extractDomain(firstRecipient(event));
  const base: Record<string, string | number> = {
    'email.event_type': event.kind,
    'email.message_id': event.messageId,
    'email.recipient_domain': recipientDomain,
  };

  if (event.kind === 'Delivery') {
    base['email.smtp_response'] = trim(redactEmailAddresses(event.smtpResponse), 500);
    return base;
  }
  if (event.kind === 'Bounce') {
    base['email.bounce_type'] = event.bounceType;
    base['email.bounce_subtype'] = event.bounceSubType;
    return base;
  }
  if (event.kind === 'Reject') {
    base['email.reject_reason'] = trim(redactEmailAddresses(event.reason), 500);
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

/**
 * Anything shaped like `local@domain`. Deliberately broad: a false positive
 * only costs a little diagnostic text, a false negative leaks an address.
 */
const EMAIL_SHAPED = /[^\s<>()[\]"',;:@]+@[^\s<>()[\]"',;:@]+/g;

/** Replace every email-shaped token in MTA/SES free text with `<redacted>`. Runs before trimming, so a cut-off address can't slip through. */
function redactEmailAddresses(value: string): string {
  return value.replace(EMAIL_SHAPED, '<redacted>');
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
