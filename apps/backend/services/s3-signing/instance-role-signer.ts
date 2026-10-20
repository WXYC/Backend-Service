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
}

export function createInstanceRoleSigner(options: InstanceRoleSignerOptions = {}): InstanceRoleSigner {
  const region = options.region ?? 'us-east-1';
  const now = options.now ?? Date.now;
  const provider =
    options.credentialProvider ?? fromInstanceMetadata({ timeout: IMDS_TIMEOUT_MS, maxRetries: IMDS_MAX_RETRIES });

  let cached: { credentials: AwsCredentialIdentity; fetchedAt: number; client: S3Client } | undefined;

  const msLeft = (credentials: AwsCredentialIdentity): number =>
    credentials.expiration ? credentials.expiration.getTime() - now() : Infinity;

  async function fetchCredentials(): Promise<void> {
    const credentials = await provider();
    // The client gets the resolved object, so it never consults the default chain.
    cached = { credentials, fetchedAt: now(), client: new S3Client({ region, credentials }) };
  }

  return {
    async presign(command, expiresInSeconds) {
      if (!cached) {
        await fetchCredentials();
      } else if (msLeft(cached.credentials) < expiresInSeconds * 1000 + HEADROOM_MS) {
        if (now() - cached.fetchedAt >= SIGNING_REFRESH_INTERVAL_MS) {
          await fetchCredentials();
        }
      }
      const usableMs = msLeft(cached!.credentials) - END_BEFORE_EXPIRY_MS;
      const expiresIn = Math.min(expiresInSeconds, Math.floor(usableMs / 1000));
      if (expiresIn < 1) {
        throw new Error('Instance-role credentials are too close to expiry to sign a link');
      }
      return getSignedUrl(cached!.client, command, { expiresIn });
    },
  };
}
