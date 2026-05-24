// eslint-disable-next-line @typescript-eslint/no-require-imports
const MessageValidator = require('sns-validator') as new () => {
  validate: (
    message: Record<string, unknown>,
    callback: (err: Error | null, message: Record<string, unknown>) => void
  ) => void;
};

/**
 * Shape of a validated SNS HTTP/HTTPS message. SNS sends three kinds:
 * `SubscriptionConfirmation` (one-time, on subscription create),
 * `UnsubscribeConfirmation` (on subscription delete), and `Notification`
 * (for every event). Only `Notification` carries a `Message` we need to
 * parse downstream.
 */
export interface ValidatedSnsMessage {
  Type: 'SubscriptionConfirmation' | 'UnsubscribeConfirmation' | 'Notification';
  MessageId: string;
  TopicArn: string;
  Timestamp: string;
  Message: string;
  SubscribeURL?: string;
}

const validator = new MessageValidator();

/**
 * Validate the X-509 signature on a raw SNS message body, then check the
 * `TopicArn` matches the configured topic. Resolves to the typed message
 * on success; rejects on signature mismatch, expired cert, missing fields,
 * or wrong topic.
 *
 * The expected topic ARN is read from `SES_EVENTS_SNS_TOPIC_ARN` at call
 * time so test setups can override `process.env` between cases. Throws
 * with a stable error string if the env var is unset — the route layer
 * surfaces this to Sentry rather than crashing on boot, so a missing env
 * var is observable, not silent.
 */
export async function validateSnsMessage(payload: unknown): Promise<ValidatedSnsMessage> {
  const expectedTopicArn = process.env['SES_EVENTS_SNS_TOPIC_ARN'];
  if (!expectedTopicArn) {
    throw new Error('SES_EVENTS_SNS_TOPIC_ARN is not set');
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new Error('SNS payload is not an object');
  }

  const validated = await new Promise<Record<string, unknown>>((resolve, reject) => {
    validator.validate(payload as Record<string, unknown>, (err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  const topicArn = validated['TopicArn'];
  if (typeof topicArn !== 'string' || topicArn !== expectedTopicArn) {
    throw new Error('SNS message TopicArn does not match SES_EVENTS_SNS_TOPIC_ARN');
  }

  const type = validated['Type'];
  if (type !== 'SubscriptionConfirmation' && type !== 'UnsubscribeConfirmation' && type !== 'Notification') {
    throw new Error(`Unexpected SNS message Type: ${String(type)}`);
  }

  return {
    Type: type,
    MessageId: String(validated['MessageId'] ?? ''),
    TopicArn: topicArn,
    Timestamp: String(validated['Timestamp'] ?? ''),
    Message: String(validated['Message'] ?? ''),
    SubscribeURL: typeof validated['SubscribeURL'] === 'string' ? (validated['SubscribeURL']) : undefined,
  };
}
