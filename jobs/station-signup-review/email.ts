/**
 * Self-contained SES sender for the station-signup-review digest.
 *
 * Mirrors `jobs/metadata-no-match-digest/email.ts` verbatim (which itself
 * mirrors ONLY `shared/authentication/src/email.ts`'s SES client setup) --
 * deliberately does NOT import `@wxyc/authentication`, for the same reason:
 * this read-mostly cron doesn't need better-auth in its image, and that
 * module's `sendEmail` takes a closed template union with no subject/html
 * pass-through a one-off digest shape would need to edit.
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
 * Configuration set passed on every `SendEmailCommand`, when configured. See
 * `shared/authentication/src/email.ts`'s `getConfigurationSetName` for the
 * full identity-precedence rationale (BS#1070).
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

const DEFAULT_STATION_SIGNUP_RECIPIENT = 'jake@wxyc.org';

/**
 * `STATION_SIGNUP_ALERT_EMAIL`, defaulting to `jake@wxyc.org`. See
 * docs/env-vars.md. Deliberately meant to be pointed at a station alias
 * rather than a personal inbox -- this feature exists for weeks when
 * individuals are away (see the issue's "Recipient" section).
 */
export const resolveStationSignupRecipient = (): string =>
  process.env.STATION_SIGNUP_ALERT_EMAIL?.trim() || DEFAULT_STATION_SIGNUP_RECIPIENT;

export interface DigestEmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Send the digest to `to`. Returns `true` when an email was actually
 * dispatched, `false` when sending is disabled (`EMAIL_ENABLED=false`) --
 * the caller (`orchestrate.ts`) logs a dry-run preview on `false`. Throws on
 * missing `SES_FROM_EMAIL` config or an SES send failure.
 */
export async function sendStationSignupDigestEmail(to: string, content: DigestEmailContent): Promise<boolean> {
  // Gate first: a disabled dry run is a clean no-op that must not require any
  // SES configuration to be present.
  if (!isEmailSendingEnabled()) {
    return false;
  }

  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing AWS SES configuration: SES_FROM_EMAIL');
  }

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: content.subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: content.text, Charset: 'UTF-8' },
        Html: { Data: content.html, Charset: 'UTF-8' },
      },
    },
    ConfigurationSetName: getConfigurationSetName(),
  });

  const client = getSesClient();
  await client.send(command);
  return true;
}
