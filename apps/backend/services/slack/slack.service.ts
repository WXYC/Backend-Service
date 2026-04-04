/**
 * Slack webhook service.
 *
 * Supports text messages and rich block layouts. When SLACK_WEBHOOK_URL is set
 * (e.g., pointing at a mock server in CI), uses fetch() with that base URL.
 * Otherwise falls back to https.request against hooks.slack.com.
 */

import https from 'https';
import { SlackBlock } from './builder.js';

const SLACK_TIMEOUT_MS = 10_000;

/**
 * Get the SLACK_WEBHOOK_URL override if it's valid (starts with http).
 * Returns null if unset or malformed, causing fallback to https.request.
 */
function getWebhookUrlOverride(): string | null {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (url && url.startsWith('http')) return url;
  return null;
}

const getSlackConfig = () => ({
  hostname: 'hooks.slack.com',
  port: 443,
  path: process.env.SLACK_WXYC_REQUESTS_WEBHOOK || '',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface SlackPostResult {
  success: boolean;
  message?: string;
  statusCode?: number;
  response?: string;
}

/**
 * Post a simple text message to Slack.
 */
export async function postTextToSlack(message: string): Promise<SlackPostResult> {
  return postToSlack({ text: message });
}

/**
 * Post blocks to Slack webhook.
 *
 * @param blocks - Slack block array
 * @param fallbackText - Optional fallback text for notifications
 */
export async function postBlocksToSlack(blocks: SlackBlock[], fallbackText?: string): Promise<SlackPostResult> {
  const payload: { blocks: SlackBlock[]; text?: string } = { blocks };

  // Add fallback text for notifications (shown in push notifications, etc.)
  if (fallbackText) {
    payload.text = fallbackText;
  }

  return postToSlack(payload);
}

/**
 * Post payload to Slack webhook.
 */
async function postToSlack(payload: object): Promise<SlackPostResult> {
  // Use mock in test environments
  if (process.env.USE_MOCK_SERVICES === 'true') {
    // Allow simulating Slack failures in test mode
    if (process.env.SIMULATE_SLACK_FAILURE === 'true') {
      console.log('[Slack Service] Mock mode - simulating Slack failure');
      return { success: false, statusCode: 500, response: 'Mock: Simulated Slack failure' };
    }
    console.log('[Slack Service] Mock mode - would send to Slack:', JSON.stringify(payload).slice(0, 200));
    return { success: true, message: 'Mock: Message sent to Slack successfully' };
  }

  const webhookPath = process.env.SLACK_WXYC_REQUESTS_WEBHOOK;
  if (!webhookPath) {
    console.error('[Slack Service] SLACK_WXYC_REQUESTS_WEBHOOK not configured');
    return { success: false, message: 'Slack webhook not configured' };
  }

  // Use fetch() when SLACK_WEBHOOK_URL is set (e.g., mock server in CI)
  const baseUrl = getWebhookUrlOverride();
  if (baseUrl) {
    return postViaFetch(baseUrl + webhookPath, payload);
  }

  return postViaHttps(payload);
}

/**
 * Post via fetch() — used when SLACK_WEBHOOK_URL override is active.
 */
async function postViaFetch(url: string, payload: object): Promise<SlackPostResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    if (response.ok) {
      return { success: true, message: 'Message sent to Slack successfully' };
    }
    return { success: false, statusCode: response.status, response: text };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Post via https.request — production path to hooks.slack.com.
 */
function postViaHttps(payload: object): Promise<SlackPostResult> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);

    const req = https.request(getSlackConfig(), (res) => {
      let data = '';

      res.on('data', (chunk: string) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, message: 'Message sent to Slack successfully' });
        } else {
          resolve({ success: false, statusCode: res.statusCode, response: data });
        }
      });
    });

    req.on('error', (e: Error) => {
      console.error('[Slack Service] Error sending message to Slack:', e);
      reject(e);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Slack request timeout'));
    });

    req.setTimeout(SLACK_TIMEOUT_MS);
    req.write(postData);
    req.end();
  });
}

/**
 * Check if Slack is configured.
 */
export function isSlackConfigured(): boolean {
  if (process.env.USE_MOCK_SERVICES === 'true') return false;
  return !!(process.env.SLACK_WXYC_REQUESTS_WEBHOOK || getWebhookUrlOverride());
}
