/**
 * The AWS SDK names that sit ABOVE the EC2 instance role in the default
 * credential chain, so setting any of them silently re-points the identity
 * every SDK client in the process authenticates as.
 *
 * All four, not just the pair BS#2518 involved, and deliberately the same four
 * `.github/workflows/set-ec2-env-var.yml` refuses to write to the host. The two
 * guards are a pair: that one blocks the sanctioned write path, this one
 * catches every other way a variable reaches the process (a hand-edited
 * `~/.env`, a `docker run -e`, an inherited base image, a CI runner's ambient
 * environment). If the two lists diverge, the divergence is itself a defect —
 * an operator who has been told four names are forbidden would read silence
 * about three of them as permission.
 *
 * `AWS_SESSION_TOKEN` alone does not satisfy the SDK's env-credential provider,
 * which needs the id/secret pair, and `AWS_PROFILE` only redirects the chain
 * when a shared config file exists to redirect it to. Neither is ever correct
 * on a WXYC host regardless, and both mean someone exported a credential set
 * into a process that is supposed to run as its instance role — which is the
 * thing worth saying out loud, not the exact mechanics of how far it got.
 *
 * `AWS_REGION` is deliberately absent: it selects an endpoint, not a principal,
 * production is SUPPOSED to set it, and flagging it would teach operators to
 * ignore this warning.
 */
const RESERVED_CREDENTIAL_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
] as const;

/**
 * Warn-once latch. The bootstrap call site reaches this function exactly once
 * per process, so the latch is not load-bearing THERE — it is what makes the
 * function safe to call from anywhere else (a per-send resolver, a per-request
 * middleware) without turning one misconfiguration into a log flood. A flooded
 * log gets read about as carefully as a silent one, and silence is what let
 * BS#2518 run for 105 days.
 */
let warnedReserved = false;

/**
 * Warns, at most once per process, when an AWS SDK reserved credential name is
 * present in the environment.
 *
 * PRESENCE is the hazard, independent of what any module reads. Anything set
 * under these names tops the AWS SDK's default credential chain for the whole
 * process, so a single-purpose credential becomes the identity for every SDK
 * call that does not pass credentials explicitly. In production the SES-only
 * `no-reply-sender` key sat under `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
 * and shadowed the `wxyc-ec2-backend` instance role: `cloudwatch:PutMetricData`
 * failed `AccessDenied` for 105 days and the `WXYC/BackendService` namespace
 * never came into existence, while the only alarm watching it read OK the whole
 * time on `TreatMissingData: notBreaching`. See BS#2518.
 *
 * Call it from the process's Sentry preload (`instrument.ts`, `node --import`),
 * NOT from whichever module happens to consume AWS. That placement is the whole
 * point of BS#2532: the detector previously lived in the three SES senders,
 * which inverted its coverage — `apps/backend` holds two of the repo's three
 * `CloudWatchClient` constructions and sends no email, so the container the
 * shadowing actually silences was the one container that never ran the check,
 * while the containers that did ran it lazily on first send and not at all
 * under `EMAIL_ENABLED=false`.
 *
 * Reads `process.env` directly and imports nothing. That is a constraint, not
 * an accident: the `@wxyc/observability` barrel is loaded eagerly at preload in
 * every image, so reaching for an AWS SDK here to "resolve the identity
 * properly" would charge every process a credential-provider import at boot to
 * diagnose a misconfiguration almost no process has. The bare env read is
 * strictly more reliable anyway — it reports the hazard even when the SDK would
 * have resolved the shadowed credential successfully.
 */
export const warnIfReservedAwsCredentialsPresent = (): void => {
  if (warnedReserved) {
    return;
  }

  const present = RESERVED_CREDENTIAL_ENV_VARS.filter((name) => process.env[name]);
  if (present.length === 0) {
    return;
  }

  warnedReserved = true;
  console.warn(
    `[observability] ${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set. ` +
      'That shadows the EC2 instance role for every AWS SDK call in this process that does not ' +
      'pass explicit credentials, so CloudWatch publishing fails AccessDenied while the process ' +
      'otherwise looks healthy. Unset it on the host; the SES credential belongs in ' +
      'SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY, which nothing else in the chain reads (see BS#2518).'
  );
};
