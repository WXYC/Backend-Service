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

/**
 * Prefers `SES_*` over the legacy `AWS_*`, never mixing halves. See
 * `shared/authentication/src/email.ts`'s `resolveSesCredentials` for why these
 * keys must not travel under the AWS SDK's reserved global names: under those
 * names a single-purpose SES credential shadows the instance role for the whole
 * process, which is what left every CloudWatch metric dark for 105 days
 * (BS#2518). This job has a self-contained sender by design, so the helper is
 * duplicated rather than imported, as `getConfigurationSetName` already is.
 */
/**
 * The legacy spelling being PRESENT is the hazard, not merely being used: while
 * `AWS_ACCESS_KEY_ID` is set, it tops the default credential chain for the whole
 * process regardless of which pair this module reads. Warn once so the residual
 * unsafe state is observable — an unobservable one is exactly what let BS#2518
 * run dark for 105 days — and so BS#2518 has a signal for when the fallback is
 * safe to delete rather than an operator's memory.
 */
let warnedLegacyAwsCredentials = false;
const warnIfLegacyCredentialsPresent = (): void => {
  if (warnedLegacyAwsCredentials || !process.env.AWS_ACCESS_KEY_ID) {
    return;
  }
  warnedLegacyAwsCredentials = true;
  console.warn(
    '[email] AWS_ACCESS_KEY_ID is set. It shadows the EC2 instance role for every ' +
      'AWS SDK call in this process that does not pass explicit credentials. Move the ' +
      'SES credential to SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY (see BS#2518).'
  );
};

const resolveSesCredentials = (): { accessKeyId: string; secretAccessKey: string } | null => {
  warnIfLegacyCredentialsPresent();

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

/**
 * Send the digest to `to`. Returns `true` when an email was actually
 * dispatched, `false` when sending is disabled (`EMAIL_ENABLED=false`) and
 * the call was a no-op -- the caller (`job.ts`) logs a dry-run preview on
 * `false` and deliberately does NOT advance the watermark, so a real
 * (enabled) run still sees the misses. Throws on missing `SES_FROM_EMAIL`
 * config or an SES send failure, which the caller uses to leave the
 * watermark unadvanced so the next run retries the window.
 *
 * `Charset: 'UTF-8'` is set on every `Content` -- the subject always carries
 * an em-dash (U+2014) and bodies routinely carry an ellipsis and diacritic
 * artist names; without it SES defaults the MIME part to us-ascii and
 * clients render mojibake.
 */
export async function sendDigestEmail(to: string, content: DigestEmailContent): Promise<boolean> {
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
