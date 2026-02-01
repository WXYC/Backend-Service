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

type EmailTemplateInput = {
  subject: string;
  title: string;
  intro: string;
  actionText: string;
  actionUrl: string;
  footer?: string;
};

// Discriminated union for all transactional emails
export type WXYCEmail =
  | { type: 'passwordReset'; to: string; url: string }
  | { type: 'emailVerification'; to: string; url: string }
  | { type: 'accountSetup'; to: string; url: string };

/**
 * Content factory for each email type
 */
function getEmailContent(
  type: WXYCEmail['type'],
  url: string,
  orgName: string
): EmailTemplateInput {
  switch (type) {
    case 'passwordReset':
      return {
        subject: 'Reset your password',
        title: 'Reset your password',
        intro:
          'We received a request to reset your password. Use the button below to continue.',
        actionText: 'Reset password',
        actionUrl: url,
      };

    case 'emailVerification':
      return {
        subject: `Welcome to ${orgName}! Verify your email address`,
        title: 'Verify your email address',
        intro: `Welcome to ${orgName}! Please verify your email address to activate your account.`,
        actionText: 'Verify email',
        actionUrl: url,
      };

    case 'accountSetup':
      return {
        subject: `Welcome to ${orgName}! Set up your password`,
        title: 'Welcome! Set up your account',
        intro: `You've been added to ${orgName}. Click below to set your password and get started.`,
        actionText: 'Set up password',
        actionUrl: url,
        footer: `You're receiving this because an administrator added you to ${orgName}. If you didn't expect this, please contact your station manager.`,
      };
  }
}

const buildEmailHtml = ({
  title,
  intro,
  actionText,
  actionUrl,
  footer,
}: Omit<EmailTemplateInput, 'subject'>) => `
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

/**
 * Send a transactional email using the unified email system
 */
export async function sendEmail(email: WXYCEmail): Promise<void> {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing AWS SES configuration: SES_FROM_EMAIL');
  }

  const orgName = process.env.DEFAULT_ORG_NAME || 'WXYC';
  const content = getEmailContent(email.type, email.url, orgName);

  const textBody = `${content.intro} ${content.actionUrl}`;
  const htmlBody = buildEmailHtml(content);

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [email.to] },
    Message: {
      Subject: { Data: content.subject },
      Body: {
        Text: { Data: textBody },
        Html: { Data: htmlBody },
      },
    },
  });

  const client = getSesClient();
  await client.send(command);
}

// Backward-compatible wrappers
export const sendResetPasswordEmail = async ({
  to,
  resetUrl,
}: {
  to: string;
  resetUrl: string;
}) => sendEmail({ type: 'passwordReset', to, url: resetUrl });

export const sendVerificationEmailMessage = async ({
  to,
  verificationUrl,
}: {
  to: string;
  verificationUrl: string;
}) => sendEmail({ type: 'emailVerification', to, url: verificationUrl });

export const sendAccountSetupEmail = async ({
  to,
  setupUrl,
}: {
  to: string;
  setupUrl: string;
}) => sendEmail({ type: 'accountSetup', to, url: setupUrl });
