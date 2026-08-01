/**
 * Self-contained SES sender for the digest email.
 *
 * Mirrors ONLY `shared/authentication/src/email.ts`'s SES client setup
 * (`getSesClient`, `isEmailSendingEnabled`, config-set handling) --
 * deliberately does NOT import `@wxyc/authentication`, which drags
 * better-auth into this cron's image for no reason a read-only digest job
 * needs. That module's `sendEmail` also takes a closed `WXYCEmail` union
 * rendered through an exhaustive template switch with no subject/html
 * pass-through, so reusing it would mean editing that union and its
 * renderer for a one-off digest shape. See the plan's "Email delivery"
 * section for the full rationale.
 *
 * `EMAIL_ENABLED=false` (or unset in the unit-test setup, see
 * `tests/setup/unit.setup.ts`) short-circuits before any SES client is
 * constructed or `send()` is called -- tests never make a live SES call.
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

let sesClient: SESClient | null = null;

const getSesClient = (): SESClient => {
  if (sesClient) return sesClient;

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('Missing AWS SES configuration: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
  }

  sesClient = new SESClient({ region, credentials: { accessKeyId, secretAccessKey } });
  return sesClient;
};

/**
 * Configuration set passed on every `SendEmailCommand`, when configured.
 * See `shared/authentication/src/email.ts`'s `getConfigurationSetName` for
 * the full identity-precedence rationale (BS#1070) -- belt-and-suspenders
 * so a future email-level identity for `SES_FROM_EMAIL` can't silently
 * drop this job's sends from the EventDestination.
 */
const getConfigurationSetName = (): string | undefined => {
  const name = process.env.SES_CONFIGURATION_SET_NAME?.trim();
  return name && name.length > 0 ? name : undefined;
};

/**
 * SES has a 200-message/month quota shared with the auth service. Gates the
 * actual `SESClient.send()` call so test/CI runs never burn it. Defaults to
 * enabled (production behavior) when unset; `tests/setup/unit.setup.ts`
 * defaults `EMAIL_ENABLED=false` for the whole unit suite.
 */
export function isEmailSendingEnabled(): boolean {
  const raw = process.env.EMAIL_ENABLED;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0';
}

const DEFAULT_DIGEST_RECIPIENT = 'jake@wxyc.org';

/** `DIGEST_RECIPIENT_EMAIL`, defaulting to `jake@wxyc.org`. See docs/env-vars.md. */
export const resolveDigestRecipient = (): string =>
  process.env.DIGEST_RECIPIENT_EMAIL?.trim() || DEFAULT_DIGEST_RECIPIENT;

export interface DigestEmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Send the digest to `to`. Throws on missing `SES_FROM_EMAIL` config or an SES send failure -- the caller (`job.ts`) uses that to decide not to advance the watermark. */
export async function sendDigestEmail(to: string, content: DigestEmailContent): Promise<void> {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing AWS SES configuration: SES_FROM_EMAIL');
  }

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: content.subject },
      Body: {
        Text: { Data: content.text },
        Html: { Data: content.html },
      },
    },
    ConfigurationSetName: getConfigurationSetName(),
  });

  if (!isEmailSendingEnabled()) {
    return;
  }

  const client = getSesClient();
  await client.send(command);
}
