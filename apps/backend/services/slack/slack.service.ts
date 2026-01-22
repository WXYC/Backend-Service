/**
 * Enhanced Slack service with block support.
 *
 * Extends the existing requestLine.service.ts functionality
 * to support rich block messages.
 */

import https from 'https';
import { SlackBlock } from './builder.js';

const SLACK_TIMEOUT_MS = 10_000;

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
export async function postBlocksToSlack(
  blocks: SlackBlock[],
  fallbackText?: string
): Promise<SlackPostResult> {
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

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);

    const req = https.request(getSlackConfig(), (res) => {
      let data = '';

      res.on('data', (chunk) => {
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

    req.on('error', (e) => {
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
  return !!(
    process.env.SLACK_WXYC_REQUESTS_WEBHOOK &&
    process.env.USE_MOCK_SERVICES !== 'true'
  );
}
