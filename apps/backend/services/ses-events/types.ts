/**
 * Discriminated union of the six SES event types we observe for transactional
 * email instrumentation. The shape comes from the SES "Configuration Set →
 * SNS event publishing" documented payload; we keep a narrow projection that
 * carries only the fields we surface on Sentry spans.
 *
 * Recipient values are intentionally kept as full email addresses inside this
 * module, but only the domain part is allowed to leave it (see emit-span.ts).
 * Treat any local-part as PII; never log or attribute it.
 */

export type SesEventKind = 'Send' | 'Delivery' | 'Bounce' | 'Complaint' | 'Reject' | 'DeliveryDelay';

export interface SesEventBase {
  kind: SesEventKind;
  messageId: string;
  sendTimestamp: Date;
}

export interface SesSendEvent extends SesEventBase {
  kind: 'Send';
  recipients: string[];
}

export interface SesDeliveryEvent extends SesEventBase {
  kind: 'Delivery';
  deliveredAt: Date;
  recipient: string;
  smtpResponse: string;
  processingTimeMillis: number;
}

export interface SesBounceEvent extends SesEventBase {
  kind: 'Bounce';
  recipient: string;
  bounceType: string;
  bounceSubType: string;
}

export interface SesComplaintEvent extends SesEventBase {
  kind: 'Complaint';
  recipient: string;
}

export interface SesRejectEvent extends SesEventBase {
  kind: 'Reject';
  reason: string;
}

export interface SesDeliveryDelayEvent extends SesEventBase {
  kind: 'DeliveryDelay';
  recipient: string;
  delayType: string;
  expirationTime: Date | null;
}

export type SesEvent =
  SesSendEvent | SesDeliveryEvent | SesBounceEvent | SesComplaintEvent | SesRejectEvent | SesDeliveryDelayEvent;
