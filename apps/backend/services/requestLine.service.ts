import https from 'https';

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

export const submitRequestLine = async (
  message: string
): Promise<{ success: boolean; message?: string; statusCode?: number; response?: string }> => {
  // Use mock in test environments
  if (process.env.USE_MOCK_SERVICES === 'true') {
    console.log('[RequestLine Service] Mock mode - would send to Slack:', message);
    return { success: true, message: 'Mock: Message sent to Slack successfully' };
  }

  const webhookPath = process.env.SLACK_WXYC_REQUESTS_WEBHOOK;
  if (!webhookPath) {
    console.error('[RequestLine Service] SLACK_WXYC_REQUESTS_WEBHOOK not configured');
    return { success: false, message: 'Slack webhook not configured' };
  }

  return new Promise((resolve, reject) => {
    const slackMessage = { text: message };
    const postData = JSON.stringify(slackMessage);

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
      console.error('[RequestLine Service] Error sending message to Slack:', e);
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
};
