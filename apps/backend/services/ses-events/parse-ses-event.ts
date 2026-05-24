import type {
  SesBounceEvent,
  SesComplaintEvent,
  SesDeliveryDelayEvent,
  SesDeliveryEvent,
  SesEvent,
  SesRejectEvent,
  SesSendEvent,
} from './types.js';

/**
 * Parse a JSON-decoded SES event payload (the contents of SNS `Message` for
 * events published by an SES Configuration Set EventDestination).
 *
 * Throws on missing required fields or unknown event types. Unknown event
 * types are surfaced as errors so the route layer can attribute them to
 * Sentry rather than dropping silently — at the time this is written the
 * configured event matchers are SEND/DELIVERY/BOUNCE/COMPLAINT/REJECT/
 * DELIVERY_DELAY, so an unknown type means SES added a new category we
 * haven't classified yet.
 */
export function parseSesEvent(payload: unknown): SesEvent {
  if (!isPlainObject(payload)) {
    throw new Error('SES payload is not an object');
  }

  const eventType = payload['eventType'];
  if (typeof eventType !== 'string') {
    throw new Error('SES payload missing eventType');
  }

  const mail = payload['mail'];
  if (!isPlainObject(mail)) {
    throw new Error('SES payload missing mail object');
  }

  const messageId = mail['messageId'];
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('SES payload missing mail.messageId');
  }

  const sendTimestamp = parseTimestamp(mail['timestamp'], 'mail.timestamp');

  switch (eventType) {
    case 'Send':
      return parseSend(payload, mail, messageId, sendTimestamp);
    case 'Delivery':
      return parseDelivery(payload, messageId, sendTimestamp);
    case 'Bounce':
      return parseBounce(payload, messageId, sendTimestamp);
    case 'Complaint':
      return parseComplaint(payload, messageId, sendTimestamp);
    case 'Reject':
      return parseReject(payload, messageId, sendTimestamp);
    case 'DeliveryDelay':
      return parseDeliveryDelay(payload, messageId, sendTimestamp);
    default:
      throw new Error(`Unknown SES eventType: ${eventType}`);
  }
}

function parseSend(
  _payload: Record<string, unknown>,
  mail: Record<string, unknown>,
  messageId: string,
  sendTimestamp: Date
): SesSendEvent {
  const destination = mail['destination'];
  const recipients = Array.isArray(destination) ? destination.filter((d): d is string => typeof d === 'string') : [];
  return { kind: 'Send', messageId, sendTimestamp, recipients };
}

function parseDelivery(payload: Record<string, unknown>, messageId: string, sendTimestamp: Date): SesDeliveryEvent {
  const delivery = payload['delivery'];
  if (!isPlainObject(delivery)) {
    throw new Error('SES Delivery event missing delivery object');
  }
  const deliveredAt = parseTimestamp(delivery['timestamp'], 'delivery.timestamp');
  const processingTimeMillis = delivery['processingTimeMillis'];
  if (typeof processingTimeMillis !== 'number' || !Number.isFinite(processingTimeMillis)) {
    throw new Error('SES Delivery event missing delivery.processingTimeMillis');
  }
  const recipients = delivery['recipients'];
  const recipient = Array.isArray(recipients) && typeof recipients[0] === 'string' ? (recipients[0]) : '';
  if (recipient === '') {
    throw new Error('SES Delivery event missing delivery.recipients[0]');
  }
  const smtpResponse = typeof delivery['smtpResponse'] === 'string' ? (delivery['smtpResponse']) : '';
  return {
    kind: 'Delivery',
    messageId,
    sendTimestamp,
    deliveredAt,
    recipient,
    smtpResponse,
    processingTimeMillis,
  };
}

function parseBounce(payload: Record<string, unknown>, messageId: string, sendTimestamp: Date): SesBounceEvent {
  const bounce = payload['bounce'];
  if (!isPlainObject(bounce)) {
    throw new Error('SES Bounce event missing bounce object');
  }
  const bounceType = typeof bounce['bounceType'] === 'string' ? (bounce['bounceType']) : 'Unknown';
  const bounceSubType = typeof bounce['bounceSubType'] === 'string' ? (bounce['bounceSubType']) : 'Unknown';
  const bouncedRecipients = bounce['bouncedRecipients'];
  const recipient = extractFirstRecipientAddress(bouncedRecipients);
  if (recipient === '') {
    throw new Error('SES Bounce event missing bounce.bouncedRecipients[0].emailAddress');
  }
  return { kind: 'Bounce', messageId, sendTimestamp, recipient, bounceType, bounceSubType };
}

function parseComplaint(payload: Record<string, unknown>, messageId: string, sendTimestamp: Date): SesComplaintEvent {
  const complaint = payload['complaint'];
  if (!isPlainObject(complaint)) {
    throw new Error('SES Complaint event missing complaint object');
  }
  const recipient = extractFirstRecipientAddress(complaint['complainedRecipients']);
  if (recipient === '') {
    throw new Error('SES Complaint event missing complaint.complainedRecipients[0].emailAddress');
  }
  return { kind: 'Complaint', messageId, sendTimestamp, recipient };
}

function parseReject(payload: Record<string, unknown>, messageId: string, sendTimestamp: Date): SesRejectEvent {
  const reject = payload['reject'];
  if (!isPlainObject(reject)) {
    throw new Error('SES Reject event missing reject object');
  }
  const reason = typeof reject['reason'] === 'string' ? (reject['reason']) : 'Unknown';
  return { kind: 'Reject', messageId, sendTimestamp, reason };
}

function parseDeliveryDelay(
  payload: Record<string, unknown>,
  messageId: string,
  sendTimestamp: Date
): SesDeliveryDelayEvent {
  const deliveryDelay = payload['deliveryDelay'];
  if (!isPlainObject(deliveryDelay)) {
    throw new Error('SES DeliveryDelay event missing deliveryDelay object');
  }
  const delayType = typeof deliveryDelay['delayType'] === 'string' ? (deliveryDelay['delayType']) : 'Unknown';
  const expirationTimeRaw = deliveryDelay['expirationTime'];
  const expirationTime = typeof expirationTimeRaw === 'string' ? parseTimestampOrNull(expirationTimeRaw) : null;
  const recipient = extractFirstRecipientAddress(deliveryDelay['delayedRecipients']);
  if (recipient === '') {
    throw new Error('SES DeliveryDelay event missing deliveryDelay.delayedRecipients[0].emailAddress');
  }
  return { kind: 'DeliveryDelay', messageId, sendTimestamp, recipient, delayType, expirationTime };
}

function extractFirstRecipientAddress(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '';
  const first = value[0];
  if (!isPlainObject(first)) return '';
  const addr = first['emailAddress'];
  return typeof addr === 'string' ? addr : '';
}

function parseTimestamp(value: unknown, fieldName: string): Date {
  if (typeof value !== 'string') {
    throw new Error(`SES payload field ${fieldName} is not a string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`SES payload field ${fieldName} is not a valid ISO 8601 timestamp`);
  }
  return date;
}

function parseTimestampOrNull(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
