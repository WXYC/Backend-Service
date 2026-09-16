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

/**
 * Prefers `SES_*` over the legacy `AWS_*`, never mixing halves. See
 * `shared/authentication/src/email.ts`'s `resolveSesCredentials` for why these
 * keys must not travel under the AWS SDK's reserved global names: under those
 * names a single-purpose SES credential shadows the instance role for the whole
 * process, which is what left every CloudWatch metric dark for 105 days
 * (BS#2518). This job has a self-contained sender by design, so the helper is
 * duplicated rather than imported, as `getConfigurationSetName` already is.
 */
const resolveSesCredentials = (): { accessKeyId: string; secretAccessKey: string } | null => {
  const sesAccessKeyId = process.env.SES_ACCESS_KEY_ID;
  const sesSecretAccessKey = process.env.SES_SECRET_ACCESS_KEY;
  if (sesAccessKeyId && sesSecretAccessKey) {
    return { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey };
  }

  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (awsAccessKeyId && awsSecretAccessKey) {
    return { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey };
  }

  return null;
};

const getSesClient = (): SESClient => {
  if (sesClient) return sesClient;

  const credentials = resolveSesCredentials();
  const region = process.env.AWS_REGION;
  if (!credentials || !region) {
    throw new Error(
      'Missing SES configuration: SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, AWS_REGION ' +
        '(legacy AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are still accepted — see BS#2518)'
    );
  }

  sesClient = new SESClient({ region, credentials });
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

export const DEFAULT_STATION_SIGNUP_RECIPIENT = 'jake@wxyc.org';

export interface StationSignupRecipient {
  address: string;
  /** `true` when `STATION_SIGNUP_ALERT_EMAIL` was unset/blank and the built-in default is carrying the digest. */
  usedFallback: boolean;
}

/**
 * `STATION_SIGNUP_ALERT_EMAIL`, defaulting to `jake@wxyc.org`. See
 * docs/env-vars.md. Deliberately meant to be pointed at a station alias
 * rather than a personal inbox -- this feature exists for weeks when
 * individuals are away (see the issue's "Recipient" section).
 *
 * **Falls back rather than failing loudly, and says so.** Hard-failing on an
 * unset variable would kill the safety-net digest during exactly the weeks
 * nobody is watching, which is the one thing this feature exists to prevent
 * (the epic's availability-over-secrecy constraint). But a silent fallback
 * quietly becomes the permanent configuration, so the caller announces it
 * twice: a `warn` log line, and a line in the digest body itself
 * (`format.ts`'s `RECIPIENT_FALLBACK_NOTICE`), where a human will actually
 * read it.
 */
export const resolveStationSignupRecipient = (): StationSignupRecipient => {
  const configured = process.env.STATION_SIGNUP_ALERT_EMAIL?.trim();
  return configured
    ? { address: configured, usedFallback: false }
    : { address: DEFAULT_STATION_SIGNUP_RECIPIENT, usedFallback: true };
};

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
