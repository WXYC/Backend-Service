/**
 * Complete an SNS HTTP/HTTPS subscription handshake by GETting the
 * `SubscribeURL` that AWS delivers in the one-time `SubscriptionConfirmation`
 * message. AWS expects a 2xx; we treat 3xx as failure (no redirect chasing).
 *
 * Errors propagate so the caller can attribute them to Sentry. The route
 * still 5xx's on confirmation failure: AWS will retry the message a handful
 * of times, so a transient downstream blip is recoverable without operator
 * intervention.
 */
export async function confirmSubscription(subscribeUrl: string): Promise<void> {
  const url = new URL(subscribeUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`SubscribeURL is not https: ${url.protocol}`);
  }
  if (!url.hostname.endsWith('.amazonaws.com')) {
    throw new Error(`SubscribeURL hostname is not under amazonaws.com: ${url.hostname}`);
  }

  const res = await fetch(url, { method: 'GET', redirect: 'manual' });
  if (!res.ok) {
    throw new Error(`SubscribeURL GET returned ${res.status}`);
  }
}
