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
  // In-flight sends per client; a replaced client is destroyed only once its own sends settle, so a refresh
  // never cuts a request off mid-flight.
  const active = new Map<S3Client, { inFlight: number; retired: boolean }>();

  // The SDK's static-stability fallback rewrites `expiration` to now + 5-10 min after a failed refresh and
  // keeps the real value in `originalExpiration`; a link must never outlive the real one.
  const msLeft = (credentials: AwsCredentialIdentity): number => {
    const expiry = (credentials as { originalExpiration?: Date }).originalExpiration ?? credentials.expiration;
    return expiry ? expiry.getTime() - now() : Infinity;
  };

  let inFlight: Promise<void> | undefined;
  let lastFailure: { error: Error; at: number } | undefined;

  function retire(client: S3Client): void {
    const state = active.get(client);
    if (state && state.inFlight > 0) {
      state.retired = true;
    } else {
      active.delete(client);
      client.destroy();
    }
  }

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
          const replaced = cached?.client;
          cached = { credentials, fetchedAt: now(), client: new S3Client({ region, credentials }) };
          if (replaced) {
            retire(replaced);
          }
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

  // `useStaleOnFailure` (send, credentials) keeps serving the cached identity while it is still valid if the
  // refetch fails; presign keeps its stricter rule and surfaces the failure.
  async function ensureCredentials(requiredMs: number, useStaleOnFailure = false): Promise<void> {
    if (!cached) {
      await fetchCredentials();
    } else if (msLeft(cached.credentials) < requiredMs && now() - cached.fetchedAt >= SIGNING_REFRESH_INTERVAL_MS) {
      try {
        await fetchCredentials();
      } catch (error) {
        if (!useStaleOnFailure || msLeft(cached.credentials) <= 0) {
          throw error;
        }
      }
    }
  }

  // Credentials that are already past expiry are refused rather than sent; a failed fetch replays its own error.
  async function ensureUsable(): Promise<void> {
    await ensureCredentials(HEADROOM_MS, true);
    if (msLeft(cached!.credentials) <= 0) {
      throw new Error('Instance-role credentials have expired');
    }
  }

  async function sendOnClient(args: unknown[]): Promise<unknown> {
    await ensureUsable();
    const client = cached!.client;
    const state = active.get(client) ?? { inFlight: 0, retired: false };
    active.set(client, state);
    state.inFlight += 1;
    try {
      return await (client as { send(...args: unknown[]): unknown }).send(...args);
    } finally {
      state.inFlight -= 1;
      if (state.inFlight === 0 && state.retired) {
        active.delete(client);
        client.destroy();
      }
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
    // Forwards every argument (options, callback form) so the declared overloads hold. In the callback form
    // a failure goes to the callback, as the SDK's own send does, never to an unobserved rejection.
    send: ((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        const callback = last as (...cbArgs: unknown[]) => void;
        sendOnClient(args.slice(0, -1)).then(
          (output) => callback(null, output),
          (error: unknown) => callback(error)
        );
        return undefined;
      }
      return sendOnClient(args);
    }) as S3Client['send'],
    async credentials() {
      await ensureUsable();
      return cached!.credentials;
    },
  };
}
