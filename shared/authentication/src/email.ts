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
    throw new Error('Missing AWS SES configuration: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
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

type VerificationEmailInput = {
  to: string;
  verificationUrl: string;
};

type EmailTemplateInput = {
  title: string;
  intro: string;
  actionText: string;
  actionUrl: string;
  footer?: string;
};

const buildEmailHtml = ({ title, intro, actionText, actionUrl, footer }: EmailTemplateInput) =>
  `
  <div style="background-color:#0b0a10;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#fce7f3;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#14101a;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:24px 28px;border-bottom:1px solid #2a2033;">
          <div style="min-height:48px;display:flex;align-items:center;justify-content:center;">
            <img
              src="https://wxyc.org/_next/static/media/logo.cecf836c.png"
              alt="WXYC"
              width="180"
              style="display:block;border:0;outline:none;text-decoration:none;height:auto;"
            />
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:28px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#fdf2f8;">${title}</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#f9a8d4;">
            ${intro}
          </p>
          <a href="${actionUrl}" style="display:inline-block;padding:12px 20px;background:#ec4899;color:#1a0b14;text-decoration:none;border-radius:8px;font-weight:600;">
            ${actionText}
          </a>
          <p style="margin:18px 0 0;font-size:12px;color:#f472b6;word-break:break-all;">
            Or copy and paste this link into your browser: ${actionUrl}
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 28px;background:#0d0a12;color:#f9a8d4;font-size:12px;line-height:1.5;">
          ${footer || 'If you did not request this email, you can safely ignore it.'}
        </td>
      </tr>
    </table>
  </div>
`.trim();

export const sendResetPasswordEmail = async ({ to, resetUrl }: ResetEmailInput) => {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing AWS SES configuration: SES_FROM_EMAIL');
  }

  const subject = 'Reset your password';
  const textBody = `Click the link to reset your password: ${resetUrl}`;
  const htmlBody = buildEmailHtml({
    title: 'Reset your password',
    intro: 'We received a request to reset your password. Use the button below to continue.',
    actionText: 'Reset password',
    actionUrl: resetUrl,
  });

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

export const sendVerificationEmailMessage = async ({ to, verificationUrl }: VerificationEmailInput) => {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing AWS SES configuration: SES_FROM_EMAIL');
  }

  const subject = 'Welcome to ' + process.env.DEFAULT_ORG_NAME + '! Verify your email address';
  const textBody = `Click the link to verify your email: ${verificationUrl}`;
  const htmlBody = buildEmailHtml({
    title: 'Verify your email address',
    intro: `Welcome to ${process.env.DEFAULT_ORG_NAME}! Please verify your email address to activate your account.`,
    actionText: 'Verify email',
    actionUrl: verificationUrl,
  });

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
