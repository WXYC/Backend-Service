import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const setAttribute = jest.fn();
const setStatus = jest.fn();
const startSpan = jest.fn();

jest.mock('@sentry/node', () => ({
  startSpan: (...args: unknown[]) => (startSpan as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { emitSesEventSpan } from '../../../../apps/backend/services/ses-events/emit-span';
import type { SesEvent } from '../../../../apps/backend/services/ses-events/types';

beforeEach(() => {
  setAttribute.mockReset();
  setStatus.mockReset();
  startSpan.mockReset();
  startSpan.mockImplementation((_opts: unknown, cb: unknown) => {
    const span = { setAttribute, setStatus };
    return (cb as (s: typeof span) => unknown)(span);
  });
});

const sendTs = new Date('2026-05-24T10:00:00.000Z');
const deliveredAt = new Date('2026-05-24T10:00:02.500Z');

describe('emitSesEventSpan', () => {
  it('emits a Send span with name "ses.event" and op "email.ses"', () => {
    const event: SesEvent = {
      kind: 'Send',
      messageId: 'mid-1',
      sendTimestamp: sendTs,
      recipients: ['user@example.com'],
    };
    emitSesEventSpan(event);
    expect(startSpan).toHaveBeenCalledTimes(1);
    const callArgs = startSpan.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    expect(callArgs[0]).toMatchObject({ name: 'ses.event', op: 'email.ses' });
    expect((callArgs[0].attributes as Record<string, unknown>)['email.event_type']).toBe('Send');
    expect((callArgs[0].attributes as Record<string, unknown>)['email.recipient_domain']).toBe('example.com');
    expect((callArgs[0].attributes as Record<string, unknown>)['email.message_id']).toBe('mid-1');
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
    emitSesEventSpan(event);
    const callArgs = startSpan.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    const attrs = callArgs[0].attributes as Record<string, string | number>;
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
    emitSesEventSpan(event);
    const callArgs = startSpan.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    const attrs = callArgs[0].attributes as Record<string, unknown>;
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
    emitSesEventSpan(event);
    const callArgs = startSpan.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    const attrs = callArgs[0].attributes as Record<string, unknown>;
    expect(attrs['ses.delivery_latency_ms']).toBe(0);
  });

  it('sets failed_precondition status on Bounce', () => {
    const event: SesEvent = {
      kind: 'Bounce',
      messageId: 'mid-5',
      sendTimestamp: sendTs,
      recipient: 'user@example.com',
      bounceType: 'Permanent',
      bounceSubType: 'General',
    };
    emitSesEventSpan(event);
    // Sentry numeric status codes: 1 = OK, 2 = ERROR
    expect(setStatus).toHaveBeenCalledWith({ code: 2, message: 'failed_precondition' });
  });

  it('sets deadline_exceeded status on DeliveryDelay', () => {
    const event: SesEvent = {
      kind: 'DeliveryDelay',
      messageId: 'mid-6',
      sendTimestamp: sendTs,
      recipient: 'user@example.com',
      delayType: 'MailboxFull',
      expirationTime: null,
    };
    emitSesEventSpan(event);
    expect(setStatus).toHaveBeenCalledWith({ code: 2, message: 'deadline_exceeded' });
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
    emitSesEventSpan(event);
    const callArgs = startSpan.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    const attrs = callArgs[0].attributes as Record<string, unknown>;
    expect((attrs['email.smtp_response'] as string).length).toBe(500);
  });

  it('falls back to "unknown" domain when recipient has no @', () => {
    const event: SesEvent = {
      kind: 'Reject',
      messageId: 'mid-8',
      sendTimestamp: sendTs,
      reason: 'Bad content',
    };
    emitSesEventSpan(event);
    const callArgs = startSpan.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    const attrs = callArgs[0].attributes as Record<string, unknown>;
    expect(attrs['email.recipient_domain']).toBe('unknown');
  });
});
