/**
 * Shared S3 signing core: presigns with the EC2 instance role, no stored key
 * (BS#3462; shared by the review store, BS#3268, and the poster store, BS#3463).
 *
 * Credentials come from `fromInstanceMetadata()`, never the default chain, and
 * are resolved here and handed to the S3 client as a plain object. The four
 * reserved `AWS_*` names (docs/env-vars.md) therefore cannot change which
 * credentials sign (BS#2518). Off-EC2 tiers inject `credentialProvider`.
 *
 * TR-X-15: a SigV4 presigned URL dies when its signing credentials expire,
 * whatever `X-Amz-Expires` says, and instance-role credentials rotate. So a
 * link of lifetime T needs credentials with T + 5 minutes left; failing that
 * we refetch (at most once a minute), and failing that we shorten the link to
 * end one minute before the credentials do.
 *
 * `send` runs server-side commands on the same client and refresh rule, and `credentials()` hands the same
 * cached identity to a sibling client (CloudFront) as a provider, so no second client resolves its own chain.
 * Concurrent fetches share one in-flight promise; a failed fetch is not retried for a few seconds.
 *
 * Never logs a URL, a bucket/key pair, or a credential.
 */
import { S3Client, type GetObjectCommand, type PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity } from '@aws-sdk/types';

// Same IMDS budget as `createCloudWatchClient` (shared/observability/src/metrics.ts).
const IMDS_TIMEOUT_MS = 1_000;
const IMDS_MAX_RETRIES = 0;

const HEADROOM_MS = 5 * 60_000;
const END_BEFORE_EXPIRY_MS = 60_000;
export const SIGNING_REFRESH_INTERVAL_MS = 60_000;
export const CREDENTIAL_FAILURE_BACKOFF_MS = 5_000;

type PresignableCommand = GetObjectCommand | PutObjectCommand;

export interface InstanceRoleSignerOptions {
  region?: string;
  credentialProvider?: () => Promise<AwsCredentialIdentity>;
  /** Clock in epoch ms; injectable for tests. */
  now?: () => number;
}

export interface InstanceRoleSigner {
  /** Presigns `command` for at most `expiresInSeconds`, shortened to end before the credentials do. */
  presign(command: PresignableCommand, expiresInSeconds: number): Promise<string>;
  /** Sends a server-side command on the resolved instance-role credentials. */
  send: S3Client['send'];
  /** The cached instance-role credentials, refreshed by the same rule; for `new CloudFrontClient({ credentials })`. */
  credentials(): Promise<AwsCredentialIdentity>;
}

export function createInstanceRoleSigner(options: InstanceRoleSignerOptions = {}): InstanceRoleSigner {
  const region = options.region ?? 'us-east-1';
  const now = options.now ?? Date.now;
  const provider =
    options.credentialProvider ?? fromInstanceMetadata({ timeout: IMDS_TIMEOUT_MS, maxRetries: IMDS_MAX_RETRIES });

  let cached: { credentials: AwsCredentialIdentity; fetchedAt: number; client: S3Client } | undefined;

  // The SDK's static-stability fallback rewrites `expiration` to now + 5-10 min after a failed refresh and
  // keeps the real value in `originalExpiration`; a link must never outlive the real one.
  const msLeft = (credentials: AwsCredentialIdentity): number => {
    const expiry = (credentials as { originalExpiration?: Date }).originalExpiration ?? credentials.expiration;
    return expiry ? expiry.getTime() - now() : Infinity;
  };

  let inFlight: Promise<void> | undefined;
  let lastFailure: { error: Error; at: number } | undefined;

  function fetchCredentials(): Promise<void> {
    if (inFlight) {
      return inFlight;
    }
    if (lastFailure && now() - lastFailure.at < CREDENTIAL_FAILURE_BACKOFF_MS) {
      return Promise.reject(lastFailure.error);
    }
    inFlight = Promise.resolve()
      .then(() => provider())
      .then(
        (credentials) => {
          // The client gets the resolved object, so it never consults the default chain.
          cached = { credentials, fetchedAt: now(), client: new S3Client({ region, credentials }) };
          lastFailure = undefined;
        },
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          lastFailure = { error: failure, at: now() };
          throw failure;
        }
      )
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  async function ensureCredentials(requiredMs: number): Promise<void> {
    if (!cached) {
      await fetchCredentials();
    } else if (msLeft(cached.credentials) < requiredMs && now() - cached.fetchedAt >= SIGNING_REFRESH_INTERVAL_MS) {
      await fetchCredentials();
    }
  }

  return {
    async presign(command, expiresInSeconds) {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
        throw new Error('expiresInSeconds must be a positive integer');
      }
      await ensureCredentials(expiresInSeconds * 1000 + HEADROOM_MS);
      const usableMs = msLeft(cached!.credentials) - END_BEFORE_EXPIRY_MS;
      const expiresIn = Math.min(expiresInSeconds, Math.floor(usableMs / 1000));
      if (expiresIn < 1) {
        throw new Error('Instance-role credentials are too close to expiry to sign a link');
      }
      return getSignedUrl(cached!.client, command, { expiresIn });
    },
    send: (async (command: Parameters<S3Client['send']>[0]) => {
      await ensureCredentials(HEADROOM_MS);
      return cached!.client.send(command);
    }) as S3Client['send'],
    async credentials() {
      await ensureCredentials(HEADROOM_MS);
      return cached!.credentials;
    },
  };
}
