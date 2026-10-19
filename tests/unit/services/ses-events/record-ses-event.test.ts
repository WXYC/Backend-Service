import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const logCounter = jest.fn<(name: string, value: number, fields?: Record<string, unknown>) => void>();

jest.mock('@wxyc/observability', () =>
  jest
    .requireActual<typeof import('../../../utils/observability')>('../../../utils/observability')
    .mockObservabilityBarrel({ logCounter: logCounter })
);

import { recordSesEvent } from '../../../../apps/backend/services/ses-events/record-ses-event';
import type { SesEvent } from '../../../../apps/backend/services/ses-events/types';

beforeEach(() => {
  logCounter.mockReset();
});

const sendTs = new Date('2026-05-24T10:00:00.000Z');
const deliveredAt = new Date('2026-05-24T10:00:02.500Z');

describe('recordSesEvent', () => {
  it('logs a ses.event counter for a Send', () => {
    const event: SesEvent = {
      kind: 'Send',
      messageId: 'mid-1',
      sendTimestamp: sendTs,
      recipients: ['user@example.com'],
    };
    recordSesEvent(event);
    expect(logCounter).toHaveBeenCalledTimes(1);
    expect(logCounter).toHaveBeenCalledWith('ses.event', 1, {
      'email.event_type': 'Send',
      'email.message_id': 'mid-1',
      'email.recipient_domain': 'example.com',
    });
  });

  it('NEVER includes the recipient local-part in attributes', () => {
    const event: SesEvent = {
      kind: 'Delivery',
      messageId: 'mid-2',
      sendTimestamp: sendTs,
      deliveredAt,
      recipient: 'secret.local.part@example.com',
      smtpResponse: '250 OK',
      processingTimeMillis: 100,
    };
    recordSesEvent(event);
    const attrs = logCounter.mock.calls[0][2] as Record<string, string | number>;
    for (const v of Object.values(attrs)) {
      const text = typeof v === 'string' ? v : String(v);
      expect(text).not.toMatch(/secret\.local\.part/);
    }
    expect(attrs['email.recipient_domain']).toBe('example.com');
  });

  it('emits ses.delivery_latency_ms = delta in ms on Delivery events', () => {
    const event: SesEvent = {
      kind: 'Delivery',
      messageId: 'mid-3',
      sendTimestamp: sendTs,
      deliveredAt,
      recipient: 'user@example.com',
      smtpResponse: '250 OK',
      processingTimeMillis: 1234,
    };
    recordSesEvent(event);
    const attrs = logCounter.mock.calls[0][2];
    expect(attrs['ses.delivery_latency_ms']).toBe(2500);
    expect(attrs['ses.processing_time_ms']).toBe(1234);
  });

  it('clamps negative latency to 0 (clock skew defense)', () => {
    const event: SesEvent = {
      kind: 'Delivery',
      messageId: 'mid-4',
      sendTimestamp: new Date('2026-05-24T10:00:05.000Z'),
      deliveredAt: new Date('2026-05-24T10:00:00.000Z'),
      recipient: 'user@example.com',
      smtpResponse: '250 OK',
      processingTimeMillis: 100,
    };
    recordSesEvent(event);
    const attrs = logCounter.mock.calls[0][2];
    expect(attrs['ses.delivery_latency_ms']).toBe(0);
  });

  it('logs bounce and delay fields', () => {
    recordSesEvent({
      kind: 'Bounce',
      messageId: 'mid-5',
      sendTimestamp: sendTs,
      recipient: 'user@example.com',
      bounceType: 'Permanent',
      bounceSubType: 'General',
    });
    expect(logCounter.mock.calls[0][2]).toMatchObject({
      'email.bounce_type': 'Permanent',
      'email.bounce_subtype': 'General',
    });
    recordSesEvent({
      kind: 'DeliveryDelay',
      messageId: 'mid-6',
      sendTimestamp: sendTs,
      recipient: 'user@example.com',
      delayType: 'MailboxFull',
      expirationTime: null,
    });
    expect(logCounter.mock.calls[1][2]).toMatchObject({ 'email.delay_type': 'MailboxFull' });
  });

  it('trims smtpResponse to 500 chars', () => {
    const longResp = 'x'.repeat(800);
    const event: SesEvent = {
      kind: 'Delivery',
      messageId: 'mid-7',
      sendTimestamp: sendTs,
      deliveredAt,
      recipient: 'user@example.com',
      smtpResponse: longResp,
      processingTimeMillis: 0,
    };
    recordSesEvent(event);
    const attrs = logCounter.mock.calls[0][2];
    expect((attrs['email.smtp_response'] as string).length).toBe(500);
  });

  it('falls back to "unknown" domain when recipient has no @', () => {
    const event: SesEvent = {
      kind: 'Reject',
      messageId: 'mid-8',
      sendTimestamp: sendTs,
      reason: 'Bad content',
    };
    recordSesEvent(event);
    const attrs = logCounter.mock.calls[0][2];
    expect(attrs['email.recipient_domain']).toBe('unknown');
  });
});

describe('recordSesEvent redacts email addresses from MTA/SES free text', () => {
  it.each([
    ['250 2.0.0 OK <secret.person@example.com> accepted', '250 2.0.0 OK <<redacted>> accepted'],
    ['250 OK: queued as 12345 for Secret.Person+tag@Mail.Example.CO.uk', '250 OK: queued as 12345 for <redacted>'],
    ['250 2.1.5 a@b.org and c.d@e.net delivered', '250 2.1.5 <redacted> and <redacted> delivered'],
    ['250 OK', '250 OK'],
  ])('Delivery smtp_response %j logs as %j', (smtpResponse, expected) => {
    recordSesEvent({
      kind: 'Delivery',
      messageId: 'mid-r1',
      sendTimestamp: sendTs,
      deliveredAt,
      recipient: 'secret.person@example.com',
      smtpResponse,
      processingTimeMillis: 10,
    });
    expect(logCounter.mock.calls[0][2]?.['email.smtp_response']).toBe(expected);
  });

  it('redacts an address in a Reject reason', () => {
    recordSesEvent({
      kind: 'Reject',
      messageId: 'mid-r2',
      sendTimestamp: sendTs,
      reason: 'Bad content for recipient someone@example.org',
    });
    expect(logCounter.mock.calls[0][2]?.['email.reject_reason']).toBe('Bad content for recipient <redacted>');
  });

  it('redacts before trimming, so a cut-off address cannot leak its local part', () => {
    const smtpResponse = `${'x'.repeat(480)} secret.person@example.com`;
    recordSesEvent({
      kind: 'Delivery',
      messageId: 'mid-r3',
      sendTimestamp: sendTs,
      deliveredAt,
      recipient: 'secret.person@example.com',
      smtpResponse,
      processingTimeMillis: 10,
    });
    const logged = logCounter.mock.calls[0][2]?.['email.smtp_response'] as string;
    expect(logged).not.toMatch(/secret/);
    expect(logged.length).toBeLessThanOrEqual(500);
  });
});
