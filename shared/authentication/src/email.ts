import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

let sesClient: SESClient | null = null;

const getSesClient = () => {
  if (sesClient) {
    return sesClient;
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;

  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error(
      'Missing AWS SES configuration: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION'
    );
  }

  sesClient = new SESClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  return sesClient;
};

type ResetEmailInput = {
  to: string;
  resetUrl: string;
};

export const sendResetPasswordEmail = async ({
  to,
  resetUrl,
}: ResetEmailInput) => {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing AWS SES configuration: SES_FROM_EMAIL');
  }

  const subject = 'Reset your password';
  const textBody = `Click the link to reset your password: ${resetUrl}`;
  const htmlBody = `
    <p>Click the link below to reset your password:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
  `.trim();

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: textBody },
        Html: { Data: htmlBody },
      },
    },
  });

  const client = getSesClient();
  await client.send(command);
};
