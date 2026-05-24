import { describe, it, expect } from '@jest/globals';
import { parseSesEvent } from '../../../../apps/backend/services/ses-events/parse-ses-event';

/**
 * Fixtures modeled on the SES event payload documented at
 * https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
 * — the SNS-wrapped event publishing schema.
 *
 * Fields we don't surface on spans (mail.headers, mail.commonHeaders, the
 * full mail.tags map, etc.) are still kept in fixtures so the parser is
 * exercised against the real shape, not a stripped-down one.
 */

const baseMail = {
  timestamp: '2026-05-24T10:00:00.000Z',
  source: 'no-reply@wxyc.org',
  sourceArn: 'arn:aws:ses:us-east-1:203767826763:identity/wxyc.org',
  sendingAccountId: '203767826763',
  messageId: '01000180abcdef00-12345678-1234-1234-1234-1234567890ab-000000',
  destination: ['user@example.com'],
  headersTruncated: false,
  headers: [{ name: 'From', value: 'no-reply@wxyc.org' }],
  commonHeaders: { from: ['no-reply@wxyc.org'], to: ['user@example.com'], subject: 'Your WXYC login code' },
};

describe('parseSesEvent', () => {
  it('parses a Send event', () => {
    const event = parseSesEvent({ eventType: 'Send', mail: baseMail, send: {} });
    expect(event).toEqual({
      kind: 'Send',
      messageId: baseMail.messageId,
      sendTimestamp: new Date(baseMail.timestamp),
      recipients: ['user@example.com'],
    });
  });

  it('parses a Delivery event with delivery latency math intact', () => {
    const event = parseSesEvent({
      eventType: 'Delivery',
      mail: baseMail,
      delivery: {
        timestamp: '2026-05-24T10:00:02.500Z',
        processingTimeMillis: 1234,
        recipients: ['user@example.com'],
        smtpResponse: '250 2.0.0 OK',
        reportingMTA: 'a8-83.smtp-out.amazonses.com',
      },
    });
    expect(event.kind).toBe('Delivery');
    if (event.kind !== 'Delivery') throw new Error('discriminant');
    expect(event.recipient).toBe('user@example.com');
    expect(event.processingTimeMillis).toBe(1234);
    expect(event.smtpResponse).toBe('250 2.0.0 OK');
    expect(event.deliveredAt.getTime() - event.sendTimestamp.getTime()).toBe(2500);
  });

  it('parses a Bounce event and surfaces bounceType + subType', () => {
    const event = parseSesEvent({
      eventType: 'Bounce',
      mail: baseMail,
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'user@example.com', status: '5.1.1', diagnosticCode: 'smtp; 550 user unknown' },
        ],
        timestamp: '2026-05-24T10:00:01.000Z',
        feedbackId: '01000180bouncefeed-...',
      },
    });
    expect(event).toMatchObject({
      kind: 'Bounce',
      recipient: 'user@example.com',
      bounceType: 'Permanent',
      bounceSubType: 'General',
    });
  });

  it('parses a Complaint event', () => {
    const event = parseSesEvent({
      eventType: 'Complaint',
      mail: baseMail,
      complaint: {
        complainedRecipients: [{ emailAddress: 'user@example.com' }],
        timestamp: '2026-05-24T10:00:01.000Z',
        feedbackId: '01000180complaint-...',
        complaintFeedbackType: 'abuse',
      },
    });
    expect(event).toMatchObject({ kind: 'Complaint', recipient: 'user@example.com' });
  });

  it('parses a Reject event', () => {
    const event = parseSesEvent({
      eventType: 'Reject',
      mail: baseMail,
      reject: { reason: 'Bad content' },
    });
    expect(event).toMatchObject({ kind: 'Reject', reason: 'Bad content' });
  });

  it('parses a DeliveryDelay event', () => {
    const event = parseSesEvent({
      eventType: 'DeliveryDelay',
      mail: baseMail,
      deliveryDelay: {
        delayType: 'TransientCommunicationFailure',
        delayedRecipients: [
          { emailAddress: 'user@example.com', status: '4.4.1', diagnosticCode: 'smtp; 421 try later' },
        ],
        expirationTime: '2026-05-24T11:00:00.000Z',
        reportingMTA: 'a8-83.smtp-out.amazonses.com',
        timestamp: '2026-05-24T10:05:00.000Z',
      },
    });
    expect(event).toMatchObject({
      kind: 'DeliveryDelay',
      recipient: 'user@example.com',
      delayType: 'TransientCommunicationFailure',
    });
    if (event.kind === 'DeliveryDelay') {
      expect(event.expirationTime?.toISOString()).toBe('2026-05-24T11:00:00.000Z');
    }
  });

  it('handles a DeliveryDelay without expirationTime', () => {
    const event = parseSesEvent({
      eventType: 'DeliveryDelay',
      mail: baseMail,
      deliveryDelay: {
        delayType: 'MailboxFull',
        delayedRecipients: [{ emailAddress: 'user@example.com' }],
      },
    });
    if (event.kind !== 'DeliveryDelay') throw new Error('discriminant');
    expect(event.expirationTime).toBeNull();
  });

  it('throws on unknown eventType', () => {
    expect(() => parseSesEvent({ eventType: 'Open', mail: baseMail })).toThrow(/Unknown SES eventType/);
  });

  it('throws on missing mail.timestamp', () => {
    const { timestamp: _t, ...mailNoTs } = baseMail;
    expect(() => parseSesEvent({ eventType: 'Send', mail: mailNoTs })).toThrow(/mail\.timestamp/);
  });

  it('throws on missing mail.messageId', () => {
    const { messageId: _m, ...mailNoId } = baseMail;
    expect(() => parseSesEvent({ eventType: 'Send', mail: mailNoId })).toThrow(/messageId/);
  });

  it('throws on empty bounce recipients', () => {
    expect(() =>
      parseSesEvent({
        eventType: 'Bounce',
        mail: baseMail,
        bounce: { bounceType: 'P', bounceSubType: 'G', bouncedRecipients: [] },
      })
    ).toThrow(/bouncedRecipients\[0\]/);
  });

  it('throws on non-object payload', () => {
    expect(() => parseSesEvent('not an object')).toThrow(/not an object/);
    expect(() => parseSesEvent(null)).toThrow();
    expect(() => parseSesEvent([])).toThrow();
  });
});
