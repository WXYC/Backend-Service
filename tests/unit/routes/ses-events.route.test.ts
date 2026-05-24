import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockValidate = jest.fn();
const mockParseSesEvent = jest.fn();
const mockEmitSesEventSpan = jest.fn();
const mockConfirmSubscription = jest.fn();
const mockSentryCaptureException = jest.fn();
const mockSentryCaptureMessage = jest.fn();

jest.mock('../../../apps/backend/services/ses-events/sns-validator', () => ({
  validateSnsMessage: (...args: unknown[]) => (mockValidate as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock('../../../apps/backend/services/ses-events/parse-ses-event', () => ({
  parseSesEvent: (...args: unknown[]) => (mockParseSesEvent as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock('../../../apps/backend/services/ses-events/emit-span', () => ({
  emitSesEventSpan: (...args: unknown[]) => (mockEmitSesEventSpan as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock('../../../apps/backend/services/ses-events/confirm-subscription', () => ({
  confirmSubscription: (...args: unknown[]) =>
    (mockConfirmSubscription as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) =>
    (mockSentryCaptureException as unknown as (...a: unknown[]) => unknown)(...args),
  captureMessage: (...args: unknown[]) =>
    (mockSentryCaptureMessage as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { ses_events_route } from '../../../apps/backend/routes/ses-events.route';

function makeApp() {
  const app = express();
  app.use(express.json()); // matches prod: global json parser shouldn't touch text/plain bodies
  app.use('/internal/ses-events', ses_events_route);
  return app;
}

const SNS_TEXT_HEADER = { 'Content-Type': 'text/plain; charset=UTF-8' };

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockReset();
  mockParseSesEvent.mockReset();
  mockEmitSesEventSpan.mockReset();
  mockConfirmSubscription.mockReset();
  mockSentryCaptureException.mockReset();
  mockSentryCaptureMessage.mockReset();
});

describe('POST /internal/ses-events', () => {
  it('confirms an SNS SubscriptionConfirmation and returns 200', async () => {
    mockValidate.mockResolvedValueOnce({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sc-1',
      TopicArn: 'arn:test',
      Timestamp: '2026-05-24T10:00:00Z',
      Message: '',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&...',
    } as never);
    mockConfirmSubscription.mockResolvedValueOnce(undefined as never);

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'SubscriptionConfirmation' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, confirmed: true });
    expect(mockConfirmSubscription).toHaveBeenCalledTimes(1);
    expect(mockEmitSesEventSpan).not.toHaveBeenCalled();
  });

  it('processes a Notification and emits a span', async () => {
    mockValidate.mockResolvedValueOnce({
      Type: 'Notification',
      MessageId: 'n-1',
      TopicArn: 'arn:test',
      Timestamp: '2026-05-24T10:00:00Z',
      Message: JSON.stringify({ eventType: 'Send', mail: {} }),
    } as never);
    mockParseSesEvent.mockReturnValueOnce({
      kind: 'Send',
      messageId: 'mid',
      sendTimestamp: new Date(),
      recipients: ['user@example.com'],
    });

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'Notification' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockEmitSesEventSpan).toHaveBeenCalledTimes(1);
    expect(mockConfirmSubscription).not.toHaveBeenCalled();
  });

  it('returns 400 + captures Sentry when signature validation fails', async () => {
    mockValidate.mockRejectedValueOnce(new Error('invalid signature') as never);

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'Notification' }));

    expect(res.status).toBe(400);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ subsystem: 'ses-events', stage: 'validate' }) })
    );
    expect(mockEmitSesEventSpan).not.toHaveBeenCalled();
  });

  it('returns 400 + captures Sentry when the SES payload is unparseable', async () => {
    mockValidate.mockResolvedValueOnce({
      Type: 'Notification',
      MessageId: 'n-2',
      TopicArn: 'arn:test',
      Timestamp: '2026-05-24T10:00:00Z',
      Message: '{not json',
    } as never);

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'Notification' }));

    expect(res.status).toBe(400);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Message is not JSON/),
      expect.objectContaining({ tags: expect.objectContaining({ subsystem: 'ses-events', stage: 'parse' }) })
    );
    expect(mockEmitSesEventSpan).not.toHaveBeenCalled();
  });

  it('still returns 200 if span emission throws (observability never breaks the receive path)', async () => {
    mockValidate.mockResolvedValueOnce({
      Type: 'Notification',
      MessageId: 'n-3',
      TopicArn: 'arn:test',
      Timestamp: '2026-05-24T10:00:00Z',
      Message: JSON.stringify({ eventType: 'Send', mail: {} }),
    } as never);
    mockParseSesEvent.mockReturnValueOnce({ kind: 'Send' });
    mockEmitSesEventSpan.mockImplementationOnce(() => {
      throw new Error('sentry transport blew up');
    });

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'Notification' }));

    expect(res.status).toBe(200);
  });

  it('returns 400 on a SubscriptionConfirmation missing SubscribeURL', async () => {
    mockValidate.mockResolvedValueOnce({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sc-2',
      TopicArn: 'arn:test',
      Timestamp: '2026-05-24T10:00:00Z',
      Message: '',
      SubscribeURL: undefined,
    } as never);

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'SubscriptionConfirmation' }));

    expect(res.status).toBe(400);
    expect(mockConfirmSubscription).not.toHaveBeenCalled();
  });

  it('returns 200 on UnsubscribeConfirmation (operator removed subscription)', async () => {
    mockValidate.mockResolvedValueOnce({
      Type: 'UnsubscribeConfirmation',
      MessageId: 'uc-1',
      TopicArn: 'arn:test',
      Timestamp: '2026-05-24T10:00:00Z',
      Message: '',
    } as never);

    const res = await request(makeApp())
      .post('/internal/ses-events')
      .set(SNS_TEXT_HEADER)
      .send(JSON.stringify({ Type: 'UnsubscribeConfirmation' }));

    expect(res.status).toBe(200);
    expect(mockConfirmSubscription).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await request(makeApp()).post('/internal/ses-events').set(SNS_TEXT_HEADER).send('this is not json');

    expect(res.status).toBe(400);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});
