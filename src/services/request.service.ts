import https from 'https';

const SLACK_CONFIG = {
  hostname: 'hooks.slack.com',
  port: 443,
  path: process.env.SLACK_WXYC_REQUESTS_WEBHOOK || '',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  }
};

export const submitSongRequest = async (message: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    const slackMessage = {
      text: `${message}`
    };

    const postData = JSON.stringify(slackMessage);

    const req = https.request(SLACK_CONFIG, (res) => {
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
      console.error('Error sending message to Slack:', e);
      reject(e);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Slack request timeout'));
    });

    // Set timeout to 10 seconds
    req.setTimeout(10000);

    req.write(postData);
    req.end();
  });
};
