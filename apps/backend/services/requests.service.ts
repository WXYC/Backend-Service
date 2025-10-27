type SlackRequestStatus = {
  success: boolean;
  message: string;
};

export const slackSongRequest = async (message: string): Promise<SlackRequestStatus> => {
  // Use mock service in test environments or when explicitly configured
  if (process.env.USE_MOCK_SERVICES == 'true') {
    // some mock response
    return { success: true, message: 'Message sent to Slack successfully' };
  }

  const slackMessage = {
    text: message,
  };

  const webhook = process.env.SLACK_WXYC_REQUESTS_WEBHOOK;

  if (!webhook) {
    throw new Error('Failed to load Slack webhook');
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(slackMessage),
    // Add timeout using AbortController
    signal: AbortSignal.timeout(10000), // 10 second timeout
  });

  if (response.ok) {
    return { success: true, message: 'Message sent to Slack successfully' };
  } else {
    const errorData = await response.text();
    throw new Error(errorData);
  }
};
